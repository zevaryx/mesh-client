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
import { attachMeshtasticGattTap, type GattProxyLike } from './gattTap';
import type {
  MeshtasticBackendHandle,
  MeshtasticBackendHostDeps,
  MeshtasticLinkTaps,
} from './hostProtocol';
import { withMeshtasticLinkKeeper } from './keptLink';
import type { MeshtasticLinkKeeperDeps } from './linkKeeper';
import type { MeshtasticLinkKind } from './meshtasticBackendIngest';
import { startUtilityMeshtasticBackend } from './utilityHost';

export interface DesktopMeshtasticBackend {
  taps: MeshtasticLinkTaps;
  /** Fork the worker (after `app.whenReady`). */
  start: () => void;
  /** Track whether `win`'s renderer is loaded and decoding. */
  watchWindow: (win: BrowserWindow) => void;
  /** Feed the Meshtastic BLE session of the sidecar GATT proxy. */
  attachGatt: (proxy: GattProxyLike) => void;
  dispose: () => void;
}

/**
 * `keeperDeps` comes from the main bundle (it opens links through the registered bridges and
 * stores the target in SQLite), because this module ships in a separately loaded bundle.
 */
export function createDesktopMeshtasticBackend(
  deps: MeshtasticBackendHostDeps,
  keeperDeps: MeshtasticLinkKeeperDeps,
  startHost: (deps: MeshtasticBackendHostDeps) => MeshtasticBackendHandle = (hostDeps) =>
    withMeshtasticLinkKeeper(startUtilityMeshtasticBackend(hostDeps), keeperDeps),
): DesktopMeshtasticBackend {
  let handle: MeshtasticBackendHandle | null = null;
  let present = false;
  const forward = (kind: MeshtasticLinkKind): TcpBridgeTap => ({
    onOpen: (write, info) => handle?.taps[kind].onOpen(write, info),
    onData: (chunk) => handle?.taps[kind].onData(chunk),
    onClose: () => handle?.taps[kind].onClose(),
    onUserDisconnect: () => handle?.taps[kind].onUserDisconnect?.(),
  });
  const taps: MeshtasticLinkTaps = {
    tcp: forward('tcp'),
    http: forward('http'),
    ble: forward('ble'),
  };
  const setPresent = (value: boolean): void => {
    present = value;
    handle?.setRendererPresent(value);
  };
  return {
    taps,
    start: () => {
      if (handle) return;
      handle = startHost(deps);
      handle.setRendererPresent(present);
    },
    attachGatt: (proxy) => {
      attachMeshtasticGattTap(proxy, taps.ble);
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
