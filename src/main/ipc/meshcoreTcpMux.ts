/**
 * MeshCore companion link shared by several renderers (headless web UI tabs).
 *
 * The companion protocol has no request ids: a command (`<` frame) is answered by the next reply
 * frame(s) (`>` frames, code below 0x80), and @liamcottle/meshcore.js resolves each pending command
 * with the next reply of the expected type. With every tab reading one byte stream, tab B's
 * replies would resolve tab A's commands. This multiplexer keeps the protocol single-client:
 *
 * - commands from all tabs go to the radio one at a time, in arrival order;
 * - replies go only to the tab whose command is in flight, until its last reply (contacts are a
 *   start / contact… / end sequence; every other command has one reply);
 * - pushes (code 0x80 and up: adverts, MsgWaiting, send confirmations…) go to every tab.
 *
 * A tab's drained messages and fetched contacts reach the other tabs through SQLite and the
 * shared-viewing data announcements (`shared/webBridgeDataSync.ts`).
 *
 * Failure behavior: a command with no reply (unknown to the firmware, or a reboot) releases the
 * link after {@link MESHCORE_MUX_REPLY_IDLE_MS} without a reply frame; a later stray reply then goes
 * to every tab. A tab that closes is dropped from the queue; replies to its in-flight command are
 * discarded. Malformed outgoing bytes are dropped and logged.
 */
import { MS_PER_SECOND } from '../../shared/timeConstants';

export const MESHCORE_MUX_REPLY_IDLE_MS = 5 * MS_PER_SECOND;

const FRAME_OUTGOING = 0x3c; // '<' renderer → radio
const FRAME_INCOMING = 0x3e; // '>' radio → renderer
const PUSH_CODE_MIN = 0x80;
const CMD_GET_CONTACTS = 4;
const RESP_CONTACTS_START = 2;
const RESP_CONTACT = 3;
/** Pending commands per tab; a tab beyond this is misbehaving and its extra frames are dropped. */
const MAX_QUEUED_PER_SESSION = 256;

/** Split a byte stream into whole frames (`marker` + uint16 LE length + payload). */
export class MeshcoreFrameReader {
  private buf = new Uint8Array(0);

  constructor(private readonly marker: number) {}

  /** Complete frames, header included; garbage before a header is skipped. */
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    let off = 0;
    const frames: Uint8Array[] = [];
    while (merged.length - off >= 3) {
      if (merged[off] !== this.marker) {
        off += 1;
        continue;
      }
      const len = (merged[off + 1] ?? 0) | ((merged[off + 2] ?? 0) << 8);
      if (len === 0) {
        off += 1;
        continue;
      }
      if (merged.length - off < 3 + len) break;
      frames.push(merged.slice(off, off + 3 + len));
      off += 3 + len;
    }
    this.buf = merged.slice(off);
    return frames;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

interface QueuedCommand {
  sessionId: number;
  frame: Uint8Array;
}

export interface MeshcoreTcpMuxDeps {
  writeToRadio: (frame: Uint8Array) => void;
  /** `null` = every tab. */
  deliver: (sessionId: number | null, frame: Uint8Array) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class MeshcoreTcpMux {
  private readonly incoming = new MeshcoreFrameReader(FRAME_INCOMING);
  private readonly outgoing = new Map<number, MeshcoreFrameReader>();
  private readonly queue: QueuedCommand[] = [];
  private inFlight: (QueuedCommand & { code: number; closed: boolean }) | null = null;
  private idleTimer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: MeshcoreTcpMuxDeps) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimeout ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      });
  }

  /** Bytes a tab wrote (`meshcore:tcp-write`). */
  fromSession(sessionId: number, bytes: Uint8Array): void {
    let reader = this.outgoing.get(sessionId);
    if (!reader) {
      reader = new MeshcoreFrameReader(FRAME_OUTGOING);
      this.outgoing.set(sessionId, reader);
    }
    for (const frame of reader.push(bytes)) {
      const queued = this.queue.filter((c) => c.sessionId === sessionId).length;
      if (queued >= MAX_QUEUED_PER_SESSION) {
        console.warn(`[meshcore-mux] session ${String(sessionId)}: command queue full; dropped`);
        continue;
      }
      this.queue.push({ sessionId, frame });
    }
    this.pump();
  }

  /** Bytes from the radio. */
  fromRadio(bytes: Uint8Array): void {
    for (const frame of this.incoming.push(bytes)) {
      const code = frame[3] ?? 0;
      if (code >= PUSH_CODE_MIN) {
        this.deps.deliver(null, frame);
        continue;
      }
      const cmd = this.inFlight;
      if (!cmd) {
        // A reply nobody is waiting for (late, after a timeout): every tab may make use of it.
        this.deps.deliver(null, frame);
        continue;
      }
      if (!cmd.closed) this.deps.deliver(cmd.sessionId, frame);
      if (this.isLastReply(cmd.code, code)) this.finish();
      else this.armIdleTimer();
    }
  }

  /** A tab went away: forget its queued commands; replies to its in-flight one are discarded. */
  sessionClosed(sessionId: number): void {
    this.outgoing.delete(sessionId);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.sessionId === sessionId) this.queue.splice(i, 1);
    }
    if (this.inFlight?.sessionId === sessionId) this.inFlight.closed = true;
  }

  /** The link closed or was replaced: nothing in flight or queued survives it. */
  reset(): void {
    this.cancelIdleTimer();
    this.inFlight = null;
    this.queue.length = 0;
    this.incoming.reset();
    for (const reader of this.outgoing.values()) reader.reset();
  }

  private isLastReply(command: number, reply: number): boolean {
    if (command === CMD_GET_CONTACTS) {
      return reply !== RESP_CONTACTS_START && reply !== RESP_CONTACT;
    }
    return true;
  }

  private pump(): void {
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = { ...next, code: next.frame[3] ?? 0, closed: false };
    this.armIdleTimer();
    try {
      this.deps.writeToRadio(next.frame);
    } catch (err) {
      console.warn('[meshcore-mux] write to radio failed', err);
      this.finish();
    }
  }

  private finish(): void {
    this.cancelIdleTimer();
    this.inFlight = null;
    this.pump();
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      const code = this.inFlight?.code;
      console.debug(
        `[meshcore-mux] no reply to command ${String(code)} within ${String(MESHCORE_MUX_REPLY_IDLE_MS)} ms; releasing`,
      );
      this.inFlight = null;
      this.pump();
    }, MESHCORE_MUX_REPLY_IDLE_MS);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer == null) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }
}
