/**
 * Browser stand-in for the parts of `electron` the preload uses (`contextBridge`, `ipcRenderer`).
 *
 * `scripts/build-headless.mjs` bundles `src/preload/index.ts` with `electron` aliased to this
 * file, so the browser gets the exact same `window.electronAPI` as the desktop app, and each
 * `ipcRenderer.invoke` / `send` / `on` travels over one WebSocket to the headless server.
 *
 * Failure behavior: invokes issued while disconnected are queued and flushed on (re)connect;
 * invokes in flight when the socket drops reject (the server may or may not have run them).
 * Reconnects back off from 500 ms to 10 s.
 */
import { MS_PER_SECOND } from '../../shared/timeConstants';
import {
  formatWebBridgeInvokeError,
  type HeadlessHostPlatform,
  normalizeHeadlessHostPlatform,
  parseWebBridgeServerFrame,
  serializeWebBridgeFrame,
  WEB_BRIDGE_PLATFORM_GLOBAL,
  WEB_BRIDGE_PLATFORM_META,
  WEB_BRIDGE_TOKEN_PARAM,
  WEB_BRIDGE_WS_PATH,
  type WebBridgeClientFrame,
} from '../../shared/webBridgeProtocol';

type IpcListener = (event: IpcRendererEventLike, ...args: unknown[]) => void;

interface IpcRendererEventLike {
  sender: unknown;
}

/** Subset of the browser `WebSocket` the bridge needs (lets tests inject a fake). */
export interface BridgeSocket {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type BridgeSocketFactory = (url: string) => BridgeSocket;

const SOCKET_OPEN = 1;
const RECONNECT_MIN_MS = MS_PER_SECOND / 2;
const RECONNECT_MAX_MS = 10 * MS_PER_SECOND;
const TOKEN_STORAGE_KEY = 'mesh-client.headless.token';

interface PendingInvoke {
  channel: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface WebIpcRendererOptions {
  url: string;
  createSocket: BridgeSocketFactory;
  schedule?: (fn: () => void, ms: number) => void;
}

export class WebIpcRenderer {
  private socket: BridgeSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingInvoke>();
  private readonly outbox: WebBridgeClientFrame[] = [];
  private readonly listeners = new Map<string, IpcListener[]>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly options: WebIpcRendererOptions) {
    this.schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.connect();
  }

  private connect(): void {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      const queued = this.outbox.splice(0);
      for (const frame of queued) socket.send(serializeWebBridgeFrame(frame));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      this.handleFrame(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const [id, p] of this.pending) {
        // Frames still in the outbox were never sent; everything else was in flight.
        if (this.outbox.some((f) => f.t === 'invoke' && f.id === id)) continue;
        this.pending.delete(id);
        p.reject(
          new Error(formatWebBridgeInvokeError(p.channel, 'headless server connection lost')),
        );
      }
      console.warn(`[web-bridge] disconnected; retrying in ${this.reconnectDelay} ms`);
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.schedule(() => {
        this.connect();
      }, delay);
    };
  }

  private handleFrame(raw: string): void {
    const frame = parseWebBridgeServerFrame(raw);
    if (!frame) {
      console.warn('[web-bridge] dropped malformed frame from server');
      return;
    }
    if (frame.t === 'event') {
      const list = this.listeners.get(frame.channel);
      if (!list) return;
      const event: IpcRendererEventLike = { sender: this };
      for (const listener of [...list]) {
        try {
          listener(event, ...frame.args);
        } catch (err) {
          console.error(`[web-bridge] listener for ${frame.channel} threw:`, err);
        }
      }
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.t === 'result') p.resolve(frame.value);
    else p.reject(new Error(formatWebBridgeInvokeError(p.channel, frame.message)));
  }

  private transmit(frame: WebBridgeClientFrame): void {
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(serializeWebBridgeFrame(frame));
    } else {
      this.outbox.push(frame);
    }
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { channel, resolve, reject });
      try {
        this.transmit({ t: 'invoke', id, channel, args });
      } catch (err) {
        // Encoding failed (e.g. a function argument): fail like structured clone would.
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  send(channel: string, ...args: unknown[]): void {
    this.transmit({ t: 'send', channel, args });
  }

  on(channel: string, listener: IpcListener): this {
    const list = this.listeners.get(channel) ?? [];
    list.push(listener);
    this.listeners.set(channel, list);
    return this;
  }

  once(channel: string, listener: IpcListener): this {
    const wrapped: IpcListener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    return this.on(channel, wrapped);
  }

  removeListener(channel: string, listener: IpcListener): this {
    const list = this.listeners.get(channel);
    if (!list) return this;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.listeners.delete(channel);
    return this;
  }

  off(channel: string, listener: IpcListener): this {
    return this.removeListener(channel, listener);
  }

  removeAllListeners(channel?: string): this {
    if (channel === undefined) this.listeners.clear();
    else this.listeners.delete(channel);
    return this;
  }

  listenerCount(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0;
  }
}

/**
 * Read the session token from `?token=` (first visit) or storage, then strip it from the
 * address bar so it does not linger in history or screenshots.
 */
export function takeHeadlessToken(win: Window): string | null {
  const url = new URL(win.location.href);
  const fromUrl = url.searchParams.get(WEB_BRIDGE_TOKEN_PARAM);
  try {
    if (fromUrl) {
      win.localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
      url.searchParams.delete(WEB_BRIDGE_TOKEN_PARAM);
      win.history.replaceState(win.history.state, '', url.toString());
      return fromUrl;
    }
    return win.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // catch-no-log-ok storage blocked (private mode): fall back to the URL token only
    return fromUrl;
  }
}

export function buildBridgeSocketUrl(location: Location, token: string | null): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${scheme}//${location.host}${WEB_BRIDGE_WS_PATH}`);
  if (token) url.searchParams.set(WEB_BRIDGE_TOKEN_PARAM, token);
  return url.toString();
}

/** Server OS from the `<meta>` the headless server injects (see `injectWebBridgeScript`). */
export function readHeadlessHostPlatform(
  doc: Pick<Document, 'querySelector'>,
): HeadlessHostPlatform {
  const meta = doc.querySelector(`meta[name="${WEB_BRIDGE_PLATFORM_META}"]`);
  return normalizeHeadlessHostPlatform(meta?.getAttribute('content'));
}

// The bridge bundle compiles `process.platform` (preload `getPlatform()`) to this global, so it
// must be set before the preload body runs; this module is evaluated first as its import.
if (typeof document !== 'undefined') {
  Object.defineProperty(globalThis, WEB_BRIDGE_PLATFORM_GLOBAL, {
    value: readHeadlessHostPlatform(document),
    configurable: false,
    writable: false,
  });
}

let sharedRenderer: WebIpcRenderer | null = null;

function getSharedRenderer(): WebIpcRenderer {
  sharedRenderer ??= new WebIpcRenderer({
    url: buildBridgeSocketUrl(window.location, takeHeadlessToken(window)),
    createSocket: (url) => new WebSocket(url) as unknown as BridgeSocket,
  });
  return sharedRenderer;
}

/** Lazily connects on first use so importing this module in tests has no side effects. */
export const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    getSharedRenderer().invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]): void => {
    getSharedRenderer().send(channel, ...args);
  },
  on: (channel: string, listener: IpcListener): unknown =>
    getSharedRenderer().on(channel, listener),
  once: (channel: string, listener: IpcListener): unknown =>
    getSharedRenderer().once(channel, listener),
  removeListener: (channel: string, listener: IpcListener): unknown =>
    getSharedRenderer().removeListener(channel, listener),
  off: (channel: string, listener: IpcListener): unknown =>
    getSharedRenderer().off(channel, listener),
  removeAllListeners: (channel?: string): unknown =>
    getSharedRenderer().removeAllListeners(channel),
};

export const contextBridge = {
  exposeInMainWorld: (key: string, api: unknown): void => {
    Object.defineProperty(window, key, { value: api, configurable: false, writable: false });
  },
};
