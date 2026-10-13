/**
 * Entry of `meshtastic-backend-host.js`, the opt-in desktop background-ingest host. Built
 * separately by `scripts/esbuild-main-build.mjs` and loaded by `desktopHostLoader.ts` only when
 * `MESH_CLIENT_MESHTASTIC_BACKEND=on`, so the default app does not carry it in `index.js`.
 *
 * Must not import main-process singletons (database, registered bridges, log service): this bundle
 * would get its own copies. Those arrive as injected functions ({@link DesktopMeshtasticMain}).
 */
import { sendMeshtasticBackendCaughtUp } from '../ipc/meshtastic-backend-push';
import type { RendererWindowTarget } from '../rendererPushTarget';
import { createDesktopMeshtasticBackend, type DesktopMeshtasticBackend } from './desktopBackend';
import type { GattProxyLike } from './gattTap';
import { meshtasticLinkKeeperDeps, type MeshtasticLinkOpeners } from './linkKeeperDeps';
import { createMeshtasticBackendPersist, type MeshtasticBackendPersistDb } from './persist';

export { createDesktopMeshtasticBackend } from './desktopBackend';
export { createMeshtasticBackendPersist } from './persist';

/** What the desktop main process lends the host: database, SQL helpers, links, window, BLE. */
export interface DesktopMeshtasticMain extends MeshtasticBackendPersistDb, MeshtasticLinkOpeners {
  getMainWindow: () => RendererWindowTarget | null;
  /** The sidecar GATT proxy: its Meshtastic BLE session feeds the ingest too. */
  gatt: GattProxyLike;
}

export function startDesktopMeshtasticBackend(
  main: DesktopMeshtasticMain,
): DesktopMeshtasticBackend {
  const persist = createMeshtasticBackendPersist(main);
  const backend = createDesktopMeshtasticBackend(
    {
      persist: (record) => {
        persist(record);
      },
      onCaughtUp: (count) => {
        console.debug(`[main] Meshtastic: ${count} record(s) stored by the background ingest`);
        sendMeshtasticBackendCaughtUp(main.getMainWindow(), { count });
      },
    },
    meshtasticLinkKeeperDeps(main, main.getDb),
  );
  backend.attachGatt(main.gatt);
  return backend;
}
