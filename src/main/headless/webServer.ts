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
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import WebSocket, { WebSocketServer } from 'ws';

import {
  WEB_BRIDGE_DATA_CHANGED_EVENT,
  webBridgeDataChangeFor,
  webBridgeResultChangedRows,
} from '../../shared/webBridgeDataSync';
import {
  normalizeHeadlessHostPlatform,
  parseWebBridgeClientFrame,
  serializeWebBridgeFrame,
  WEB_BRIDGE_AI_MODELS_PATH,
  WEB_BRIDGE_FILES_PATH,
  WEB_BRIDGE_MAX_FRAME_BYTES,
  WEB_BRIDGE_PLATFORM_META,
  WEB_BRIDGE_SCRIPT_PATH,
  WEB_BRIDGE_TILES_COOKIE,
  WEB_BRIDGE_TILES_PATH,
  WEB_BRIDGE_TILES_SESSION_PATH,
  WEB_BRIDGE_TOKEN_PARAM,
  WEB_BRIDGE_WS_PATH,
  webAiModelsPathToMeshAiUrl,
  type WebBridgeServerFrame,
  webTilesPathToMeshTilesUrl,
} from '../../shared/webBridgeProtocol';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { HeadlessAuthThrottle, headlessClientKey } from './authThrottle';
import { runInHeadlessCall } from './callContext';
import { HEADLESS_DEFAULT_MAX_SESSIONS } from './config';
import { HeadlessFileTransfer } from './fileTransfer';
import {
  HEADLESS_SENDER_URL,
  type HeadlessIpcEvent,
  type HeadlessIpcRegistry,
} from './ipcRegistry';
import { HeadlessSessionSender } from './sessionSender';

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
  /** Most bridge sessions (tabs) open at once; more are refused (default 16). */
  maxSessions?: number;
  /**
   * Host names (lowercase, no port) accepted when auth is off, besides IP literals and
   * `localhost`; see {@link headlessHostAllowed}.
   */
  allowedHosts?: readonly string[];
  /** Key the bad-token lockout on `X-Forwarded-For` (see `authThrottle.ts`). */
  trustProxy?: boolean;
  /** Called with the new count whenever a bridge session opens or closes. */
  onSessionCountChange?: (count: number) => void;
  /**
   * The desktop `mesh-tiles:` protocol handler (cache, then remote fetch). When set, tiles are
   * served at `/tiles/…` to holders of the tile cookie; unset, `/tiles/…` is 404.
   */
  tileHandler?: (request: Request) => Promise<Response>;
  /**
   * The desktop `mesh-ai:` protocol handler (offline AI model files). When set, models are served
   * at `/ai-models/…` to token holders; unset, `/ai-models/…` is 404.
   */
  aiModelHandler?: (request: Request) => Promise<Response>;
}

export const HEADLESS_DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** `Authorization: Bearer <token>` for the file-transfer endpoints. */
function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}

/**
 * Tile cookie value: derived from the token rather than the token itself, so a leaked cookie only
 * grants map tiles and cannot open a bridge session.
 */
export function headlessTilesCookieValue(token: string): string {
  return createHmac('sha256', token).update('mesh-client map tiles').digest('base64url');
}

/**
 * DNS-rebinding guard for `MESH_CLIENT_WEB_AUTH=off`: a page on an attacker's domain that
 * re-resolves to this server sends `Host: <attacker domain>` (and a matching `Origin`), so without
 * a token only IP literals, `localhost` and operator-listed names are served. With a token the
 * rebinding page still cannot authenticate, so any host is accepted.
 */
export function headlessHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    // catch-no-log-ok unparsable Host is refused by the caller
    return false;
  }
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0 || bare === 'localhost') return true;
  return allowedHosts.includes(bare);
}

/** Value of one cookie in a `Cookie` header, or `null`. */
export function readRequestCookie(req: http.IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Whether the browser reached us over HTTPS (directly or via a TLS-terminating proxy). */
function isHttpsRequest(req: http.IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true;
  return req.headers['x-forwarded-proto'] === 'https';
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
  // The renderer's CSP is a <meta> tag, which cannot set frame-ancestors.
  'Content-Security-Policy': "frame-ancestors 'none'",
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

  const tilesCookie = token === null ? null : headlessTilesCookieValue(token);
  const throttle = new HeadlessAuthThrottle();
  const maxSessions = options.maxSessions ?? HEADLESS_DEFAULT_MAX_SESSIONS;

  /**
   * Token check with the bad-token lockout: 200 (allowed), 401 (wrong / missing) or 429 (this
   * client failed too often; refused without checking, so a guess cannot succeed meanwhile).
   */
  const checkToken = (req: http.IncomingMessage, provided: string | null): 200 | 401 | 429 => {
    // Auth off (`null`); a configured token is never empty (16+ characters).
    if (!token) return 200;
    const client = headlessClientKey(req, options.trustProxy === true);
    if (throttle.isLocked(client)) return 429;
    if (headlessTokenMatches(token, provided)) {
      throttle.recordSuccess(client);
      return 200;
    }
    if (throttle.recordFailure(client)) {
      console.warn(
        `[headless] too many bad tokens from ${sanitizeLogMessage(client)}; refusing it for a while`,
      );
    }
    return 401;
  };

  const sendAuthFailure = (res: http.ServerResponse, status: 401 | 429): void => {
    sendPlain(res, status, status === 429 ? 'Too Many Requests' : 'Unauthorized');
  };

  const issueTilesCookie = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    req.resume();
    if (req.method !== 'POST') {
      sendPlain(res, 405, 'Method Not Allowed');
      return;
    }
    const access = checkToken(req, bearerToken(req));
    if (access !== 200) {
      sendAuthFailure(res, access);
      return;
    }
    const attrs = [`Path=${WEB_BRIDGE_TILES_PATH}`, 'HttpOnly', 'SameSite=Strict'];
    if (isHttpsRequest(req)) attrs.push('Secure');
    res.writeHead(204, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      ...(tilesCookie === null
        ? {}
        : { 'Set-Cookie': `${WEB_BRIDGE_TILES_COOKIE}=${tilesCookie}; ${attrs.join('; ')}` }),
    });
    res.end();
  };

  const serveTile = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const tileHandler = options.tileHandler;
    const meshTilesUrl = webTilesPathToMeshTilesUrl(url.pathname, url.search);
    if (!tileHandler || meshTilesUrl === null) {
      sendPlain(res, 404, 'Not Found');
      return;
    }
    // Without the cookie the server would be an open tile proxy and reveal which areas are cached.
    // Not counted by the lockout: a map view with a stale cookie fails dozens of tiles at once,
    // and the cookie only grants tiles.
    if (
      tilesCookie !== null &&
      !headlessTokenMatches(tilesCookie, readRequestCookie(req, WEB_BRIDGE_TILES_COOKIE))
    ) {
      sendPlain(res, 401, 'Unauthorized');
      return;
    }
    tileHandler(new Request(meshTilesUrl)).then(
      async (tile) => {
        const body = Buffer.from(await tile.arrayBuffer());
        const headers: Record<string, string> = { ...SECURITY_HEADERS };
        const type = tile.headers.get('content-type');
        if (type) headers['Content-Type'] = type;
        // Private: the response depends on the cookie, so shared caches must not keep it.
        headers['Cache-Control'] = tile.ok ? 'private, max-age=86400' : 'no-store';
        res.writeHead(tile.status, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      (err: unknown) => {
        console.warn(
          '[headless] tile request failed:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
        if (!res.headersSent) sendPlain(res, 500, 'Internal Server Error');
        else res.destroy();
      },
    );
  };

  /** One offline AI model file, streamed (model files are hundreds of MB). */
  const serveAiModel = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    const access = checkToken(req, bearerToken(req));
    if (access !== 200) {
      sendAuthFailure(res, access);
      return;
    }
    const meshAiUrl = webAiModelsPathToMeshAiUrl(url.pathname);
    const handler = options.aiModelHandler;
    if (!handler || meshAiUrl === null) {
      sendPlain(res, 404, 'Not Found');
      return;
    }
    handler(new Request(meshAiUrl)).then(
      (model) => {
        const headers: Record<string, string> = {
          ...SECURITY_HEADERS,
          'Cache-Control': 'no-store',
        };
        for (const name of ['content-type', 'content-length']) {
          const value = model.headers.get(name);
          if (value) headers[name] = value;
        }
        res.writeHead(model.status, headers);
        if (req.method === 'HEAD' || !model.body) {
          void model.body?.cancel();
          res.end();
          return;
        }
        const body = Readable.fromWeb(model.body as unknown as NodeReadableStream<Uint8Array>);
        body.on('error', (err) => {
          console.warn('[headless] AI model stream failed:', sanitizeLogMessage(String(err)));
          res.destroy();
        });
        res.on('close', () => {
          body.destroy();
        });
        body.pipe(res);
      },
      (err: unknown) => {
        console.warn(
          '[headless] AI model request failed:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
        if (!res.headersSent) sendPlain(res, 500, 'Internal Server Error');
        else res.destroy();
      },
    );
  };

  const allowedHosts = (options.allowedHosts ?? []).map((h) => h.toLowerCase());
  const hostRefused = (req: http.IncomingMessage): boolean =>
    token === null && !headlessHostAllowed(req.headers.host, allowedHosts);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://headless.invalid');
    if (hostRefused(req)) {
      req.resume();
      sendPlain(
        res,
        421,
        'This host name is not allowed while MESH_CLIENT_WEB_AUTH=off. Use the IP address, or ' +
          'add the name to MESH_CLIENT_WEB_ALLOWED_HOSTS.',
      );
      return;
    }
    if (url.pathname === WEB_BRIDGE_TILES_SESSION_PATH) {
      issueTilesCookie(req, res);
      return;
    }
    if (url.pathname.startsWith(`${WEB_BRIDGE_FILES_PATH}/`)) {
      const access = checkToken(req, bearerToken(req));
      if (access !== 200) {
        req.resume();
        sendAuthFailure(res, access);
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
    if (url.pathname.startsWith(`${WEB_BRIDGE_TILES_PATH}/`)) {
      serveTile(req, res, url);
      return;
    }
    if (url.pathname.startsWith(`${WEB_BRIDGE_AI_MODELS_PATH}/`)) {
      serveAiModel(req, res, url);
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
    if (hostRefused(req)) {
      reject(421, 'Misdirected Request');
      return;
    }
    if (!isAllowedOrigin(req)) {
      reject(403, 'Forbidden');
      return;
    }
    const access = checkToken(req, url.searchParams.get(WEB_BRIDGE_TOKEN_PARAM));
    if (access !== 200) {
      reject(access, access === 429 ? 'Too Many Requests' : 'Unauthorized');
      return;
    }
    if (sessions.size >= maxSessions) {
      reject(503, 'Service Unavailable');
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
    const sender = new HeadlessSessionSender(sessionId, (channel, args) => {
      sendFrame(ws, { t: 'event', channel, args });
    });
    const event: HeadlessIpcEvent = {
      senderFrame: { url: HEADLESS_SENDER_URL },
      sender,
      reply: (channel, ...args) => {
        sender.send(channel, ...args);
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
          // Shared viewing: other tabs reload what this tab changed (`webBridgeDataSync.ts`).
          const change = webBridgeDataChangeFor(frame.channel);
          if (change && webBridgeResultChangedRows(value)) {
            for (const other of sessions) {
              if (other !== ws) {
                sendFrame(other, {
                  t: 'event',
                  channel: WEB_BRIDGE_DATA_CHANGED_EVENT,
                  args: [change],
                });
              }
            }
          }
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
      sender.destroy();
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
