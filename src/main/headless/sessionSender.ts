/**
 * `event.sender` for headless bridge sessions: the `WebContents` subset handlers use to talk back
 * to the tab that called them (`send`, `isDestroyed`, and the `destroyed` event when the tab's
 * WebSocket closes). Electron handlers written against `WebContents` (e.g. the beacon feed, which
 * streams to its caller and cleans up when it goes away) then work per tab.
 */
import { EventEmitter } from 'node:events';

export class HeadlessSessionSender extends EventEmitter {
  private destroyed = false;

  constructor(
    readonly id: number,
    private readonly deliver: (channel: string, args: unknown[]) => void,
  ) {
    super();
  }

  /** Push an event to this tab only (Electron `webContents.send`). */
  send(channel: string, ...args: unknown[]): void {
    if (!this.destroyed) this.deliver(channel, args);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** The tab's session closed: emit `destroyed` once, like a closed `WebContents`. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
    this.removeAllListeners();
  }
}
