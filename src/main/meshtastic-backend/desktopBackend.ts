/**
 * Desktop wiring for the Meshtastic background ingest (opt-in: `MESH_CLIENT_MESHTASTIC_BACKEND=on`).
 * The ingest runs in a `utilityProcess` and takes over persistence while the window's renderer is
 * not decoding: closed (macOS keeps the app alive), crashed, or mid-reload.
 *
 * `utilityProcess.fork` needs a ready app while the TCP bridge registers at module load, so the
 * bridges get {@link DesktopMeshtasticBackend.taps}, which forward once {@link start} has run.
 */
import type { BrowserWindow } from 'electron';

import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import type {
  MeshtasticBackendHandle,
  MeshtasticBackendHostDeps,
  MeshtasticLinkTaps,
} from './hostProtocol';
import type { MeshtasticLinkKind } from './meshtasticBackendIngest';
import { startUtilityMeshtasticBackend } from './utilityHost';

export const MESHTASTIC_BACKEND_ENV = 'MESH_CLIENT_MESHTASTIC_BACKEND';

export function isDesktopMeshtasticBackendEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MESHTASTIC_BACKEND_ENV]?.trim().toLowerCase() === 'on';
}

export interface DesktopMeshtasticBackend {
  taps: MeshtasticLinkTaps;
  /** Fork the worker (after `app.whenReady`). */
  start: () => void;
  /** Track whether `win`'s renderer is loaded and decoding. */
  watchWindow: (win: BrowserWindow) => void;
  dispose: () => void;
}

export function createDesktopMeshtasticBackend(
  deps: MeshtasticBackendHostDeps,
  startHost: (
    deps: MeshtasticBackendHostDeps,
  ) => MeshtasticBackendHandle = startUtilityMeshtasticBackend,
): DesktopMeshtasticBackend {
  let handle: MeshtasticBackendHandle | null = null;
  let present = false;
  const forward = (kind: MeshtasticLinkKind): TcpBridgeTap => ({
    onOpen: (write) => handle?.taps[kind].onOpen(write),
    onData: (chunk) => handle?.taps[kind].onData(chunk),
    onClose: () => handle?.taps[kind].onClose(),
  });
  const setPresent = (value: boolean): void => {
    present = value;
    handle?.setRendererPresent(value);
  };
  return {
    taps: { tcp: forward('tcp'), http: forward('http'), ble: forward('ble') },
    start: () => {
      if (handle) return;
      handle = startHost(deps);
      handle.setRendererPresent(present);
    },
    watchWindow: (win) => {
      const wc = win.webContents;
      wc.on('did-start-loading', () => {
        setPresent(false);
      });
      wc.on('did-finish-load', () => {
        setPresent(true);
      });
      wc.on('render-process-gone', () => {
        setPresent(false);
      });
      win.on('closed', () => {
        setPresent(false);
      });
    },
    dispose: () => {
      handle?.dispose();
      handle = null;
    },
  };
}
