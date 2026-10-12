/**
 * Reload Meshtastic state after the main-process background ingest stored records while no
 * renderer owned the radio link (headless: every browser tab closed). Fires when this renderer's
 * own reconnect takes the link back, so the reload sees every record the backend wrote:
 * messages and nodes through the runtime, position and environment history from their stores.
 */
import { useEnvironmentTelemetryStore } from '../../stores/environmentTelemetryStore';
import { usePositionHistoryStore } from '../../stores/positionHistoryStore';
import { errLikeToLogString } from '../errLikeToLogString';

async function reloadHistoryStores(): Promise<void> {
  await Promise.all([
    usePositionHistoryStore.getState().loadHistoryFromDb(),
    useEnvironmentTelemetryStore.getState().loadFromDb(),
  ]);
}

export function subscribeMeshtasticBackendCatchUp(
  reloadRuntime: () => void,
  api: Pick<Window['electronAPI']['meshtastic'], 'onBackendCaughtUp'> = window.electronAPI
    .meshtastic,
  reloadHistories: () => Promise<void> = reloadHistoryStores,
): () => void {
  return api.onBackendCaughtUp(({ count }) => {
    console.debug(`[meshtasticBackendCatchUp] ${String(count)} record(s) stored while away`);
    reloadRuntime();
    reloadHistories().catch((err: unknown) => {
      console.warn('[meshtasticBackendCatchUp] history reload failed ' + errLikeToLogString(err));
    });
  });
}
