/**
 * Push from the Meshtastic background ingest to renderers: rows were written to SQLite while no
 * renderer owned the radio link, so the renderer that just took over should reload messages.
 * The channel literal lives under `src/main/ipc/` so `check:ipc-contract` pairs it with preload.
 */
import type { RendererWindowTarget } from '../rendererPushTarget';

export interface MeshtasticBackendCaughtUp {
  count: number;
}

export function sendMeshtasticBackendCaughtUp(
  win: RendererWindowTarget | null,
  payload: MeshtasticBackendCaughtUp,
): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('meshtastic:backend-caught-up', payload);
}
