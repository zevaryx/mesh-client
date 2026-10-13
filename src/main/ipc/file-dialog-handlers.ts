/**
 * IPC handlers that open file dialogs: database export / import, log + support-bundle export,
 * chat / MECP / GPX export, Reticulum attachment save, Meshtastic XMODEM pick / save and the
 * MeshCore contacts JSON import.
 *
 * Moved from `src/main/index.ts`; registered by the Electron main process and the headless
 * server. On Electron the dialogs are native; headless, the calling browser serves them (upload /
 * download, see `headless/fileTransfer.ts`).
 */
import { app, type BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import { MS_PER_MINUTE } from '../../shared/timeConstants';
import {
  assertChatExportMessageSizes,
  formatChatExportLinesWithTotalCap,
} from '../chatExportFormat';
import { exportDatabase, isDatabaseSchemaTooNewError, mergeDatabase } from '../database';
import { finishDbIpcHandler, getDbForIpc } from '../db-ipc-lifecycle';
import { formatDatabaseSchemaTooNewMessage, showFatalStartupError } from '../fatal-startup-dialog';
import { formatGpxTracks, GPX_EXPORT_MAX_POINTS } from '../gpxExportFormat';
import { createIpcRateLimiter } from '../ipcRateLimit';
import { exportLogTo, getLogPath, sanitizeLogMessage } from '../log-service';
import { readMecpReceivedLogForExport } from '../mecp-received-log';
import { readFileUpTo } from '../readFileUpTo';
import { errorMessageText } from '../sanitize-log-message';
import {
  buildSupportBundleZip,
  defaultSupportBundleFilename,
  isSupportBundleMode,
} from '../support-bundle';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';

/** Max bytes for Meshtastic Xmodem file upload (DoS guard; matches meshcore:openJsonFile). */
const MESHTASTIC_XMODEM_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Export / import dialogs — max 5 / 60s. */
const exportIpcRateLimit = createIpcRateLimiter({
  max: 5,
  windowMs: MS_PER_MINUTE,
  label: 'export',
});

const CHAT_EXPORT_MAX_MESSAGES = 10_000;

export interface FileDialogIpcDeps {
  /** Dialog parent; handlers return their "no window" result when it is null. */
  getMainWindow: () => BrowserWindow | null;
}

/** Register the file-dialog handlers. Channel name literals keep check:ipc-contract aligned. */
export function registerFileDialogIpcHandlers({ getMainWindow }: FileDialogIpcDeps): void {
  // ─── IPC: Export database ───────────────────────────────────────────
  ipcMain.handle('db:export', async (event) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('db:export: unauthorized sender');
    exportIpcRateLimit.checkOrThrow();
    try {
      if (!getDbForIpc('db:export')) return null;
      if (!mainWindow) return null;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Database',
        defaultPath: `mesh-client-backup-${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      });
      if (!result.canceled && result.filePath) {
        exportDatabase(result.filePath);
        return result.filePath;
      }
      return null;
    } catch (err) {
      finishDbIpcHandler('db:export', err);
    }
  });

  // ─── IPC: Import / merge database ───────────────────────────────────
  ipcMain.handle('db:import', async (event) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('db:import: unauthorized sender');
    exportIpcRateLimit.checkOrThrow();
    try {
      if (!getDbForIpc('db:import')) return null;
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Database',
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
        properties: ['openFile'],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        return mergeDatabase(result.filePaths[0]);
      }
      return null;
    } catch (err) {
      if (isDatabaseSchemaTooNewError(err)) {
        showFatalStartupError(
          'Mesh-Client — Import Blocked',
          formatDatabaseSchemaTooNewMessage(err),
        );
      }
      finishDbIpcHandler('db:import', err);
    }
  });

  ipcMain.handle('log:export', async (event) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    exportIpcRateLimit.checkOrThrow();
    try {
      if (!mainWindow) return null;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export log',
        defaultPath: `mesh-client-log-${new Date().toISOString().slice(0, 10)}.log`,
        filters: [{ name: 'Log file', extensions: ['log', 'txt'] }],
      });
      if (!result.canceled && result.filePath) {
        const src = getLogPath();
        if (!fs.existsSync(src)) {
          await fs.promises.writeFile(result.filePath, '', 'utf8');
        } else {
          await exportLogTo(result.filePath);
        }
        return result.filePath;
      }
      return null;
    } catch (err) {
      console.error('[IPC] log:export failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle(
    'support:exportBundle',
    async (event, mode: unknown, debugSnapshotJson: unknown) => {
      const mainWindow = getMainWindow();
      if (!validateIpcSender(event)) {
        throw new Error('IPC sender validation failed');
      }
      exportIpcRateLimit.checkOrThrow();
      if (!isSupportBundleMode(mode)) {
        throw new Error('support:exportBundle: invalid mode');
      }
      if (typeof debugSnapshotJson !== 'string') {
        throw new Error('support:exportBundle: debugSnapshotJson must be a string');
      }
      try {
        if (mode === 'developer' && !getDbForIpc('support:exportBundle')) return null;
        if (!mainWindow) return null;
        const title =
          mode === 'github'
            ? 'Export support bundle for GitHub'
            : 'Export support bundle for developer';
        const result = await dialog.showSaveDialog(mainWindow, {
          title,
          defaultPath: defaultSupportBundleFilename(mode),
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        });
        if (!result.canceled && result.filePath) {
          await buildSupportBundleZip(result.filePath, mode, debugSnapshotJson);
          return result.filePath;
        }
        return null;
      } catch (err) {
        console.error(
          '[IPC] support:exportBundle failed:',
          sanitizeLogMessage(errorMessageText(err)),
        );
        throw err;
      }
    },
  );

  ipcMain.handle('chat:export', async (event, messages: unknown) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    exportIpcRateLimit.checkOrThrow();
    if (!Array.isArray(messages)) throw new Error('messages must be an array');
    if (messages.length > CHAT_EXPORT_MAX_MESSAGES) {
      throw new Error(`chat:export: too many messages (max ${CHAT_EXPORT_MAX_MESSAGES})`);
    }
    assertChatExportMessageSizes(messages);
    if (!mainWindow) return { success: false };
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export chat',
        defaultPath: `mesh-chat-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: 'Text file', extensions: ['txt'] }],
      });
      if (result.canceled || !result.filePath) return { success: false };
      const text = formatChatExportLinesWithTotalCap(messages);
      await fs.promises.writeFile(result.filePath, text, 'utf8');
      return { success: true, path: result.filePath };
    } catch (err) {
      console.error('[IPC] chat:export failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle('mecp:exportReceivedLog', async (event) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    exportIpcRateLimit.checkOrThrow();
    if (!mainWindow) return { success: false as const, reason: 'error' as const };
    try {
      const text = await readMecpReceivedLogForExport();
      if (!text.trim()) return { success: false as const, reason: 'empty' as const };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export MECP received log',
        defaultPath: `mecp-received-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [
          { name: 'Text file', extensions: ['txt'] },
          { name: 'JSON Lines', extensions: ['jsonl'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false as const, reason: 'cancelled' as const };
      }
      await fs.promises.writeFile(result.filePath, text, 'utf8');
      return { success: true as const, path: result.filePath };
    } catch (err) {
      console.error(
        '[IPC] mecp:exportReceivedLog failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('gps:exportGpx', async (event, opts: unknown) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    const o = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
    const nodeId = typeof o.nodeId === 'number' && Number.isFinite(o.nodeId) ? o.nodeId : undefined;
    const sinceMs =
      typeof o.sinceMs === 'number' && Number.isFinite(o.sinceMs) && o.sinceMs >= 0 ? o.sinceMs : 0;
    try {
      const db = getDbForIpc('gps:exportGpx');
      if (!db) return { success: false, reason: 'no_db' as const };
      if (!mainWindow) return { success: false, reason: 'no_window' as const };
      let rows: {
        node_id: number;
        latitude: number;
        longitude: number;
        recorded_at: number;
        source: string;
      }[];
      if (nodeId !== undefined) {
        rows = db
          .prepareOnce(
            'SELECT node_id, latitude, longitude, recorded_at, source FROM position_history WHERE recorded_at >= ? AND node_id = ? ORDER BY recorded_at ASC LIMIT ?',
          )
          .all(sinceMs, nodeId, GPX_EXPORT_MAX_POINTS) as typeof rows;
      } else {
        rows = db
          .prepareOnce(
            'SELECT node_id, latitude, longitude, recorded_at, source FROM position_history WHERE recorded_at >= ? ORDER BY node_id, recorded_at ASC LIMIT ?',
          )
          .all(sinceMs, GPX_EXPORT_MAX_POINTS) as typeof rows;
      }
      if (rows.length === 0) return { success: false, reason: 'empty' as const };
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export GPX',
        defaultPath: `mesh-track-${new Date().toISOString().slice(0, 10)}.gpx`,
        filters: [{ name: 'GPX', extensions: ['gpx'] }],
      });
      if (result.canceled || !result.filePath)
        return { success: false, reason: 'cancelled' as const };
      const xml = formatGpxTracks(rows);
      await fs.promises.writeFile(result.filePath, xml, 'utf8');
      return { success: true, path: result.filePath };
    } catch (err) {
      console.error('[IPC] gps:exportGpx failed:', sanitizeLogMessage(errorMessageText(err)));
      throw err;
    }
  });

  ipcMain.handle('chat:saveReticulumAttachment', async (event, opts: unknown) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    if (!opts || typeof opts !== 'object') throw new Error('opts must be an object');
    const o = opts as Record<string, unknown>;
    const fileName = typeof o.fileName === 'string' ? path.basename(o.fileName) : 'attachment';
    const dataBase64 = typeof o.dataBase64 === 'string' ? o.dataBase64 : '';
    const promptSave = o.promptSave !== false;
    if (!dataBase64 || dataBase64.length > 16 * 1024 * 1024) {
      throw new Error('dataBase64 invalid or too large');
    }
    try {
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length > 16 * 1024 * 1024) throw new Error('decoded attachment too large');
      let targetPath: string;
      if (promptSave) {
        if (!mainWindow) return { success: false };
        const ext = path.extname(fileName) || '';
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save attachment',
          defaultPath: fileName,
          filters: ext ? [{ name: ext.slice(1), extensions: [ext.slice(1)] }] : undefined,
        });
        if (result.canceled || !result.filePath) return { success: false };
        targetPath = result.filePath;
      } else {
        const dir = path.join(app.getPath('userData'), 'reticulum', 'attachments');
        await fs.promises.mkdir(dir, { recursive: true });
        const safeName = fileName.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'attachment';
        targetPath = path.join(dir, `${Date.now()}-${safeName}`);
      }
      await fs.promises.writeFile(targetPath, buf);
      return { success: true, path: targetPath };
    } catch (err) {
      console.error(
        '[IPC] chat:saveReticulumAttachment failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('meshtastic:xmodemPickUpload', async (event) => {
    const mainWindow = getMainWindow();
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    if (!mainWindow) return null;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select file to upload',
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const filePath = result.filePaths[0];
      let data: Buffer;
      try {
        data = await readFileUpTo(filePath, MESHTASTIC_XMODEM_UPLOAD_MAX_BYTES);
      } catch (err) {
        if (err instanceof Error && err.message === 'File too large') {
          throw new Error(
            `File too large (max ${MESHTASTIC_XMODEM_UPLOAD_MAX_BYTES / (1024 * 1024)} MB)`,
          );
        }
        throw err;
      }
      const filename = path.basename(filePath);
      return { filename, data: new Uint8Array(data) };
    } catch (err) {
      console.error(
        '[IPC] meshtastic:xmodemPickUpload failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });

  ipcMain.handle(
    'meshtastic:xmodemSaveDownload',
    async (event, filename: unknown, data: unknown) => {
      const mainWindow = getMainWindow();
      if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
      if (typeof filename !== 'string' || filename.length === 0 || filename.length > 256) {
        throw new Error('meshtastic:xmodemSaveDownload: invalid filename');
      }
      if (!(data instanceof Uint8Array) || data.length === 0) {
        throw new Error('meshtastic:xmodemSaveDownload: data must be non-empty Uint8Array');
      }
      if (!mainWindow) return { success: false };
      try {
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save downloaded file',
          defaultPath: path.basename(filename),
        });
        if (result.canceled || !result.filePath) return { success: false };
        await fs.promises.writeFile(result.filePath, data);
        return { success: true, path: result.filePath };
      } catch (err) {
        console.error(
          '[IPC] meshtastic:xmodemSaveDownload failed:',
          sanitizeLogMessage(errorMessageText(err)),
        );
        throw err;
      }
    },
  );

  ipcMain.handle('meshcore:openJsonFile', async (event) => {
    const mainWindow = getMainWindow();
    assertIpcSender(event, 'meshcore:openJsonFile');
    try {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import Contacts JSON',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const raw = await fs.promises.readFile(result.filePaths[0], 'utf-8');
      if (raw.length > 5 * 1024 * 1024) throw new Error('File too large (max 5 MB)');
      return raw;
    } catch (err) {
      console.error(
        '[IPC] meshcore:openJsonFile failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });
}
