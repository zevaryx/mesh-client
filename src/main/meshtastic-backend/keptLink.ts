/**
 * Compose a background-ingest handle with the link keeper: the keeper sees the TCP and HTTP taps
 * (it can reopen those links itself) and renderer presence. BLE is passed through untouched:
 * reopening a BLE session needs the sidecar's pairing and coexistence flow, which stays
 * renderer-driven.
 */
import type { MeshtasticBackendHandle } from './hostProtocol';
import { MeshtasticLinkKeeper, type MeshtasticLinkKeeperDeps } from './linkKeeper';

export function withMeshtasticLinkKeeper(
  handle: MeshtasticBackendHandle,
  deps: MeshtasticLinkKeeperDeps,
): MeshtasticBackendHandle {
  const keeper = new MeshtasticLinkKeeper(deps);
  keeper.start();
  return {
    taps: {
      tcp: keeper.wrap(handle.taps.tcp),
      http: keeper.wrap(handle.taps.http),
      ble: handle.taps.ble,
    },
    setRendererPresent: (present) => {
      handle.setRendererPresent(present);
      keeper.setRendererPresent(present);
    },
    dispose: () => {
      keeper.dispose();
      handle.dispose();
    },
  };
}
