/**
 * Channel registry behind the headless `ipcMain` (see `electronShim.ts`).
 *
 * Main-process handler modules keep calling `ipcMain.handle` / `ipcMain.on`; in the headless
 * server bundle those land here, and `webServer.ts` dispatches bridge frames into them.
 */

import { RENDERER_INDEX_URL } from '../../shared/rendererOrigin';

/** Minimal stand-in for Electron's `IpcMainInvokeEvent` / `IpcMainEvent`. */
export interface HeadlessIpcEvent {
  /** Read by `validateIpcSender`; only authenticated bridge sessions get an event. */
  senderFrame: { url: string };
  sender: { id: number };
  /** Electron `IpcMainEvent.reply` — routes to the same bridge session. */
  reply: (channel: string, ...args: unknown[]) => void;
}

export type HeadlessInvokeHandler = (event: HeadlessIpcEvent, ...args: unknown[]) => unknown;
export type HeadlessSendListener = (event: HeadlessIpcEvent, ...args: unknown[]) => void;

/**
 * Origin the headless server reports for authenticated bridge sessions: the app's renderer origin
 * (`mesh-client://renderer`), the only one `validateIpcSender` trusts in packaged builds (the shim
 * reports `app.isPackaged === true`). Only sessions that passed the token check get an event.
 */
export const HEADLESS_SENDER_URL = RENDERER_INDEX_URL;

export class HeadlessIpcRegistry {
  private readonly handlers = new Map<string, HeadlessInvokeHandler>();
  private readonly listeners = new Map<string, HeadlessSendListener[]>();

  handle(channel: string, handler: HeadlessInvokeHandler): void {
    if (this.handlers.has(channel)) {
      // Same contract as Electron: a second handler for one channel is a programming error.
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, handler);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  on(channel: string, listener: HeadlessSendListener): void {
    const list = this.listeners.get(channel) ?? [];
    list.push(listener);
    this.listeners.set(channel, list);
  }

  removeListener(channel: string, listener: HeadlessSendListener): void {
    const list = this.listeners.get(channel);
    if (!list) return;
    const next = list.filter((l) => l !== listener);
    if (next.length > 0) this.listeners.set(channel, next);
    else this.listeners.delete(channel);
  }

  removeAllListeners(channel?: string): void {
    if (channel === undefined) this.listeners.clear();
    else this.listeners.delete(channel);
  }

  hasHandler(channel: string): boolean {
    return this.handlers.has(channel);
  }

  /** Registered invoke channels, sorted (startup log / tests). */
  invokeChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** Run an invoke handler; rejects with a clear message for channels not ported to headless. */
  invoke(channel: string, event: HeadlessIpcEvent, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      return Promise.reject(
        new Error(`No handler registered for '${channel}' (not available in headless mode)`),
      );
    }
    try {
      return Promise.resolve(handler(event, ...args));
    } catch (err) {
      // Sync throw → rejection, as Electron does for ipcMain.handle.
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Deliver a fire-and-forget send; returns false when nothing listens on the channel. */
  emit(channel: string, event: HeadlessIpcEvent, args: unknown[]): boolean {
    const list = this.listeners.get(channel);
    if (!list || list.length === 0) return false;
    for (const listener of [...list]) {
      try {
        listener(event, ...args);
      } catch (err) {
        console.error(
          `[headless] ipc listener for ${channel} threw:`,
          err instanceof Error ? err.message : String(err), // log-injection-ok internal handler error
        );
      }
    }
    return true;
  }
}

/** Process-wide registry used by the headless `ipcMain` shim. */
export const headlessIpcRegistry = new HeadlessIpcRegistry();
