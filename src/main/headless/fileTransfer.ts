/**
 * Headless file transfer: lets unchanged main-process handlers use `dialog.showOpenDialog` /
 * `showSaveDialog` with the viewer's browser standing in for the native dialog.
 *
 * - Open: the server pushes `headless:pickFiles` to the calling session; the browser uploads each
 *   picked file (`POST /files/upload/<requestId>?name=…`) then completes
 *   (`POST /files/complete/<requestId>`). The handler receives staged server paths.
 * - Save: the handler gets a staged path to write. When its invoke succeeds the server pushes
 *   `headless:download`, and the browser fetches `GET /files/download/<id>` once.
 *
 * Failure points and cleanup: uploads larger than `maxUploadBytes` get 413 and fail the pick; a
 * pick not completed within PICK_TIMEOUT_MS resolves as cancelled. Staged downloads of a failed
 * invoke are deleted, served downloads are deleted after streaming, and unclaimed ones expire.
 * Uploaded files stay for the session (a picked "file to send" is used by a later call), at most
 * UPLOAD_MAX_AGE_MS, and are deleted when the session closes. Every staging directory comes from
 * `mkdtemp` under the OS temp dir.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { MS_PER_MINUTE } from '../../shared/timeConstants';
import {
  sanitizeTransferFileName,
  WEB_BRIDGE_DOWNLOAD_EVENT,
  WEB_BRIDGE_FILES_PATH,
  WEB_BRIDGE_PICK_FILES_EVENT,
  type WebBridgeDownloadNotice,
  type WebBridgePickFilesRequest,
} from '../../shared/webBridgeProtocol';
import { sanitizeLogMessage } from '../sanitize-log-message';
import type { HeadlessCallContext, HeadlessFilePickOptions } from './callContext';

export const PICK_TIMEOUT_MS = 15 * MS_PER_MINUTE;
export const DOWNLOAD_TTL_MS = 10 * MS_PER_MINUTE;
export const UPLOAD_MAX_AGE_MS = 60 * MS_PER_MINUTE;
const SWEEP_INTERVAL_MS = MS_PER_MINUTE;
const MAX_FILES_PER_PICK = 32;
const MAX_COMPLETE_BODY_BYTES = 4096;

type SendToSession = (channel: string, payload: unknown) => void;

interface PendingPick {
  sessionId: number;
  dir: string;
  files: string[];
  bytes: number;
  resolve: (paths: string[] | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface UploadDir {
  sessionId: number;
  dir: string;
  createdAt: number;
}

interface StagedDownload {
  dir: string;
  filePath: string;
  fileName: string;
}

interface ReadyDownload extends StagedDownload {
  sessionId: number;
  expiresAt: number;
}

/** What `finishCall` needs back from `createCall`. */
export interface HeadlessCallHandle {
  context: HeadlessCallContext;
  staged: StagedDownload[];
  send: SendToSession;
}

function newId(): string {
  return randomBytes(16).toString('hex');
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      '[headless] could not remove transfer dir:',
      sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
    );
  }
}

function sendJson(res: http.ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Electron dialog filters → `accept` for `<input type=file>` (`.p12,.pem`); empty for "any". */
export function filtersToAccept(filters: unknown): string {
  if (!Array.isArray(filters)) return '';
  const exts = new Set<string>();
  for (const f of filters) {
    const list = (f as { extensions?: unknown } | null)?.extensions;
    if (!Array.isArray(list)) continue;
    for (const ext of list) {
      if (typeof ext !== 'string' || ext === '*' || !/^[A-Za-z0-9._-]{1,16}$/.test(ext)) {
        return ''; // an "All files" entry (or anything odd) means no restriction
      }
      exts.add(`.${ext.replace(/^\./, '')}`);
    }
  }
  return [...exts].join(',');
}

export class HeadlessFileTransfer {
  private readonly picks = new Map<string, PendingPick>();
  private readonly uploads: UploadDir[] = [];
  private readonly downloads = new Map<string, ReadyDownload>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly maxUploadBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Context for one bridge invoke from `sessionId`; pass the handle to `finishCall`. */
  createCall(sessionId: number, send: SendToSession): HeadlessCallHandle {
    const staged: StagedDownload[] = [];
    const context: HeadlessCallContext = {
      sessionId,
      requestFiles: (opts) => this.requestFiles(sessionId, send, opts),
      stageDownload: (fileName) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-dl-'));
        const safe = sanitizeTransferFileName(fileName, 'download');
        const filePath = path.join(dir, safe);
        staged.push({ dir, filePath, fileName: safe });
        return filePath;
      },
    };
    return { context, staged, send };
  }

  /** After the invoke settles: deliver written downloads on success, discard them otherwise. */
  finishCall(handle: HeadlessCallHandle, succeeded: boolean): void {
    for (const item of handle.staged) {
      let size = -1;
      try {
        size = fs.statSync(item.filePath).size;
      } catch {
        // catch-no-log-ok handler chose not to write (e.g. nothing to export): nothing to deliver
      }
      if (!succeeded || size < 0) {
        removeDir(item.dir);
        continue;
      }
      const id = newId();
      this.downloads.set(id, {
        ...item,
        sessionId: handle.context.sessionId,
        expiresAt: this.now() + DOWNLOAD_TTL_MS,
      });
      const notice: WebBridgeDownloadNotice = { id, fileName: item.fileName, size };
      handle.send(WEB_BRIDGE_DOWNLOAD_EVENT, notice);
    }
  }

  private requestFiles(
    sessionId: number,
    send: SendToSession,
    opts: HeadlessFilePickOptions,
  ): Promise<string[] | null> {
    const requestId = newId();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-up-'));
    return new Promise<string[] | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn('[headless] file pick timed out; treating as cancelled');
        this.settlePick(requestId, { canceled: true });
      }, PICK_TIMEOUT_MS);
      timer.unref();
      this.picks.set(requestId, { sessionId, dir, files: [], bytes: 0, resolve, reject, timer });
      const request: WebBridgePickFilesRequest = {
        requestId,
        multiple: opts.multiple,
        accept: opts.accept,
        ...(opts.title ? { title: opts.title } : {}),
      };
      send(WEB_BRIDGE_PICK_FILES_EVENT, request);
    });
  }

  private settlePick(requestId: string, result: { canceled: boolean; error?: string }): void {
    const pick = this.picks.get(requestId);
    if (!pick) return;
    this.picks.delete(requestId);
    clearTimeout(pick.timer);
    if (result.error !== undefined) {
      removeDir(pick.dir);
      pick.reject(new Error(`file upload failed: ${result.error}`));
      return;
    }
    if (result.canceled || pick.files.length === 0) {
      removeDir(pick.dir);
      pick.resolve(null);
      return;
    }
    this.uploads.push({ sessionId: pick.sessionId, dir: pick.dir, createdAt: this.now() });
    pick.resolve([...pick.files]);
  }

  /** Session closed: cancel its picks and delete its uploads and undelivered downloads. */
  closeSession(sessionId: number): void {
    for (const [id, pick] of this.picks) {
      if (pick.sessionId === sessionId) this.settlePick(id, { canceled: true });
    }
    for (let i = this.uploads.length - 1; i >= 0; i--) {
      const up = this.uploads[i];
      if (up?.sessionId === sessionId) {
        removeDir(up.dir);
        this.uploads.splice(i, 1);
      }
    }
    for (const [id, dl] of this.downloads) {
      if (dl.sessionId === sessionId) {
        removeDir(dl.dir);
        this.downloads.delete(id);
      }
    }
  }

  sweep(): void {
    const now = this.now();
    for (const [id, dl] of this.downloads) {
      if (dl.expiresAt <= now) {
        removeDir(dl.dir);
        this.downloads.delete(id);
      }
    }
    for (let i = this.uploads.length - 1; i >= 0; i--) {
      const up = this.uploads[i];
      if (up && now - up.createdAt >= UPLOAD_MAX_AGE_MS) {
        removeDir(up.dir);
        this.uploads.splice(i, 1);
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const id of [...this.picks.keys()]) this.settlePick(id, { canceled: true });
    for (const up of this.uploads.splice(0)) removeDir(up.dir);
    for (const dl of this.downloads.values()) removeDir(dl.dir);
    this.downloads.clear();
  }

  /** Handle `/files/*` (already authenticated by the caller); false when the path is not ours. */
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    const prefix = `${WEB_BRIDGE_FILES_PATH}/`;
    if (!url.pathname.startsWith(prefix)) return false;
    const [action, id, ...rest] = url.pathname.slice(prefix.length).split('/');
    if (!action || !id || rest.length > 0 || !/^[0-9a-f]{32}$/.test(id)) {
      sendJson(res, 404);
      return true;
    }
    if (action === 'upload' && req.method === 'POST') {
      this.handleUpload(req, res, id, url);
      return true;
    }
    if (action === 'complete' && req.method === 'POST') {
      this.handleComplete(req, res, id);
      return true;
    }
    if (action === 'download' && req.method === 'GET') {
      this.handleDownload(res, id);
      return true;
    }
    sendJson(res, 405);
    return true;
  }

  private handleUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
    url: URL,
  ): void {
    const pick = this.picks.get(id);
    if (!pick) {
      sendJson(res, 404);
      req.resume();
      return;
    }
    if (pick.files.length >= MAX_FILES_PER_PICK) {
      sendJson(res, 413, { error: 'too many files' });
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && pick.bytes + declared > this.maxUploadBytes) {
      sendJson(res, 413, { error: `upload exceeds ${this.maxUploadBytes} bytes` });
      req.resume();
      return;
    }
    // One sub-directory per file keeps each picked file's own base name (handlers use it).
    const fileDir = path.join(pick.dir, String(pick.files.length));
    fs.mkdirSync(fileDir);
    const filePath = path.join(fileDir, sanitizeTransferFileName(url.searchParams.get('name')));
    const out = fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 });
    let written = 0;
    let failed = false;
    const fail = (status: number, message: string): void => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rmSync(fileDir, { recursive: true, force: true });
      sendJson(res, status, { error: message });
    };
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (pick.bytes + written > this.maxUploadBytes) {
        req.pause();
        fail(413, `upload exceeds ${this.maxUploadBytes} bytes`);
      }
    });
    req.on('error', (err) => {
      fail(400, err.message);
    });
    out.on('error', (err) => {
      console.error('[headless] upload write failed:', sanitizeLogMessage(err.message));
      fail(500, 'write failed');
    });
    out.on('finish', () => {
      if (failed) return;
      // The pick may have been cancelled (timeout / session close) while bytes were arriving.
      if (!this.picks.has(id)) {
        sendJson(res, 404);
        return;
      }
      pick.bytes += written;
      pick.files.push(filePath);
      sendJson(res, 204);
    });
    req.pipe(out);
  }

  private handleComplete(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_COMPLETE_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (!this.picks.has(id)) {
        sendJson(res, 404);
        return;
      }
      let body: { canceled?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body;
      } catch {
        // catch-no-log-ok malformed completion is answered with 400 below
        sendJson(res, 400);
        return;
      }
      this.settlePick(id, {
        canceled: body.canceled === true,
        ...(typeof body.error === 'string' ? { error: body.error.slice(0, 200) } : {}),
      });
      sendJson(res, 204);
    });
  }

  private handleDownload(res: http.ServerResponse, id: string): void {
    const dl = this.downloads.get(id);
    if (!dl || dl.expiresAt <= this.now()) {
      sendJson(res, 404);
      return;
    }
    // One-shot: claim before streaming so a second request cannot race the same file.
    this.downloads.delete(id);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(dl.fileName)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(dl.filePath);
    stream.on('error', (err) => {
      console.error('[headless] download read failed:', sanitizeLogMessage(err.message));
      res.destroy();
    });
    res.on('close', () => {
      removeDir(dl.dir);
    });
    stream.pipe(res);
  }
}
