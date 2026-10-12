/**
 * Headless-only `app:*` handlers for Electron behaviour that has no server-side equivalent.
 *
 * `app:rendererHeartbeat` feeds Electron's renderer-hang watchdog (`rendererHeartbeatWatchdog.ts`),
 * which tracks a local window across sleep/wake. A browser tab has no such window here, so the
 * heartbeat is accepted (sender still validated) and dropped instead of erroring every 30 s.
 */
import { ipcMain } from 'electron';

import { validateIpcSender } from '../validate-ipc-sender';

export function registerHeadlessAppHandlers(): void {
  ipcMain.handle('app:rendererHeartbeat', (event) => {
    if (!validateIpcSender(event)) return;
  });
}
