/**
 * Chat content IPC: MECP received-report log, Reticulum attachment reads, link previews. Moved
 * verbatim from `src/main/index.ts`; registered by the Electron main process and the headless
 * server. (`chat:showItemInFolder` stays desktop-only: headless answers it in
 * `headless/headlessAppHandlers.ts`.)
 */
import { ipcMain } from 'electron';

import { fetchLinkPreview } from '../fetchLinkPreview';
import { sanitizeLogMessage } from '../log-service';
import { appendMecpReceivedLog, isValidMecpAppendPayload } from '../mecp-received-log';
import {
  readReticulumAttachmentBytes,
  takeReticulumAttachmentAudioRateToken,
} from '../reticulum-attachment-audio';
import {
  readReticulumAttachmentAsDataUrl,
  takeReticulumAttachmentImageRateToken,
} from '../reticulum-attachment-image';
import { errorMessageText } from '../sanitize-log-message';
import { validateIpcSender } from '../validate-ipc-sender';

/** Register chat content handlers. Channel name literals keep check:ipc-contract aligned. */
export function registerChatContentIpcHandlers(): void {
  ipcMain.handle('mecp:appendReceived', async (event, entry: unknown) => {
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    if (!isValidMecpAppendPayload(entry)) {
      throw new Error('mecp:appendReceived: invalid entry');
    }
    await appendMecpReceivedLog(entry);
    return { ok: true as const };
  });

  ipcMain.handle('chat:readReticulumAttachmentAsDataUrl', async (event, opts: unknown) => {
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    if (!opts || typeof opts !== 'object') throw new Error('opts must be an object');
    const o = opts as Record<string, unknown>;
    if (typeof o.filePath !== 'string' || !o.filePath.trim() || o.filePath.length > 512) {
      throw new Error('filePath must be a non-empty string');
    }
    // Optional mimeType on the wire is ignored — magic bytes alone decide embed MIME.
    if (!takeReticulumAttachmentImageRateToken()) {
      console.debug('[IPC] chat:readReticulumAttachmentAsDataUrl rate limited');
      return { dataUrl: null };
    }
    try {
      const dataUrl = await readReticulumAttachmentAsDataUrl(o.filePath);
      return { dataUrl };
    } catch (err) {
      console.error(
        '[IPC] chat:readReticulumAttachmentAsDataUrl failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('chat:readReticulumAttachmentBytes', async (event, filePath: unknown) => {
    if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 512) {
      throw new Error('filePath must be a non-empty string');
    }
    if (!takeReticulumAttachmentAudioRateToken()) {
      console.debug('[IPC] chat:readReticulumAttachmentBytes rate limited');
      return { dataBase64: null };
    }
    try {
      const dataBase64 = await readReticulumAttachmentBytes(filePath);
      return { dataBase64 };
    } catch (err) {
      console.error(
        '[IPC] chat:readReticulumAttachmentBytes failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('chat:fetchLinkPreview', async (event, url: unknown) => {
    if (!validateIpcSender(event)) throw new Error('chat:fetchLinkPreview: unauthorized sender');
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
    return await fetchLinkPreview(url);
  });
}
