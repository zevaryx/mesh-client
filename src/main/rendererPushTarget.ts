/**
 * What a main-process module needs to push an event to the renderer.
 *
 * Electron's `BrowserWindow` satisfies this structurally; the headless server supplies a window
 * whose `webContents.send` fans out to its WebSocket bridge sessions. Handler modules that take
 * this instead of `BrowserWindow` run unchanged in both hosts.
 */
export interface RendererPushTarget {
  webContents: {
    send: (channel: string, ...args: unknown[]) => void;
  };
}

/** A push target that can also report that its window is gone (Electron `BrowserWindow` shape). */
export interface RendererWindowTarget extends RendererPushTarget {
  isDestroyed: () => boolean;
}
