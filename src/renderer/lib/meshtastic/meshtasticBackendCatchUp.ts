/**
 * Reload Meshtastic messages after the main-process background ingest persisted rows while no
 * renderer owned the radio link (headless: every browser tab closed). Fires when this renderer's
 * own reconnect takes the link back, so the reload sees every row the backend wrote.
 */
export function subscribeMeshtasticBackendCatchUp(
  reloadMessages: () => void,
  api: Pick<Window['electronAPI']['meshtastic'], 'onBackendCaughtUp'> = window.electronAPI
    .meshtastic,
): () => void {
  return api.onBackendCaughtUp(({ count }) => {
    console.debug(`[meshtasticBackendCatchUp] ${String(count)} message(s) stored while away`);
    reloadMessages();
  });
}
