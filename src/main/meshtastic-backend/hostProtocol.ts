/**
 * Host ↔ Meshtastic background ingest messages, and the handle both hosts return.
 * The desktop host sends these over a `utilityProcess` port; the headless host calls the ingest
 * directly, so the shapes double as documentation of the boundary.
 */
import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import type {
  MeshtasticBackendIngest,
  MeshtasticBackendMessageRow,
} from './meshtasticBackendIngest';

export type MeshtasticBackendCommand =
  | { t: 'open' }
  | { t: 'data'; bytes: Uint8Array }
  | { t: 'close' }
  | { t: 'present'; value: boolean };

export type MeshtasticBackendEvent =
  | { t: 'persist'; row: MeshtasticBackendMessageRow }
  | { t: 'write'; frame: Uint8Array }
  | { t: 'caughtUp'; count: number };

/** What the main process wires: the transport tap plus renderer presence. */
export interface MeshtasticBackendHandle {
  tap: TcpBridgeTap;
  setRendererPresent: (present: boolean) => void;
  dispose: () => void;
}

/** Main-process side effects a host needs (SQLite insert, push to renderers). */
export interface MeshtasticBackendHostDeps {
  persistMessage: (row: MeshtasticBackendMessageRow) => void;
  onCaughtUp: (count: number) => void;
}

export function applyMeshtasticBackendCommand(
  ingest: MeshtasticBackendIngest,
  cmd: MeshtasticBackendCommand,
): void {
  switch (cmd.t) {
    case 'open':
      ingest.linkOpened();
      break;
    case 'data':
      ingest.pushBytes(cmd.bytes);
      break;
    case 'close':
      ingest.linkClosed();
      break;
    case 'present':
      ingest.setRendererPresent(cmd.value);
      break;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function isMeshtasticBackendCommand(v: unknown): v is MeshtasticBackendCommand {
  if (!isRecord(v)) return false;
  switch (v.t) {
    case 'open':
    case 'close':
      return true;
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
      return isRecord(v.row);
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
    if (event.t === 'persist') deps.persistMessage(event.row);
    else if (event.t === 'write') write?.(event.frame);
    else deps.onCaughtUp(event.count);
  } catch (err) {
    console.warn(`[meshtastic-backend] host ${event.t} failed`, err);
  }
}
