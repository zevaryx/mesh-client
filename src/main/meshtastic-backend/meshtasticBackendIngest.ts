/**
 * Meshtastic background ingest: decode the radio byte stream in Node and persist chat, node
 * identity, positions and telemetry while no renderer is attached, so they are not lost when no
 * window / browser tab is open (records: `meshtasticBackendRecords.ts`). Plain Node, no Electron imports: hosted in-process by the headless server and in a
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
import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import type { GenMessage } from '@bufbuild/protobuf/codegenv1';
import { Utils } from '@meshtastic/core';
import { Channel, Mesh, Portnums, Telemetry } from '@meshtastic/protobufs';

import {
  decodeMeshtasticNodeInfo,
  decodeMeshtasticPosition,
  decodeMeshtasticTelemetry,
  decodeMeshtasticUserPacket,
} from '../../renderer/lib/protocols/meshtasticNodeDecode';
import {
  decodeMeshtasticTextPacket,
  meshtasticSenderDisplayName,
} from '../../renderer/lib/protocols/meshtasticTextDecode';
import type { DomainEvent } from '../../renderer/lib/protocols/Protocol';
import { normalizeReactionEmoji } from '../../renderer/lib/reactions';
import { computeChannelIdentityKey } from '../../shared/channelIdentityKey';
import {
  ENVIRONMENT_TELEMETRY_DEDUP_WINDOW_MS,
  type EnvironmentReading,
  environmentReadingsEqual,
} from '../../shared/environmentTelemetry';
import { isMeshtasticBroadcastNodeNum } from '../../shared/nodeNameUtils';
import { MESHTASTIC_TAPBACK_DATA_EMOJI_FLAG } from '../../shared/reactionEmoji';
import { MS_PER_SECOND } from '../../shared/timeConstants';
import type { MeshtasticLinkOrigin } from './linkTarget';
import {
  type MeshtasticBackendRecord,
  recordsForChatSender,
  recordsForNodeDbEntry,
  recordsForPosition,
  recordsForTelemetry,
  recordsForUserPacket,
} from './meshtasticBackendRecords';

const { PortNum } = Portnums;

/**
 * How a link delivers FromRadio and takes keep-alives:
 * - `tcp`: a byte stream (0x94 0xC3 framing); heartbeats are framed.
 * - `http`: one FromRadio per `/api/v1/fromradio` poll; no heartbeat (the renderer sends none).
 * - `ble`: one FromRadio per sidecar notification; heartbeats are raw ToRadio.
 */
export type MeshtasticLinkKind = 'tcp' | 'http' | 'ble';

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
  receivedVia: 'rf' | 'mqtt';
  viaStoreForward?: boolean;
  radioNodeId?: number;
  channelKey?: string;
}

export interface MeshtasticBackendSinks {
  /** Store one record (message, node patch, position point, environment reading). */
  persist: (record: MeshtasticBackendRecord) => void;
  /** A ToRadio heartbeat for the active link, already in that link's wire format. */
  writeToRadio: (frame: Uint8Array) => void;
  /** A renderer took ownership after the backend persisted `count` records; it should reload. */
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

/**
 * `want_config_id` ToRadio: asks the radio for its config dump and starts the packet stream.
 * Renderers send this through `@meshtastic/core`; links the backend opens itself need it too.
 */
export function meshtasticWantConfigFrame(nonce: number, raw = false): Uint8Array {
  const toRadio = create(Mesh.ToRadioSchema, {
    payloadVariant: { case: 'wantConfigId', value: nonce >>> 0 },
  });
  const bytes = toBinary(Mesh.ToRadioSchema, toRadio);
  return raw ? bytes : frameMeshtasticToRadio(bytes);
}

/** Heartbeat ToRadio, framed for the stream API unless `raw` (BLE writes bare protobufs). */
export function meshtasticHeartbeatFrame(raw = false): Uint8Array {
  const toRadio = create(Mesh.ToRadioSchema, {
    payloadVariant: { case: 'heartbeat', value: create(Mesh.HeartbeatSchema) },
  });
  const bytes = toBinary(Mesh.ToRadioSchema, toRadio);
  return raw ? bytes : frameMeshtasticToRadio(bytes);
}

export class MeshtasticBackendIngest {
  private rendererPresent = false;
  /** A present renderer owns the current socket (it opened it); the backend stays passive. */
  private attached = false;
  private linkUp = false;
  private linkKind: MeshtasticLinkKind = 'tcp';
  private myNodeNum = 0;
  private readonly channelKeyByIndex = new Map<number, string>();
  private readonly names = new Map<number, NodeNames>();
  /** Last stored environment reading per node, for the renderer's duplicate-reading window. */
  private readonly lastEnvironment = new Map<number, { t: number; reading: EnvironmentReading }>();
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

  /**
   * A new link connected: drop per-link state; the radio re-sends it during config. A link the
   * backend opened itself (`origin: 'backend'`) stays the backend's even if a renderer is present,
   * and gets a config request so the radio starts streaming.
   */
  linkOpened(kind: MeshtasticLinkKind = 'tcp', origin: MeshtasticLinkOrigin = 'renderer'): void {
    if (kind === 'tcp') this.resetFramer();
    else this.closeFramer();
    this.linkKind = kind;
    this.linkUp = true;
    this.myNodeNum = 0;
    this.channelKeyByIndex.clear();
    if (origin === 'backend') {
      this.attached = false;
    } else if (this.rendererPresent && !this.attached) {
      this.attached = true;
      const count = this.persistedWhileDetached;
      this.persistedWhileDetached = 0;
      if (count > 0) this.notifyCaughtUp(count);
    }
    this.syncHeartbeat();
    if (origin === 'backend') {
      this.send(meshtasticWantConfigFrame(Math.floor(Math.random() * 0xffffffff), kind !== 'tcp'));
    }
  }

  /** A link closed. A late close from a link already replaced by another kind is ignored. */
  linkClosed(kind?: MeshtasticLinkKind): void {
    if (kind !== undefined && kind !== this.linkKind) return;
    this.linkUp = false;
    this.closeFramer();
    this.syncHeartbeat();
  }

  /** Inbound data: stream bytes on `tcp`, one whole FromRadio per call on `http` / `ble`. */
  pushBytes(chunk: Uint8Array): void {
    if (this.linkKind !== 'tcp') {
      this.handleFromRadio(chunk);
      return;
    }
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

  /**
   * The connected radio's id and the channel key of one of its channels, for rows that arrive by
   * another path (MQTT) but belong to this radio's channel. Empty while no link is up.
   */
  channelIdentity(index: number): { channelKey?: string; radioNodeId?: number } {
    if (!this.linkUp) return {};
    const channelKey = this.channelKeyByIndex.get(index);
    return {
      ...(channelKey ? { channelKey } : {}),
      ...(this.myNodeNum !== 0 ? { radioNodeId: this.myNodeNum } : {}),
    };
  }

  /** True while the backend, not a renderer, is responsible for persisting. */
  isPersisting(): boolean {
    return !this.attached;
  }

  dispose(): void {
    this.linkClosed();
  }

  private closeFramer(): void {
    void this.framerWriter?.close().catch(() => {
      // catch-no-log-ok framer already closed by an earlier link drop
    });
    this.framerWriter = null;
  }

  private resetFramer(): void {
    this.closeFramer();
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
    const want = this.linkUp && !this.attached && this.linkKind !== 'http';
    if (this.heartbeat != null) {
      // Re-arm on every change so a link-kind switch never keeps the old wire format.
      this.clearTimer(this.heartbeat);
      this.heartbeat = null;
    }
    if (want) {
      const raw = this.linkKind === 'ble';
      this.heartbeat = this.setTimer(() => {
        this.send(meshtasticHeartbeatFrame(raw));
      }, MESHTASTIC_BACKEND_HEARTBEAT_MS);
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
      console.warn('[meshtastic-backend] write to radio failed', err);
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
        // Config dump: stored only while the backend owns the link (e.g. it reconnected itself).
        for (const event of decodeMeshtasticNodeInfo(v.value)) {
          if (event.type === 'node_info') {
            this.persistAll(recordsForNodeDbEntry(event.payload, this.myNodeNum));
          }
        }
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
    switch (data.portnum) {
      case PortNum.TEXT_MESSAGE_APP:
      case PortNum.ALERT_APP:
        for (const event of decodeMeshtasticTextPacket(packet)) {
          if (event.type === 'text_message') this.handleText(event.payload);
        }
        return;
      case PortNum.NODEINFO_APP: {
        const user = this.decodePayload(Mesh.UserSchema, data.payload, 'User');
        if (!user) return;
        this.rememberNames(packet.from, user);
        // Same `{ from, rxTime, data }` shape as `@meshtastic/core`'s onUserPacket.
        for (const event of decodeMeshtasticUserPacket({ ...packet, data: user })) {
          if (event.type === 'node_info') this.persistAll(recordsForUserPacket(event.payload));
        }
        return;
      }
      case PortNum.POSITION_APP: {
        const position = this.decodePayload(Mesh.PositionSchema, data.payload, 'Position');
        if (!position) return;
        for (const event of decodeMeshtasticPosition({ ...packet, data: position })) {
          if (event.type === 'position') {
            this.persistAll(recordsForPosition(event.payload, this.myNodeNum));
          }
        }
        return;
      }
      case PortNum.TELEMETRY_APP: {
        const telemetry = this.decodePayload(Telemetry.TelemetrySchema, data.payload, 'Telemetry');
        if (!telemetry) return;
        for (const event of decodeMeshtasticTelemetry({ ...packet, data: telemetry })) {
          if (event.type === 'telemetry') {
            this.persistAll(
              recordsForTelemetry(event.payload, this.myNodeNum).filter((r) =>
                this.isNewEnvironmentReading(r),
              ),
            );
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private decodePayload<T extends Message>(
    schema: GenMessage<T>,
    payload: Uint8Array,
    label: string,
  ): T | null {
    try {
      return fromBinary(schema, payload);
    } catch (err) {
      console.debug(`[meshtastic-backend] dropped undecodable ${label} payload`, err);
      return null;
    }
  }

  /** Renderer parity: an identical reading within the dedup window is not stored again. */
  private isNewEnvironmentReading(record: MeshtasticBackendRecord): boolean {
    if (record.kind !== 'environment') return true;
    const last = this.lastEnvironment.get(record.nodeId);
    if (
      last &&
      record.recordedAt - last.t < ENVIRONMENT_TELEMETRY_DEDUP_WINDOW_MS &&
      environmentReadingsEqual(last.reading, record.reading)
    ) {
      return false;
    }
    if (this.lastEnvironment.size >= MAX_NAMED_NODES && !this.lastEnvironment.has(record.nodeId)) {
      const oldest = this.lastEnvironment.keys().next();
      if (!oldest.done) this.lastEnvironment.delete(oldest.value);
    }
    this.lastEnvironment.set(record.nodeId, { t: record.recordedAt, reading: record.reading });
    return true;
  }

  private persistAll(records: MeshtasticBackendRecord[]): void {
    // The renderer owns persistence while attached.
    if (this.attached) return;
    for (const record of records) {
      try {
        this.sinks.persist(record);
        this.persistedWhileDetached += 1;
      } catch (err) {
        console.warn(`[meshtastic-backend] persist ${record.kind} failed`, err);
      }
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
    this.persistAll([...recordsForChatSender(text.from, text.timestamp), { kind: 'message', row }]);
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
