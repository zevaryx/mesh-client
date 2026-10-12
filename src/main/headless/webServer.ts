/**
 * HTTP + WebSocket front end of the headless server.
 *
 * - Serves the Vite renderer build (`dist/renderer`) and injects `/web-bridge.js` into
 *   `index.html`, which defines `window.electronAPI` before the app module runs.
 * - Accepts bridge sessions on `/ipc` (token-authenticated) and dispatches `invoke` / `send`
 *   frames into the {@link HeadlessIpcRegistry}.
 * - Broadcasts `webContents.send` pushes to every open session.
 *
 * Failure points: a malformed or oversized frame is dropped and logged (the session stays open);
 * a handler that throws becomes an `error` frame for that invoke only.
 */
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import WebSocket, { WebSocketServer } from 'ws';

import {
  normalizeHeadlessHostPlatform,
  parseWebBridgeClientFrame,
  serializeWebBridgeFrame,
  WEB_BRIDGE_FILES_PATH,
  WEB_BRIDGE_MAX_FRAME_BYTES,
  WEB_BRIDGE_PLATFORM_META,
  WEB_BRIDGE_SCRIPT_PATH,
  WEB_BRIDGE_TOKEN_PARAM,
  WEB_BRIDGE_WS_PATH,
  type WebBridgeServerFrame,
} from '../../shared/webBridgeProtocol';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { runInHeadlessCall } from './callContext';
import { HeadlessFileTransfer } from './fileTransfer';
import {
  HEADLESS_SENDER_URL,
  type HeadlessIpcEvent,
  type HeadlessIpcRegistry,
} from './ipcRegistry';

export interface HeadlessWebServerOptions {
  registry: HeadlessIpcRegistry;
  /** Directory holding the Vite renderer build (`index.html`, `assets/`, …). */
  rendererDir: string;
  /** Path of the bundled browser bridge served at `/web-bridge.js`. */
  bridgeScriptFile: string;
  /** Shared session token; `null` disables auth (only for trusted, isolated networks). */
  token: string | null;
  host: string;
  port: number;
  /** OS reported to the renderer as `getPlatform()`; defaults to this process's platform. */
  platform?: string;
  /** Total bytes one browser file pick may upload (default {@link HEADLESS_DEFAULT_MAX_UPLOAD_BYTES}). */
  maxUploadBytes?: number;
  /** Called with the new count whenever a bridge session opens or closes. */
  onSessionCountChange?: (count: number) => void;
}

export const HEADLESS_DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** `Authorization: Bearer <token>` for the file-transfer endpoints. */
function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}

export interface HeadlessWebServer {
  listen: () => Promise<AddressInfo>;
  close: () => Promise<void>;
  broadcast: (channel: string, args: unknown[]) => void;
  sessionCount: () => number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  // The first page load can carry the session token in its query string.
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Constant-time token comparison (length mismatch still returns false). */
export function headlessTokenMatches(expected: string, provided: string | null): boolean {
  if (provided === null) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Inject the bridge script ahead of the renderer's module entry. */
export function injectWebBridgeScript(indexHtml: string, platform: string): string {
  const tag =
    `<meta name="${WEB_BRIDGE_PLATFORM_META}" content="${normalizeHeadlessHostPlatform(platform)}" />` +
    `<script src="${WEB_BRIDGE_SCRIPT_PATH}"></script>`;
  const firstScript = indexHtml.indexOf('<script');
  if (firstScript === -1) return indexHtml.replace('</head>', `    ${tag}\n  </head>`);
  return `${indexHtml.slice(0, firstScript)}${tag}\n    ${indexHtml.slice(firstScript)}`;
}

/**
 * Resolve a request path inside `rootDir`; `null` when it escapes the root or is not a file.
 * Extension-less misses fall back to `index.html` (client-side routes).
 */
export function resolveStaticFile(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // catch-no-log-ok malformed percent-encoding is a 400-equivalent miss
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      return fs.existsSync(index) ? index : null;
    }
  } catch {
    // catch-no-log-ok missing file falls through to the SPA fallback below
  }
  return path.extname(decoded) === '' ? path.join(root, 'index.html') : null;
}

function sendPlain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

export function createHeadlessWebServer(options: HeadlessWebServerOptions): HeadlessWebServer {
  const { registry, rendererDir, bridgeScriptFile, token, host, port } = options;
  const platform = options.platform ?? process.platform;
  const sessions = new Set<WebSocket>();
  const transfer = new HeadlessFileTransfer(
    options.maxUploadBytes ?? HEADLESS_DEFAULT_MAX_UPLOAD_BYTES,
  );
  let nextSessionId = 1;
  let indexHtmlCache: string | null = null;

  const readIndexHtml = (): string => {
    indexHtmlCache ??= injectWebBridgeScript(
      fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8'),
      platform,
    );
    return indexHtmlCache;
  };

  const serveFile = (res: http.ServerResponse, file: string): void => {
    const ext = path.extname(file).toLowerCase();
    const isIndex = path.resolve(file) === path.resolve(rendererDir, 'index.html');
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      // Hashed Vite assets are immutable; HTML and the bridge must revalidate.
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    if (isIndex) {
      res.writeHead(200, headers);
      res.end(readIndexHtml());
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.warn('[headless] static read failed:', sanitizeLogMessage(err.message));
      if (!res.headersSent) sendPlain(res, 500, 'Internal Server Error');
      else res.destroy();
    });
    res.writeHead(200, headers);
    stream.pipe(res);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://headless.invalid');
    if (url.pathname.startsWith(`${WEB_BRIDGE_FILES_PATH}/`)) {
      if (token !== null && !headlessTokenMatches(token, bearerToken(req))) {
        req.resume();
        sendPlain(res, 401, 'Unauthorized');
        return;
      }
      if (!transfer.handleHttp(req, res, url)) sendPlain(res, 404, 'Not Found');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendPlain(res, 405, 'Method Not Allowed');
      return;
    }
    if (url.pathname === WEB_BRIDGE_SCRIPT_PATH) {
      serveFile(res, bridgeScriptFile);
      return;
    }
    if (url.pathname === '/healthz') {
      sendPlain(res, 200, 'ok');
      return;
    }
    const file = resolveStaticFile(rendererDir, url.pathname);
    if (!file) {
      sendPlain(res, 404, 'Not Found');
      return;
    }
    serveFile(res, file);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WEB_BRIDGE_MAX_FRAME_BYTES });

  const sendFrame = (ws: WebSocket, frame: WebBridgeServerFrame): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(serializeWebBridgeFrame(frame));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[headless] failed to encode bridge frame:', sanitizeLogMessage(message));
      // An unencodable result must still settle the renderer's invoke, or it hangs forever.
      if (frame.t === 'result') {
        ws.send(serializeWebBridgeFrame({ t: 'error', id: frame.id, message }));
      }
    }
  };

  const isAllowedOrigin = (req: http.IncomingMessage): boolean => {
    // Browsers always send Origin on WebSocket upgrades; require it to match Host so another
    // site cannot open a bridge session with a token it phished into the URL.
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser clients (tests, CLI tooling)
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      // catch-no-log-ok unparsable Origin is rejected by the caller
      return false;
    }
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://headless.invalid');
    const reject = (status: number, reason: string): void => {
      console.warn(`[headless] rejected bridge upgrade (${status} ${reason})`);
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    };
    if (url.pathname !== WEB_BRIDGE_WS_PATH) {
      reject(404, 'Not Found');
      return;
    }
    if (!isAllowedOrigin(req)) {
      reject(403, 'Forbidden');
      return;
    }
    if (
      token !== null &&
      !headlessTokenMatches(token, url.searchParams.get(WEB_BRIDGE_TOKEN_PARAM))
    ) {
      reject(401, 'Unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const sessionId = nextSessionId++;
    sessions.add(ws);
    console.debug(`[headless] bridge session ${sessionId} opened (${sessions.size} active)`);
    options.onSessionCountChange?.(sessions.size);
    const event: HeadlessIpcEvent = {
      senderFrame: { url: HEADLESS_SENDER_URL },
      sender: { id: sessionId },
      reply: (channel, ...args) => {
        sendFrame(ws, { t: 'event', channel, args });
      },
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        console.warn(`[headless] session ${sessionId}: dropped binary frame`);
        return;
      }
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
      const frame = parseWebBridgeClientFrame(raw);
      if (!frame) {
        console.warn(`[headless] session ${sessionId}: dropped malformed frame`);
        return;
      }
      if (frame.t === 'send') {
        if (!registry.emit(frame.channel, event, frame.args)) {
          console.debug(
            `[headless] no listener for send '${sanitizeLogMessage(frame.channel)}' (not ported)`,
          );
        }
        return;
      }
      // The call context lets the shim's file dialogs reach this session's browser.
      const call = transfer.createCall(sessionId, (channel, payload) => {
        sendFrame(ws, { t: 'event', channel, args: [payload] });
      });
      runInHeadlessCall(call.context, () => registry.invoke(frame.channel, event, frame.args)).then(
        (value) => {
          transfer.finishCall(call, true);
          sendFrame(ws, { t: 'result', id: frame.id, value });
        },
        (err: unknown) => {
          transfer.finishCall(call, false);
          const message = err instanceof Error ? err.message : String(err);
          console.debug(
            `[headless] invoke '${sanitizeLogMessage(frame.channel)}' failed:`,
            sanitizeLogMessage(message),
          );
          sendFrame(ws, { t: 'error', id: frame.id, message });
        },
      );
    });

    ws.on('close', () => {
      sessions.delete(ws);
      transfer.closeSession(sessionId);
      console.debug(`[headless] bridge session ${sessionId} closed (${sessions.size} active)`);
      options.onSessionCountChange?.(sessions.size);
    });
    ws.on('error', (err) => {
      console.warn(
        `[headless] bridge session ${sessionId} error:`,
        sanitizeLogMessage(err.message),
      );
    });
  });

  return {
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sessions) ws.terminate();
        sessions.clear();
        transfer.dispose();
        wss.close();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
    broadcast: (channel, args) => {
      for (const ws of sessions) sendFrame(ws, { t: 'event', channel, args });
    },
    sessionCount: () => sessions.size,
  };
}
