/**
 * Headless-only answers for Electron window / OS behaviour that has no server-side equivalent, so
 * the renderer gets a defined result instead of "No handler registered". Sender checks still run.
 *
 * - `app:rendererHeartbeat` feeds Electron's renderer-hang watchdog (`rendererHeartbeatWatchdog.ts`),
 *   which tracks a local window across sleep/wake. A browser tab has no such window here, so the
 *   heartbeat is accepted and dropped instead of erroring every 30 s.
 * - Window chrome (`app:requestAttention`, `app:showEmojiPanel`, tray badge) and login items do
 *   nothing: there is no window or OS session on the server. The renderer hides the matching
 *   controls when `electronAPI.hostKind === 'web'`.
 * - `app:quit` / `app:relaunch` reject: one browser must not stop a server other tabs and the
 *   background ingest rely on. Stop the container or process instead.
 * - `media:ensure*Access` report granted: the browser asks the viewer itself on `getUserMedia`.
 * - `chat:showItemInFolder` reports `ok: false`: the file is on the server (Save… downloads it).
 * - Electron chooser / power-save signals (`serial-port-*`, `device-*`) are dropped: Web Serial has
 *   its own chooser in the browser and the server has no close-prevention or power-save blocker.
 *
 * Clipboard, window focus and session-data clearing run in the browser instead
 * (`preload/web/browserLocalInvokes.ts`), so they never reach the server.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';

import type { RendererLivenessSnapshot } from '../../shared/electron-api.types';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';

/** Invoke channels answered here, without a ported Electron handler. */
export const HEADLESS_WINDOW_INVOKE_CHANNELS = [
  'app:rendererHeartbeat',
  'app:requestAttention',
  'app:showEmojiPanel',
  'app:getLoginItem',
  'app:setLoginItem',
  'app:quit',
  'app:relaunch',
  'app:getProcessUptimeSec',
  'app:getRendererLiveness',
  'media:ensureMicrophoneAccess',
  'media:ensureCameraAccess',
  'chat:showItemInFolder',
] as const;

/** Fire-and-forget channels dropped here (Electron chooser / tray / power-save signals). */
export const HEADLESS_DROPPED_SEND_CHANNELS = [
  'set-tray-unread',
  'device-connected',
  'device-disconnected',
  'serial-port-selected',
  'serial-port-cancelled',
  // Electron's Web Bluetooth pairing prompt (setBluetoothPairingHandler); LoRa BLE pairs through
  // the sidecar or bluetoothctl instead, so there is never a pending prompt to answer.
  'bluetooth-provide-pin',
  'bluetooth-cancel-pairing',
  'ble-reset-pairing-retry-count',
] as const;

export const HEADLESS_QUIT_UNAVAILABLE =
  'quitting is not available from a browser; stop the mesh-client server instead';

function noopInvoke(channel: string): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent) => {
    assertIpcSender(event, channel);
  });
}

function dropSend(channel: string): void {
  ipcMain.on(channel, (event: IpcMainEvent) => {
    if (!validateIpcSender(event)) console.warn(`[headless] ${channel}: unauthorized sender`);
  });
}

export function registerHeadlessAppHandlers(): void {
  ipcMain.handle('app:rendererHeartbeat', (event) => {
    if (!validateIpcSender(event)) return;
  });

  noopInvoke('app:requestAttention');
  noopInvoke('app:showEmojiPanel');
  ipcMain.handle('app:getLoginItem', (event) => {
    assertIpcSender(event, 'app:getLoginItem');
    return { openAtLogin: false };
  });
  noopInvoke('app:setLoginItem');
  for (const channel of ['app:quit', 'app:relaunch']) {
    ipcMain.handle(channel, (event) => {
      assertIpcSender(event, channel);
      throw new Error(HEADLESS_QUIT_UNAVAILABLE);
    });
  }

  ipcMain.handle('app:getProcessUptimeSec', (event) => {
    assertIpcSender(event, 'app:getProcessUptimeSec');
    return Math.floor(process.uptime());
  });
  ipcMain.handle('app:getRendererLiveness', (event): RendererLivenessSnapshot => {
    assertIpcSender(event, 'app:getRendererLiveness');
    const mem = process.memoryUsage();
    return {
      mainUptimeSec: Math.floor(process.uptime()),
      lastRendererHeartbeatAgeMs: null,
      rendererUnresponsiveSeen: false,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
    };
  });

  for (const channel of ['media:ensureMicrophoneAccess', 'media:ensureCameraAccess']) {
    ipcMain.handle(channel, (event) => {
      assertIpcSender(event, channel);
      return { granted: true, status: 'granted' };
    });
  }

  // Files live on the server; a browser cannot open its file manager (Save… downloads instead).
  ipcMain.handle('chat:showItemInFolder', (event) => {
    assertIpcSender(event, 'chat:showItemInFolder');
    return { ok: false };
  });

  for (const channel of HEADLESS_DROPPED_SEND_CHANNELS) dropSend(channel);
}
