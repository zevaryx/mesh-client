/**
 * Wire protocol for the headless web UI bridge.
 *
 * In Electron, `ipcRenderer.invoke` / `webContents.send` carry values via structured clone.
 * The headless server (`src/main/headless/`) and the browser bridge
 * (`src/preload/web/electronRendererShim.ts`) carry the same calls over one WebSocket as JSON,
 * so values that JSON cannot represent (bytes, Dates, Maps, Sets, bigint, `undefined`) are
 * tagged on the way out and restored on the way in.
 */

/** WebSocket path the headless server accepts bridge connections on. */
export const WEB_BRIDGE_WS_PATH = '/ipc';
/** Query parameter carrying the session token on the WebSocket URL and first page load. */
export const WEB_BRIDGE_TOKEN_PARAM = 'token';
/** Script served by the headless server that defines `window.electronAPI`. */
export const WEB_BRIDGE_SCRIPT_PATH = '/web-bridge.js';
/** `<meta name>` the server injects into `index.html` with its `process.platform`. */
export const WEB_BRIDGE_PLATFORM_META = 'mesh-client-host-platform';
/** Global the bridge sets from that meta; `process.platform` in the bridge bundle reads it. */
export const WEB_BRIDGE_PLATFORM_GLOBAL = '__MESH_CLIENT_HOST_PLATFORM__';

/** Platforms the renderer branches on. `getPlatform()` reports the server's OS, not the viewer's. */
export type HeadlessHostPlatform = 'linux' | 'darwin' | 'win32';

/**
 * Map a platform string to one the renderer knows. Other Unix-likes (freebsd, …) report `linux`,
 * the closest match for the server-side code paths the renderer chooses between.
 */
export function normalizeHeadlessHostPlatform(value: unknown): HeadlessHostPlatform {
  return value === 'darwin' || value === 'win32' ? value : 'linux';
}

/** Largest inbound bridge frame the server accepts (bytes). Matches the TCP write cap ×4 for JSON. */
export const WEB_BRIDGE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Headless file transfer (server-side `dialog.showOpenDialog` / `showSaveDialog`).
 * Control flows over the bridge as push events; file bytes go over HTTP with the session token
 * in an `Authorization: Bearer` header (never in a URL).
 */
export const WEB_BRIDGE_PICK_FILES_EVENT = 'headless:pickFiles';
export const WEB_BRIDGE_DOWNLOAD_EVENT = 'headless:download';
/** `POST {prefix}/upload/<requestId>?name=<file name>` — one file per request body. */
export const WEB_BRIDGE_FILES_PATH = '/files';

/**
 * Map tiles (`mesh-tiles://<basemap>/<z>/<x>/<y>.png` on the desktop app) are served at
 * `GET /tiles/<basemap>/<z>/<x>/<y>.png` from the same server-side cache. `<img>` tags cannot send
 * an `Authorization` header, so the bridge first trades the token for an HttpOnly cookie scoped to
 * that path: `POST /session/tiles` with `Authorization: Bearer <token>`.
 */
export const WEB_BRIDGE_TILES_PATH = '/tiles';
export const WEB_BRIDGE_TILES_SESSION_PATH = '/session/tiles';
export const WEB_BRIDGE_TILES_COOKIE = 'mesh_client_tiles';
const MESH_TILES_SCHEME_PREFIX = 'mesh-tiles://';

/** `mesh-tiles://osm/1/2/3.png?x` → `/tiles/osm/1/2/3.png?x`; other URLs pass through. */
export function meshTilesUrlToWebPath(url: string): string {
  return url.startsWith(MESH_TILES_SCHEME_PREFIX)
    ? `${WEB_BRIDGE_TILES_PATH}/${url.slice(MESH_TILES_SCHEME_PREFIX.length)}`
    : url;
}

/** `/tiles/osm/1/2/3.png` + `?x` → `mesh-tiles://osm/1/2/3.png?x`; `null` outside the tile path. */
export function webTilesPathToMeshTilesUrl(pathname: string, search: string): string | null {
  const prefix = `${WEB_BRIDGE_TILES_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  return `${MESH_TILES_SCHEME_PREFIX}${pathname.slice(prefix.length)}${search}`;
}

export interface WebBridgePickFilesRequest {
  requestId: string;
  title?: string;
  multiple: boolean;
  accept: string;
}

export interface WebBridgePickFilesCompletion {
  canceled: boolean;
  /** Set when the browser failed to upload; the server rejects the dialog with it. */
  error?: string;
}

export interface WebBridgeDownloadNotice {
  id: string;
  fileName: string;
  size: number;
}

/** File-name-safe base name for uploads/downloads (no paths, control chars or reserved names). */
const UNSAFE_FILE_NAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*']);

export function sanitizeTransferFileName(name: unknown, fallback = 'file'): string {
  if (typeof name !== 'string') return fallback;
  const base = name.split(/[\\/]/).pop() ?? '';
  let cleaned = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    cleaned += code < 0x20 || code === 0x7f || UNSAFE_FILE_NAME_CHARS.has(ch) ? '_' : ch;
  }
  cleaned = cleaned.trim().slice(0, 200);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

/** Renderer → server: `ipcRenderer.invoke(channel, ...args)`. */
export interface WebBridgeInvokeFrame {
  t: 'invoke';
  id: number;
  channel: string;
  args: unknown[];
}

/** Renderer → server: `ipcRenderer.send(channel, ...args)` (fire-and-forget). */
export interface WebBridgeSendFrame {
  t: 'send';
  channel: string;
  args: unknown[];
}

/** Server → renderer: resolved invoke. */
export interface WebBridgeResultFrame {
  t: 'result';
  id: number;
  value: unknown;
}

/** Server → renderer: rejected invoke (message only, like Electron). */
export interface WebBridgeErrorFrame {
  t: 'error';
  id: number;
  message: string;
}

/** Server → renderer: `webContents.send(channel, ...args)`. */
export interface WebBridgeEventFrame {
  t: 'event';
  channel: string;
  args: unknown[];
}

export type WebBridgeClientFrame = WebBridgeInvokeFrame | WebBridgeSendFrame;
export type WebBridgeServerFrame = WebBridgeResultFrame | WebBridgeErrorFrame | WebBridgeEventFrame;

const TAG = '__mcwb';

type TaggedValue =
  | { [TAG]: 'u8'; b64: string }
  | { [TAG]: 'ab'; b64: string }
  | { [TAG]: 'date'; ms: number }
  | { [TAG]: 'map'; entries: unknown[] }
  | { [TAG]: 'set'; values: unknown[] }
  | { [TAG]: 'bigint'; s: string }
  | { [TAG]: 'undef' }
  | { [TAG]: 'obj'; value: Record<string, unknown> };

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Convert a structured-clone-style value into a JSON-safe value.
 * Node `Buffer` and other typed arrays become `Uint8Array` on decode (as with Electron IPC).
 */
export function encodeWireValue(value: unknown): unknown {
  if (value === undefined) return { [TAG]: 'undef' };
  if (value === null) return null;
  if (typeof value === 'bigint') return { [TAG]: 'bigint', s: value.toString() };
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`web bridge cannot encode a ${typeof value}`);
    }
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { [TAG]: 'u8', b64: bytesToBase64(bytes) };
  }
  if (value instanceof ArrayBuffer) {
    return { [TAG]: 'ab', b64: bytesToBase64(new Uint8Array(value)) };
  }
  if (value instanceof Date) return { [TAG]: 'date', ms: value.getTime() };
  if (value instanceof Map) {
    return {
      [TAG]: 'map',
      entries: [...value.entries()].map(([k, v]) => [encodeWireValue(k), encodeWireValue(v)]),
    };
  }
  if (value instanceof Set) {
    return { [TAG]: 'set', values: [...value].map((v) => encodeWireValue(v)) };
  }
  if (value instanceof Error) {
    return { message: value.message, name: value.name };
  }
  if (Array.isArray(value)) return value.map((v) => encodeWireValue(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Structured clone drops nothing, but JSON drops undefined props; keep them tagged only
    // inside arrays. Omitting undefined object props matches how renderers read them.
    if (v === undefined) continue;
    out[k] = encodeWireValue(v);
  }
  // A user object that happens to own the tag key is wrapped so decode does not misread it.
  return TAG in out ? { [TAG]: 'obj', value: out } : out;
}

/** Inverse of {@link encodeWireValue}. */
export function decodeWireValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeWireValue(v));
  if (!isPlainObject(value)) return value;
  if (TAG in value) {
    const tagged = value as TaggedValue;
    switch (tagged[TAG]) {
      case 'u8':
        return base64ToBytes(tagged.b64);
      case 'ab': {
        const bytes = base64ToBytes(tagged.b64);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case 'date':
        return new Date(tagged.ms);
      case 'map':
        return new Map(
          tagged.entries.map((entry) => {
            const [k, v] = entry as [unknown, unknown];
            return [decodeWireValue(k), decodeWireValue(v)];
          }),
        );
      case 'set':
        return new Set(tagged.values.map((v) => decodeWireValue(v)));
      case 'bigint':
        return BigInt(tagged.s);
      case 'undef':
        return undefined;
      case 'obj':
        return decodeObjectFields(tagged.value);
    }
  }
  return decodeObjectFields(value);
}

function decodeObjectFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // `JSON.parse` keeps "__proto__" as an own key; assigning it would swap the prototype.
    Object.defineProperty(out, k, {
      value: decodeWireValue(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function serializeWebBridgeFrame(
  frame: WebBridgeClientFrame | WebBridgeServerFrame,
): string {
  switch (frame.t) {
    case 'invoke':
    case 'send':
    case 'event':
      return JSON.stringify({ ...frame, args: frame.args.map((a) => encodeWireValue(a)) });
    case 'result':
      return JSON.stringify({ ...frame, value: encodeWireValue(frame.value) });
    case 'error':
      return JSON.stringify(frame);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode, or `ok: false` when the value cannot be decoded: a malformed tag (bad base64 or bigint, a
 * `map` without entries) or nesting deep enough to overflow the stack. Frames come from the
 * network, so this must never throw into the socket's message handler.
 */
function tryDecode(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: decodeWireValue(value) };
  } catch {
    // catch-no-log-ok undecodable frame is reported by the caller as a dropped frame
    return { ok: false };
  }
}

function decodeArgs(args: unknown): unknown[] | null {
  if (!Array.isArray(args)) return null;
  const decoded = tryDecode(args);
  return decoded.ok ? (decoded.value as unknown[]) : null;
}

/** Parse a renderer → server frame; `null` when malformed (caller drops it). */
export function parseWebBridgeClientFrame(raw: string): WebBridgeClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // catch-no-log-ok malformed frame is reported by the caller as a dropped frame
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.channel !== 'string') return null;
  const args = decodeArgs(parsed.args);
  if (!args) return null;
  if (parsed.t === 'invoke' && Number.isSafeInteger(parsed.id)) {
    return { t: 'invoke', id: parsed.id as number, channel: parsed.channel, args };
  }
  if (parsed.t === 'send') return { t: 'send', channel: parsed.channel, args };
  return null;
}

/** Parse a server → renderer frame; `null` when malformed (caller drops it). */
export function parseWebBridgeServerFrame(raw: string): WebBridgeServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // catch-no-log-ok malformed frame is reported by the caller as a dropped frame
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.t === 'event' && typeof parsed.channel === 'string') {
    const args = decodeArgs(parsed.args);
    return args ? { t: 'event', channel: parsed.channel, args } : null;
  }
  if (!Number.isSafeInteger(parsed.id)) return null;
  const id = parsed.id as number;
  if (parsed.t === 'result') {
    const decoded = tryDecode(parsed.value);
    return decoded.ok ? { t: 'result', id, value: decoded.value } : null;
  }
  if (parsed.t === 'error' && typeof parsed.message === 'string') {
    return { t: 'error', id, message: parsed.message };
  }
  return null;
}

/** Same rejection text Electron produces for a failed `ipcRenderer.invoke`. */
export function formatWebBridgeInvokeError(channel: string, message: string): string {
  return `Error invoking remote method '${channel}': Error: ${message}`;
}
