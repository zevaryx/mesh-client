/**
 * Entry of `meshtastic-backend-host.js`, the opt-in desktop background-ingest host. Built
 * separately by `scripts/esbuild-main-build.mjs` and loaded by `desktopHostLoader.ts` only when
 * `MESH_CLIENT_MESHTASTIC_BACKEND=on`, so the default app does not carry it in `index.js`.
 *
 * Must not import main-process singletons (database, registered bridges, log service): this bundle
 * would get its own copies. Those arrive as injected dependencies instead.
 */
export { createDesktopMeshtasticBackend } from './desktopBackend';
