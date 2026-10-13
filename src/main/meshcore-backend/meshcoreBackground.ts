/**
 * MeshCore background session (headless server): while no browser tab is open, drain the
 * companion radio's message queue and store the messages, as the renderer would.
 *
 * The companion radio queues received messages and announces them with a MsgWaiting push; the
 * client pulls them one at a time with SyncNextMessage. A pulled message leaves the radio's queue,
 * so everything pulled here is stored with the renderer's own builders
 * (`parseMeshcoreDmIncomingFromThread`, `parseMeshcoreChannelIncomingFromThread`,
 * `buildMeshcoreRoomIncomingMessage`) and the same row mapping as `messageToDbRow`. What the
 * renderer does not store is not stored here either: CLI replies, transport status lines and
 * direct messages from senders missing from the stored contacts.
 *
 * It only talks to the radio while no tab is present (tabs drain the queue themselves): when the
 * last tab leaves, on a MsgWaiting push, and on a link it opened itself (the link keeper after a
 * restart or a drop), which also gets an AppStart so the radio treats it as its client. A tab that
 * arrives stops it after the command in flight. Through the TCP bridge's command serializer
 * nothing is waiting by then (tabs take seconds to send their first command).
 *
 * Failure behavior: a command without a reply ends the drain after {@link MESHCORE_BACKGROUND_REPLY_MS};
 * the next MsgWaiting push or link open starts again. Store errors are logged per message.
 */
import {
  buildMeshcoreRoomIncomingMessage,
  parseMeshcoreChannelIncomingFromThread,
  parseMeshcoreDmIncomingFromThread,
  parseMeshcoreRoomPostPayload,
  resolveMeshcoreChannelMessageSender,
} from '../../renderer/lib/meshcoreChannelText';
import {
  isMeshcoreTransportStatusChatLine,
  meshcoreChatStubNodeIdFromDisplayName,
  meshcoreCompanionRxPathLenToHopCount,
  pubkeyToNodeId,
  sanitizeMeshcoreChatWireText,
} from '../../renderer/lib/meshcoreUtils';
import type { ChatMessage } from '../../renderer/lib/types';
import { meshcoreMessageChannelIndex } from '../../shared/meshcoreMessageChannel';
import { effectiveMessageTimestampMs } from '../../shared/messageTimestampSkew';
import { MS_PER_SECOND } from '../../shared/timeConstants';
import { MeshcoreFrameReader } from '../ipc/meshcoreTcpMux';
import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import type { MeshcoreMessageRowParams } from '../meshcoreMessageChannel';
import type { MeshtasticLinkOrigin } from '../meshtastic-backend/linkTarget';
import { errorMessageText, sanitizeLogMessage } from '../sanitize-log-message';

export const MESHCORE_BACKGROUND_REPLY_MS = 12 * MS_PER_SECOND;
/** Let a departing tab's last command finish before pulling messages. */
export const MESHCORE_BACKGROUND_START_DELAY_MS = 2 * MS_PER_SECOND;
/** Same cap as the renderer's incremental drain (`MESHCORE_SYNC_NEXT_MESSAGE_MAX_PER_DRAIN`). */
const MAX_PER_DRAIN = 200;

const FRAME_OUTGOING = 0x3c; // '<'
const FRAME_INCOMING = 0x3e; // '>'
const CMD_APP_START = 1;
const CMD_SYNC_NEXT_MESSAGE = 10;
const RESP_SELF_INFO = 5;
const RESP_CONTACT_MSG = 7;
const RESP_CHANNEL_MSG = 8;
const RESP_NO_MORE_MESSAGES = 10;
const RESP_CONTACT_MSG_V3 = 16;
const RESP_CHANNEL_MSG_V3 = 17;
const PUSH_CODE_MIN = 0x80;
const PUSH_MSG_WAITING = 0x83;
const TXT_TYPE_CLI = 1;
const TXT_TYPE_SIGNED_PLAIN = 2;
/** `meshcore_contacts.contact_type` of a room server. */
const CONTACT_TYPE_ROOM = 3;
const APP_NAME = 'mesh-client';

export type MeshcoreLinkKind = 'tcp' | 'serial';

export interface MeshcoreStoredContact {
  nodeId: number;
  name: string | null;
  contactType: number;
}

export interface MeshcoreBackgroundDeps {
  /** Store one message row (`persistMeshcoreMessage`); returns whether a row was written. */
  persist: (row: MeshcoreMessageRowParams) => boolean;
  /** Stored contact whose public key starts with this lowercase hex prefix. */
  contactByPrefix: (prefixHex: string) => MeshcoreStoredContact | null;
  /** Messages were stored while no tab was present; a tab arrived (reload them). */
  onCaughtUp: (count: number) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

interface Pending {
  resolve: (payload: Uint8Array | null) => void;
  timer: unknown;
}

/** `<` + uint16 LE length + payload. */
export function meshcoreCommandFrame(payload: readonly number[] | Uint8Array): Uint8Array {
  const frame = new Uint8Array(3 + payload.length);
  frame[0] = FRAME_OUTGOING;
  frame[1] = payload.length & 0xff;
  frame[2] = (payload.length >> 8) & 0xff;
  frame.set(payload, 3);
  return frame;
}

function appStartPayload(): Uint8Array {
  const name = new TextEncoder().encode(APP_NAME);
  const payload = new Uint8Array(8 + name.length);
  payload[0] = CMD_APP_START;
  payload[1] = 1; // app version
  payload.set(name, 8);
  return payload;
}

function readText(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return new TextDecoder().decode(nul >= 0 ? bytes.subarray(0, nul) : bytes);
}

function u32le(b: Uint8Array, at: number): number {
  return (
    ((b[at] ?? 0) |
      ((b[at + 1] ?? 0) << 8) |
      ((b[at + 2] ?? 0) << 16) |
      ((b[at + 3] ?? 0) << 24)) >>>
    0
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface MeshcoreQueuedContactMessage {
  kind: 'contact';
  pubKeyPrefix: string;
  pathLen: number;
  txtType: number;
  senderTimestamp: number;
  text: string;
}

export interface MeshcoreQueuedChannelMessage {
  kind: 'channel';
  channelIdx: number;
  pathLen: number;
  txtType: number;
  senderTimestamp: number;
  text: string;
}

/** A SyncNextMessage reply (payload starts with the response code), as meshcore.js parses it. */
export function parseMeshcoreQueuedMessage(
  payload: Uint8Array,
): MeshcoreQueuedContactMessage | MeshcoreQueuedChannelMessage | null {
  const code = payload[0];
  const v3 = code === RESP_CONTACT_MSG_V3 || code === RESP_CHANNEL_MSG_V3;
  // v3: snr (int8 / 4), two reserved bytes before the v1 layout.
  let at = 1 + (v3 ? 3 : 0);
  if (code === RESP_CONTACT_MSG || code === RESP_CONTACT_MSG_V3) {
    if (payload.length < at + 12) return null;
    const pubKeyPrefix = hex(payload.subarray(at, at + 6));
    at += 6;
    const pathLen = payload[at] ?? 0;
    const txtType = payload[at + 1] ?? 0;
    const senderTimestamp = u32le(payload, at + 2);
    const text = readText(payload.subarray(at + 6));
    return { kind: 'contact', pubKeyPrefix, pathLen, txtType, senderTimestamp, text };
  }
  if (code === RESP_CHANNEL_MSG || code === RESP_CHANNEL_MSG_V3) {
    if (payload.length < at + 7) return null;
    const raw = payload[at] ?? 0;
    const channelIdx = raw > 127 ? raw - 256 : raw;
    const pathLen = payload[at + 1] ?? 0;
    const txtType = payload[at + 2] ?? 0;
    const senderTimestamp = u32le(payload, at + 3);
    const text = readText(payload.subarray(at + 7));
    return { kind: 'channel', channelIdx, pathLen, txtType, senderTimestamp, text };
  }
  return null;
}

/** `messageToDbRow` plus the `db:saveMeshcoreMessage` normalization, for an incoming message. */
export function meshcoreIncomingRow(
  msg: ChatMessage,
  radioNodeId: number,
  localOrder: number | null,
): MeshcoreMessageRowParams {
  let senderId: number | null = msg.sender_id !== 0 ? msg.sender_id >>> 0 : null;
  if (senderId == null) {
    const name = msg.sender_name?.trim();
    if (name && name !== 'Unknown') senderId = meshcoreChatStubNodeIdFromDisplayName(name);
  }
  const toNode = msg.to != null ? msg.to >>> 0 : null;
  const roomServerId = msg.roomServerId ?? null;
  return {
    sender_id: senderId,
    sender_name: msg.sender_name ?? null,
    payload: msg.payload,
    channel_idx: meshcoreMessageChannelIndex(msg.channel, toNode, roomServerId),
    local_order: localOrder,
    timestamp: effectiveMessageTimestampMs(msg.timestamp),
    status: msg.status ?? 'acked',
    packet_id: null,
    emoji: msg.emoji ?? null,
    reply_id: msg.replyId ?? null,
    to_node: toNode,
    received_via: 'rf',
    rx_packet_fingerprint: null,
    reply_preview_text: msg.replyPreviewText?.slice(0, 50) ?? null,
    reply_preview_sender: msg.replyPreviewSender?.slice(0, 64) ?? null,
    rx_hops: msg.rxHops != null && Number.isFinite(msg.rxHops) ? Math.trunc(msg.rxHops) : null,
    room_server_id: roomServerId,
    radio_node_id: radioNodeId > 0 ? radioNodeId >>> 0 : null,
    channel_key: null,
  };
}

export class MeshcoreBackground {
  readonly taps: Record<MeshcoreLinkKind, TcpBridgeTap>;
  private link: { kind: MeshcoreLinkKind; write: (bytes: Uint8Array) => void } | null = null;
  private readonly reader = new MeshcoreFrameReader(FRAME_INCOMING);
  private rendererPresent = false;
  private draining = false;
  private drainAgain = false;
  private startTimer: unknown = null;
  private pending: Pending | null = null;
  private myNodeId = 0;
  private storedWhileAway = 0;
  private lastLocalOrder = 0;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: MeshcoreBackgroundDeps) {
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimeout ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      });
    this.now = deps.now ?? Date.now;
    this.taps = { tcp: this.tapFor('tcp'), serial: this.tapFor('serial') };
  }

  setRendererPresent(present: boolean): void {
    if (present === this.rendererPresent) return;
    this.rendererPresent = present;
    if (present) {
      this.cancelStart();
      if (this.storedWhileAway > 0) {
        const count = this.storedWhileAway;
        this.storedWhileAway = 0;
        this.deps.onCaughtUp(count);
      }
      return;
    }
    // The last tab left: messages that arrived since its last drain wait in the radio.
    this.scheduleDrain(MESHCORE_BACKGROUND_START_DELAY_MS, false);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelStart();
    this.finishPending(null);
    this.link = null;
  }

  private tapFor(kind: MeshcoreLinkKind): TcpBridgeTap {
    return {
      onOpen: (write, info) => {
        this.finishPending(null);
        this.link = { kind, write };
        this.reader.reset();
        this.myNodeId = 0;
        const origin: MeshtasticLinkOrigin = info?.origin ?? 'renderer';
        if (!this.rendererPresent || origin === 'backend') {
          // A link the background opened: the radio needs a client (AppStart) before it streams.
          this.scheduleDrain(MESHCORE_BACKGROUND_START_DELAY_MS, origin === 'backend');
        }
      },
      onData: (chunk) => {
        if (this.link?.kind !== kind) return false;
        for (const frame of this.reader.push(chunk)) this.onFrame(frame.subarray(3));
        return false;
      },
      onClose: () => {
        if (this.link?.kind !== kind) return;
        this.link = null;
        this.cancelStart();
        this.finishPending(null);
      },
    };
  }

  private onFrame(payload: Uint8Array): void {
    const code = payload[0] ?? 0;
    if (code >= PUSH_CODE_MIN) {
      if (code === PUSH_MSG_WAITING && !this.rendererPresent) this.scheduleDrain(0, false);
      return;
    }
    this.finishPending(payload);
  }

  private scheduleDrain(ms: number, appStart: boolean): void {
    if (this.disposed || !this.link) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    if (this.startTimer != null) return;
    this.startTimer = this.setTimer(() => {
      this.startTimer = null;
      void this.drain(appStart);
    }, ms);
  }

  private cancelStart(): void {
    if (this.startTimer == null) return;
    this.clearTimer(this.startTimer);
    this.startTimer = null;
  }

  private finishPending(payload: Uint8Array | null): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.clearTimer(p.timer);
    p.resolve(payload);
  }

  /** Send one command; resolves with its reply payload, or `null` (timeout, link gone). */
  private request(payload: Uint8Array): Promise<Uint8Array | null> {
    const link = this.link;
    if (!link) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending = {
        resolve,
        timer: this.setTimer(() => {
          this.finishPending(null);
        }, MESHCORE_BACKGROUND_REPLY_MS),
      };
      try {
        link.write(meshcoreCommandFrame(payload));
      } catch (err) {
        console.warn('[meshcore-backend] write failed:', sanitizeLogMessage(errorMessageText(err)));
        this.finishPending(null);
      }
    });
  }

  private active(): boolean {
    return !this.disposed && this.link !== null && !this.rendererPresent;
  }

  private async drain(appStart: boolean): Promise<void> {
    if (!this.active() && !(appStart && this.link)) return;
    this.draining = true;
    let stored = 0;
    try {
      if (appStart || this.myNodeId === 0) {
        const self = await this.request(appStartPayload());
        // SelfInfo: code, type, txPower, maxTxPower, publicKey[32], ...
        if (self?.[0] === RESP_SELF_INFO && self.length >= 36) {
          this.myNodeId = pubkeyToNodeId(self.subarray(4, 36));
        }
      }
      for (let i = 0; i < MAX_PER_DRAIN && this.active(); i++) {
        const reply = await this.request(Uint8Array.of(CMD_SYNC_NEXT_MESSAGE));
        if (!reply || reply[0] === RESP_NO_MORE_MESSAGES) break;
        const queued = parseMeshcoreQueuedMessage(reply);
        if (!queued) break;
        if (this.store(queued)) stored++;
      }
    } finally {
      this.draining = false;
    }
    if (stored > 0) {
      console.debug(`[meshcore-backend] stored ${stored} message(s) while no tab was attached`);
      if (this.rendererPresent) this.deps.onCaughtUp(stored);
      else this.storedWhileAway += stored;
    }
    if (this.drainAgain) {
      this.drainAgain = false;
      this.scheduleDrain(0, false);
    }
  }

  private nextLocalOrder(): number {
    this.lastLocalOrder = Math.max(this.lastLocalOrder + 1, this.now() * 1000);
    return this.lastLocalOrder;
  }

  /** Store one pulled message as the renderer's waiting-message drain does; `true` if written. */
  private store(m: MeshcoreQueuedContactMessage | MeshcoreQueuedChannelMessage): boolean {
    const timestamp = effectiveMessageTimestampMs(m.senderTimestamp * 1000, this.now());
    const rxHops = meshcoreCompanionRxPathLenToHopCount(m.pathLen);
    const hops = rxHops != null ? { rxHops } : {};
    let msg: ChatMessage;
    let localOrder: number | null = null;
    if (m.kind === 'channel') {
      if (isMeshcoreTransportStatusChatLine(m.text)) return false;
      const resolved = resolveMeshcoreChannelMessageSender({ rawText: m.text });
      msg = parseMeshcoreChannelIncomingFromThread([], {
        rawText: m.text,
        senderId: resolved.senderId,
        displayName: resolved.displayName,
        channel: m.channelIdx,
        timestamp,
        receivedVia: 'rf',
        ...hops,
      });
    } else {
      if (m.txtType === TXT_TYPE_CLI) return false;
      const sender = this.deps.contactByPrefix(m.pubKeyPrefix);
      if (!sender) {
        console.debug(
          `[meshcore-backend] queued DM from unknown pubKeyPrefix ${m.pubKeyPrefix}; not stored`,
        );
        return false;
      }
      if (isMeshcoreTransportStatusChatLine(m.text)) return false;
      if (sender.contactType === CONTACT_TYPE_ROOM) {
        // Room server post: SignedPlain text starts with the author's 4-byte pubkey prefix.
        const signed = m.txtType === TXT_TYPE_SIGNED_PLAIN && m.text.length > 4;
        const author = signed ? this.deps.contactByPrefix(authorPrefixHex(m.text)) : null;
        const { authorId, payload } = signed
          ? parseMeshcoreRoomPostPayload(
              m.text,
              new Map(author ? [[authorPrefixHex(m.text), author.nodeId]] : []),
            )
          : { authorId: 0, payload: m.text };
        // The radio echoes our own posts back; the renderer does not store them either.
        if (this.myNodeId > 0 && authorId === this.myNodeId) return false;
        msg = buildMeshcoreRoomIncomingMessage({
          rawText: sanitizeMeshcoreChatWireText(payload),
          roomServerId: sender.nodeId,
          authorId,
          authorName:
            author?.name?.trim() ||
            (authorId !== 0 ? `Node-${authorId.toString(16).toUpperCase()}` : 'Unknown'),
          timestamp,
          receivedVia: 'rf',
          ...hops,
        });
      } else {
        msg = parseMeshcoreDmIncomingFromThread([], {
          rawText: m.text,
          senderId: sender.nodeId,
          displayName: sender.name?.trim() || `Node-${sender.nodeId.toString(16).toUpperCase()}`,
          timestamp,
          receivedVia: 'rf',
          peerNodeId: sender.nodeId,
          myNodeId: this.myNodeId,
          to: this.myNodeId || undefined,
          ...hops,
        });
        localOrder = this.nextLocalOrder();
      }
    }
    try {
      return this.deps.persist(meshcoreIncomingRow(msg, this.myNodeId, localOrder));
    } catch (err) {
      console.warn(
        '[meshcore-backend] storing a message failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      return false;
    }
  }
}

/** The 4-byte author prefix of a SignedPlain room post, as lowercase hex. */
function authorPrefixHex(text: string): string {
  return Array.from(text.slice(0, 4))
    .map((c) => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, '0'))
    .join('');
}
