/**
 * Log panel IPC (`log:*`). Moved verbatim from `src/main/index.ts`; registered by the Electron
 * main process and the headless server (which opens the same log file under its data dir).
 */
import { ipcMain } from 'electron';

import {
  clearLogFile,
  getLogPath,
  getRecentLines,
  logDeviceConnection,
  sanitizeLogMessage,
} from '../log-service';
import { errorMessageText } from '../sanitize-log-message';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';

/** Register `log:*`. Channel name literals keep check:ipc-contract aligned. */
export function registerLogIpcHandlers(): void {
  ipcMain.handle('log:getPath', (event) => {
    assertIpcSender(event, 'log:getPath');
    try {
      return getLogPath();
    } catch (err) {
      console.error('[IPC] log:getPath failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle('log:getRecentLines', (event) => {
    assertIpcSender(event, 'log:getRecentLines');
    try {
      return getRecentLines();
    } catch (err) {
      console.error('[IPC] log:getRecentLines failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle('log:clear', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      clearLogFile();
    } catch (err) {
      console.error('[IPC] log:clear failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle('log:device-connection', (event, detail: unknown) => {
    if (!validateIpcSender(event)) return;
    if (typeof detail !== 'string' || detail.length > 8192) return;
    logDeviceConnection(detail);
  });
}
