/**
 * Meshtastic background ingest (spike): decode the radio byte stream in Node and persist chat
 * text while no renderer is attached, so messages are not lost when no window / browser tab is
 * open. Plain Node, no Electron imports: hosted in-process by the headless server and in a
 * `utilityProcess` on desktop (see `utilityHost.ts`).
 *
 * Ownership: only renderers open sockets, so a socket opened while a renderer is present is
 * owned by it, and the renderer persists. When the last renderer goes away the backend takes
 * over: it writes rows and keep-alive heartbeats until a present renderer opens a socket again.
 * A renderer that has just appeared is not decoding yet (its runtime reconnects first), so
 * presence alone never hands ownership back. Rows go through `db:saveMessage`'s
 * `INSERT OR IGNORE` (unique sender + packet id), so a renderer write of the same packet is a no-op.
 *
 * Failure behavior: malformed frames are dropped and logged at debug; a failed sink call is
 * logged and the stream keeps going. Lost state on link drop is rebuilt from the next config dump.
 */
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Utils } from '@meshtastic/core';
import { Channel, Mesh, Portnums } from '@meshtastic/protobufs';

import {
  decodeMeshtasticTextPacket,
  meshtasticSenderDisplayName,
} from '../../renderer/lib/protocols/meshtasticTextDecode';
import type { DomainEvent } from '../../renderer/lib/protocols/Protocol';
import { normalizeReactionEmoji } from '../../renderer/lib/reactions';
import { computeChannelIdentityKey } from '../../shared/channelIdentityKey';
import { isMeshtasticBroadcastNodeNum } from '../../shared/nodeNameUtils';
import { MESHTASTIC_TAPBACK_DATA_EMOJI_FLAG } from '../../shared/reactionEmoji';
import { MS_PER_SECOND } from '../../shared/timeConstants';

const { PortNum } = Portnums;

/** Same cadence as the renderer's keep-alive (`meshtasticTransportSideEffects.ts`). */
export const MESHTASTIC_BACKEND_HEARTBEAT_MS = 60 * MS_PER_SECOND;
/** Node names kept for `sender_name`; the radio's NodeDB dump refills it on every connect. */
const MAX_NAMED_NODES = 4096;

/** `db:saveMessage` payload (validated again by the host before insert). */
export interface MeshtasticBackendMessageRow {
  sender_id: number;
  sender_name: string;
  payload: string;
  channel: number;
  timestamp: number;
  packetId?: number;
  to?: number;
  emoji?: number;
  replyId?: number;
  rxHops?: number;
  receivedVia: 'rf';
  radioNodeId?: number;
  channelKey?: string;
}

export interface MeshtasticBackendSinks {
  persistMessage: (row: MeshtasticBackendMessageRow) => void;
  /** Framed toRadio bytes (0x94 0xC3 header included) for the active socket. */
  writeToRadio: (frame: Uint8Array) => void;
  /** A renderer took ownership after the backend persisted `count` rows; it should reload. */
  onCaughtUp: (count: number) => void;
}

export interface MeshtasticBackendIngestOptions {
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface NodeNames {
  shortName?: string;
  longName?: string;
}

type TextEvent = Extract<DomainEvent, { type: 'text_message' }>['payload'];

/** Frame one ToRadio protobuf for the stream API (magic + big-endian 16-bit length). */
export function frameMeshtasticToRadio(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  frame.set([0x94, 0xc3, (payload.length >> 8) & 0xff, payload.length & 0xff], 0);
  frame.set(payload, 4);
  return frame;
}

export function meshtasticHeartbeatFrame(): Uint8Array {
  const toRadio = create(Mesh.ToRadioSchema, {
    payloadVariant: { case: 'heartbeat', value: create(Mesh.HeartbeatSchema) },
  });
  return frameMeshtasticToRadio(toBinary(Mesh.ToRadioSchema, toRadio));
}

export class MeshtasticBackendIngest {
  private rendererPresent = false;
  /** A present renderer owns the current socket (it opened it); the backend stays passive. */
  private attached = false;
  private linkUp = false;
  private myNodeNum = 0;
  private readonly channelKeyByIndex = new Map<number, string>();
  private readonly names = new Map<number, NodeNames>();
  private framerWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private heartbeat: unknown = null;
  private persistedWhileDetached = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly sinks: MeshtasticBackendSinks,
    options: MeshtasticBackendIngestOptions = {},
  ) {
    this.setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer =
      options.clearInterval ??
      ((h) => {
        clearInterval(h as ReturnType<typeof setInterval>);
      });
  }

  /** A new socket connected: drop per-link state; the radio re-sends it during config. */
  linkOpened(): void {
    this.resetFramer();
    this.linkUp = true;
    this.myNodeNum = 0;
    this.channelKeyByIndex.clear();
    if (this.rendererPresent && !this.attached) {
      this.attached = true;
      const count = this.persistedWhileDetached;
      this.persistedWhileDetached = 0;
      if (count > 0) this.notifyCaughtUp(count);
    }
    this.syncHeartbeat();
  }

  linkClosed(): void {
    this.linkUp = false;
    void this.framerWriter?.close().catch(() => {
      // catch-no-log-ok framer already closed by an earlier link drop
    });
    this.framerWriter = null;
    this.syncHeartbeat();
  }

  /** Raw inbound bytes from the active socket. */
  pushBytes(chunk: Uint8Array): void {
    if (!this.framerWriter) this.resetFramer();
    void this.framerWriter?.write(chunk).catch((err: unknown) => {
      console.debug('[meshtastic-backend] framer write failed', err);
    });
  }

  /** Whether any renderer (window or browser tab) is connected to the host right now. */
  setRendererPresent(present: boolean): void {
    this.rendererPresent = present;
    if (!present && this.attached) {
      this.attached = false;
      this.syncHeartbeat();
    }
  }

  /** True while the backend, not a renderer, is responsible for persisting. */
  isPersisting(): boolean {
    return !this.attached;
  }

  dispose(): void {
    this.linkClosed();
  }

  private resetFramer(): void {
    void this.framerWriter?.close().catch(() => {
      // catch-no-log-ok replaced framer may already be closed
    });
    const framer = Utils.fromDeviceStream();
    this.framerWriter = framer.writable.getWriter();
    const reader = framer.readable.getReader();
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.type === 'packet') this.handleFromRadio(value.data);
      }
    };
    pump().catch((err: unknown) => {
      console.debug('[meshtastic-backend] framer read ended', err);
    });
  }

  private syncHeartbeat(): void {
    const want = this.linkUp && !this.attached;
    if (want && this.heartbeat == null) {
      this.heartbeat = this.setTimer(() => {
        this.send(meshtasticHeartbeatFrame());
      }, MESHTASTIC_BACKEND_HEARTBEAT_MS);
    } else if (!want && this.heartbeat != null) {
      this.clearTimer(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private notifyCaughtUp(count: number): void {
    try {
      this.sinks.onCaughtUp(count);
    } catch (err) {
      console.warn('[meshtastic-backend] caught-up notify failed', err);
    }
  }

  private send(frame: Uint8Array): void {
    try {
      this.sinks.writeToRadio(frame);
    } catch (err) {
      console.warn('[meshtastic-backend] heartbeat write failed', err);
    }
  }

  private handleFromRadio(bytes: Uint8Array): void {
    let fromRadio: Mesh.FromRadio;
    try {
      fromRadio = fromBinary(Mesh.FromRadioSchema, bytes);
    } catch (err) {
      console.debug('[meshtastic-backend] dropped undecodable FromRadio', err);
      return;
    }
    const v = fromRadio.payloadVariant;
    switch (v.case) {
      case 'myInfo':
        this.myNodeNum = v.value.myNodeNum >>> 0;
        break;
      case 'nodeInfo':
        if (v.value.user) this.rememberNames(v.value.num, v.value.user);
        break;
      case 'channel': {
        const ch = v.value;
        const name = ch.settings?.name ?? '';
        const psk = ch.settings?.psk ?? new Uint8Array([1]);
        if (ch.role === Channel.Channel_Role.DISABLED) this.channelKeyByIndex.delete(ch.index);
        else
          this.channelKeyByIndex.set(ch.index, computeChannelIdentityKey('meshtastic', name, psk));
        break;
      }
      case 'packet':
        this.handlePacket(v.value);
        break;
      default:
        break;
    }
  }

  private handlePacket(packet: Mesh.MeshPacket): void {
    if (packet.payloadVariant.case !== 'decoded') return;
    const data = packet.payloadVariant.value;
    if (data.portnum === PortNum.NODEINFO_APP) {
      try {
        this.rememberNames(packet.from, fromBinary(Mesh.UserSchema, data.payload));
      } catch (err) {
        console.debug('[meshtastic-backend] dropped undecodable User payload', err);
      }
      return;
    }
    if (data.portnum !== PortNum.TEXT_MESSAGE_APP && data.portnum !== PortNum.ALERT_APP) return;
    for (const event of decodeMeshtasticTextPacket(packet)) {
      if (event.type === 'text_message') this.handleText(event.payload);
    }
  }

  private handleText(text: TextEvent): void {
    // The renderer owns persistence while attached; the radio's own echoes are outbound rows.
    if (this.attached) return;
    if (this.myNodeNum !== 0 && text.from === this.myNodeNum) return;
    const packetId = Number(text.id);
    const isChannel = isMeshtasticBroadcastNodeNum(text.to);
    const channelKey = isChannel ? this.channelKeyByIndex.get(text.channelIndex) : undefined;
    const emoji = text.tapback
      ? normalizeReactionEmoji(MESHTASTIC_TAPBACK_DATA_EMOJI_FLAG, text.payload)
      : undefined;
    const row: MeshtasticBackendMessageRow = {
      sender_id: text.from,
      sender_name: meshtasticSenderDisplayName(text.from, this.names.get(text.from)),
      payload: text.payload,
      channel: text.channelIndex,
      timestamp: text.timestamp,
      ...(packetId > 0 ? { packetId } : {}),
      ...(isChannel ? {} : { to: text.to }),
      ...(emoji != null ? { emoji } : {}),
      ...(text.replyTo != null ? { replyId: Number(text.replyTo) } : {}),
      ...(text.hopCount != null ? { rxHops: text.hopCount } : {}),
      receivedVia: 'rf',
      ...(this.myNodeNum !== 0 ? { radioNodeId: this.myNodeNum } : {}),
      ...(channelKey ? { channelKey } : {}),
    };
    try {
      this.sinks.persistMessage(row);
      this.persistedWhileDetached += 1;
    } catch (err) {
      console.warn('[meshtastic-backend] persist failed', err);
    }
  }

  private rememberNames(nodeNum: number, user: { shortName: string; longName: string }): void {
    if (this.names.size >= MAX_NAMED_NODES && !this.names.has(nodeNum)) {
      // Lazy cleanup: drop the oldest entry; the next config dump repopulates it.
      const oldest = this.names.keys().next();
      if (!oldest.done) this.names.delete(oldest.value);
    }
    this.names.set(nodeNum >>> 0, { shortName: user.shortName, longName: user.longName });
  }
}
