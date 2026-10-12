/**
 * Where the renderer runs: the Electron app, or a browser tab served by the headless server.
 * Browser tabs have no app window, tray or OS session, so window-only controls hide there.
 */
import { meshTilesUrlToWebPath } from '@/shared/webBridgeProtocol';

/**
 * Safe at module load (module-level constants such as `MAP_BASEMAPS` call it): reads the bridge
 * through `globalThis`, so a test environment without `electronAPI` counts as the desktop app.
 */
export function isWebHost(): boolean {
  const api = (globalThis as { electronAPI?: { hostKind?: string } }).electronAPI;
  return api?.hostKind === 'web';
}

/**
 * Inline `<emoji-picker>` instead of the OS emoji panel: always on Linux (no native panel) and in
 * a browser (Electron's `showEmojiPanel` has nothing to open on a server).
 */
export function usesInlineEmojiPicker(): boolean {
  return window.electronAPI.getPlatform() === 'linux' || isWebHost();
}

/**
 * Map tile URL for this host: Electron serves the `mesh-tiles:` scheme itself; a browser cannot,
 * so the headless server serves the same cache at `/tiles/…`.
 */
export function hostMeshTilesUrl(url: string): string {
  return isWebHost() ? meshTilesUrlToWebPath(url) : url;
}
