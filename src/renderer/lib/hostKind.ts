/**
 * Where the renderer runs: the Electron app, or a browser tab served by the headless server.
 * Browser tabs have no app window, tray or OS session, so window-only controls hide there.
 */
export function isWebHost(): boolean {
  return window.electronAPI.hostKind === 'web';
}

/**
 * Inline `<emoji-picker>` instead of the OS emoji panel: always on Linux (no native panel) and in
 * a browser (Electron's `showEmojiPanel` has nothing to open on a server).
 */
export function usesInlineEmojiPicker(): boolean {
  return window.electronAPI.getPlatform() === 'linux' || isWebHost();
}
