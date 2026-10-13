/**
 * Host ↔ Meshtastic background ingest messages, and the handle both hosts return.
 * The desktop host sends these over a `utilityProcess` port; the headless host calls the ingest
 * directly, so the shapes double as documentation of the boundary.
 */
import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import type { MeshtasticLinkOrigin } from './linkTarget';
import type { MeshtasticBackendIngest, MeshtasticLinkKind } from './meshtasticBackendIngest';
import type { MeshtasticBackendRecord } from './meshtasticBackendRecords';

export type MeshtasticBackendCommand =
  | { t: 'open'; kind: MeshtasticLinkKind; origin: MeshtasticLinkOrigin }
  | { t: 'data'; bytes: Uint8Array }
  | { t: 'close'; kind: MeshtasticLinkKind }
  | { t: 'present'; value: boolean };

export type MeshtasticBackendEvent =
  | { t: 'persist'; record: MeshtasticBackendRecord }
  | { t: 'write'; frame: Uint8Array }
  | { t: 'caughtUp'; count: number };

/** One tap per Meshtastic link the main process carries (TCP socket, HTTP poll, BLE session). */
export type MeshtasticLinkTaps = Record<MeshtasticLinkKind, TcpBridgeTap>;

/** What the main process wires: the transport taps plus renderer presence. */
export interface MeshtasticBackendHandle {
  taps: MeshtasticLinkTaps;
  setRendererPresent: (present: boolean) => void;
  /** Channel identity of the connected radio (in-process host only; see the ingest). */
  channelIdentity?: (index: number) => { channelKey?: string; radioNodeId?: number };
  dispose: () => void;
}

/** Main-process side effects a host needs (SQLite insert, push to renderers). */
export interface MeshtasticBackendHostDeps {
  persist: (record: MeshtasticBackendRecord) => void;
  onCaughtUp: (count: number) => void;
}

export function applyMeshtasticBackendCommand(
  ingest: MeshtasticBackendIngest,
  cmd: MeshtasticBackendCommand,
): void {
  switch (cmd.t) {
    case 'open':
      ingest.linkOpened(cmd.kind, cmd.origin);
      break;
    case 'data':
      ingest.pushBytes(cmd.bytes);
      break;
    case 'close':
      ingest.linkClosed(cmd.kind);
      break;
    case 'present':
      ingest.setRendererPresent(cmd.value);
      break;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const LINK_KINDS: readonly unknown[] = ['tcp', 'serial', 'http', 'ble'];

export function isMeshtasticBackendCommand(v: unknown): v is MeshtasticBackendCommand {
  if (!isRecord(v)) return false;
  switch (v.t) {
    case 'open':
      return LINK_KINDS.includes(v.kind) && (v.origin === 'renderer' || v.origin === 'backend');
    case 'close':
      return LINK_KINDS.includes(v.kind);
    case 'data':
      return v.bytes instanceof Uint8Array;
    case 'present':
      return typeof v.value === 'boolean';
    default:
      return false;
  }
}

export function isMeshtasticBackendEvent(v: unknown): v is MeshtasticBackendEvent {
  if (!isRecord(v)) return false;
  switch (v.t) {
    case 'persist':
      return isRecord(v.record) && typeof v.record.kind === 'string';
    case 'write':
      return v.frame instanceof Uint8Array;
    case 'caughtUp':
      return typeof v.count === 'number';
    default:
      return false;
  }
}

/** Route an ingest event to the host's side effects (`write` goes to the tap's socket writer). */
export function dispatchMeshtasticBackendEvent(
  event: MeshtasticBackendEvent,
  deps: MeshtasticBackendHostDeps,
  write: ((frame: Uint8Array) => void) | null,
): void {
  try {
    if (event.t === 'persist') deps.persist(event.record);
    else if (event.t === 'write') write?.(event.frame);
    else deps.onCaughtUp(event.count);
  } catch (err) {
    console.warn(`[meshtastic-backend] host ${event.t} failed`, err);
  }
}

/**
 * Taps for every link kind, sharing one ingest. Only the most recently opened link feeds data
 * and receives heartbeats, so a stale link (e.g. HTTP still polling after a switch to TCP) is
 * ignored. `write` sends a heartbeat to that current link.
 */
export function createMeshtasticLinkTaps(send: (cmd: MeshtasticBackendCommand) => void): {
  taps: MeshtasticLinkTaps;
  write: (frame: Uint8Array) => void;
} {
  let current: { kind: MeshtasticLinkKind; write: (frame: Uint8Array) => void } | null = null;
  const tapFor = (kind: MeshtasticLinkKind): TcpBridgeTap => ({
    onOpen: (write, info) => {
      current = { kind, write };
      send({ t: 'open', kind, origin: info?.origin ?? 'renderer' });
    },
    onData: (bytes) => {
      if (current?.kind === kind) send({ t: 'data', bytes });
    },
    onClose: () => {
      if (current?.kind !== kind) return;
      current = null;
      send({ t: 'close', kind });
    },
  });
  return {
    taps: {
      tcp: tapFor('tcp'),
      serial: tapFor('serial'),
      http: tapFor('http'),
      ble: tapFor('ble'),
    },
    write: (frame) => {
      current?.write(frame);
    },
  };
}
