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
 *
 * Catch-up after an outage: push events sent while the socket was down are lost, so when an
 * established connection drops the bridge raises a local `power:suspend`, and after it reconnects
 * (and has flushed queued calls) a `power:resume`. The renderer's existing sleep/wake recovery
 * (`usePowerRecovery`) then bounces MQTT, reconnects radios from saved params and re-attaches the
 * Reticulum sidecar, which re-pushes current state. The first connect raises nothing.
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
  WEB_BRIDGE_TILES_SESSION_PATH,
  WEB_BRIDGE_TOKEN_PARAM,
  WEB_BRIDGE_WS_PATH,
  type WebBridgeClientFrame,
} from '../../shared/webBridgeProtocol';
import { installHeadlessAiModelFetch } from './aiModelFetch';
import { type BrowserLocalInvoke, createBrowserLocalInvokes } from './browserLocalInvokes';
import { installHeadlessFileTransfer } from './headlessFileTransfer';
import { installInsecureContextFallbacks } from './insecureContextFallbacks';
import { createWebSerialPolyfill, type WebSerialPolyfill } from './webSerialPolyfill';

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
export const TOKEN_STORAGE_KEY = 'mesh-client.headless.token';
/** Channels the desktop main process uses for sleep/wake (see `onPowerSuspend` in the preload). */
export const BRIDGE_OUTAGE_SUSPEND_CHANNEL = 'power:suspend';
export const BRIDGE_OUTAGE_RESUME_CHANNEL = 'power:resume';

interface PendingInvoke {
  channel: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface WebIpcRendererOptions {
  url: string;
  createSocket: BridgeSocketFactory;
  schedule?: (fn: () => void, ms: number) => void;
  /** Channels answered in the page instead of on the server (`browserLocalInvokes.ts`). */
  localInvokes?: Record<string, BrowserLocalInvoke>;
  /** Sends handled in the page instead of on the server (the serial port picker's answer). */
  localSends?: Record<string, (...args: unknown[]) => void>;
}

export class WebIpcRenderer {
  private socket: BridgeSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingInvoke>();
  private readonly outbox: WebBridgeClientFrame[] = [];
  private readonly listeners = new Map<string, IpcListener[]>();
  private reconnectDelay = RECONNECT_MIN_MS;
  /** An established connection dropped and `power:suspend` was raised; cleared on resume. */
  private outage = false;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly options: WebIpcRendererOptions) {
    this.schedule = options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.connect();
  }

  private connect(): void {
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      const queued = this.outbox.splice(0);
      for (const frame of queued) socket.send(serializeWebBridgeFrame(frame));
      if (this.outage) {
        this.outage = false;
        console.debug('[web-bridge] reconnected; resyncing renderer state');
        this.dispatch(BRIDGE_OUTAGE_RESUME_CHANNEL, []);
      }
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
      // Only a drop of a live connection starts an outage; failed retries are part of it.
      if (opened && !this.outage) {
        this.outage = true;
        this.dispatch(BRIDGE_OUTAGE_SUSPEND_CHANNEL, []);
      }
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
      this.dispatch(frame.channel, frame.args);
      return;
    }
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.t === 'result') p.resolve(frame.value);
    else p.reject(new Error(formatWebBridgeInvokeError(p.channel, frame.message)));
  }

  private dispatch(channel: string, args: unknown[]): void {
    const list = this.listeners.get(channel);
    if (!list) return;
    const event: IpcRendererEventLike = { sender: this };
    for (const listener of [...list]) {
      try {
        listener(event, ...args);
      } catch (err) {
        console.error(`[web-bridge] listener for ${channel} threw:`, err);
      }
    }
  }

  private transmit(frame: WebBridgeClientFrame): void {
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(serializeWebBridgeFrame(frame));
    } else {
      this.outbox.push(frame);
    }
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const local = this.options.localInvokes?.[channel];
    if (local) {
      return local(...args).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(formatWebBridgeInvokeError(channel, message));
      });
    }
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
    const local = this.options.localSends?.[channel];
    if (local) {
      local(...args);
      return;
    }
    this.transmit({ t: 'send', channel, args });
  }

  /** Raise an event for this page's listeners only (nothing goes to the server). */
  emitLocal(channel: string, args: unknown[]): void {
    this.dispatch(channel, args);
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

/**
 * Trade the token for the HttpOnly cookie that lets `<img>` / Leaflet load `/tiles/…` (images
 * cannot send an `Authorization` header). Failure leaves maps without a basemap; it is logged and
 * retried on the next page load.
 */
export async function requestHeadlessTilesCookie(
  fetchFn: typeof fetch,
  token: string | null,
): Promise<boolean> {
  try {
    const res = await fetchFn(WEB_BRIDGE_TILES_SESSION_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) return true;
    console.warn(`[web-bridge] map tile access refused (HTTP ${res.status})`);
  } catch (err) {
    console.warn('[web-bridge] could not request map tile access', err);
  }
  return false;
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
let webSerial: WebSerialPolyfill | null = null;

/** The server's serial ports as `navigator.serial` (`webSerialPolyfill.ts`). */
function getWebSerial(): WebSerialPolyfill {
  webSerial ??= createWebSerialPolyfill(
    {
      invoke: (channel, ...args) => getSharedRenderer().invoke(channel, ...args),
      on: (channel, listener) => getSharedRenderer().on(channel, listener),
      removeListener: (channel, listener) => getSharedRenderer().removeListener(channel, listener),
      emitLocal: (channel, args) => {
        getSharedRenderer().emitLocal(channel, args);
      },
    },
    window.localStorage,
  );
  return webSerial;
}

function getSharedRenderer(): WebIpcRenderer {
  if (sharedRenderer) return sharedRenderer;
  const token = takeHeadlessToken(window);
  const renderer = new WebIpcRenderer({
    url: buildBridgeSocketUrl(window.location, token),
    createSocket: (url) => new WebSocket(url) as unknown as BridgeSocket,
    localInvokes: createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_STORAGE_KEY }),
    localSends: getWebSerial().localSends,
  });
  // Server-side file dialogs (open → upload, save → download) are served by this tab.
  installHeadlessFileTransfer({
    on: (channel, listener) => renderer.on(channel, listener),
    token,
    doc: document,
    fetchFn: window.fetch.bind(window),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
  });
  void requestHeadlessTilesCookie(window.fetch.bind(window), token);
  // Offline AI models: `mesh-ai://…` is served by the server's `/ai-models/…` route.
  installHeadlessAiModelFetch(window, token);
  sharedRenderer = renderer;
  return renderer;
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
    // Serial ports are the server's, so the renderer's Web Serial code reaches the radio there.
    if (key === 'electronAPI') {
      installInsecureContextFallbacks(window);
      Object.defineProperty(navigator, 'serial', {
        value: getWebSerial().serial,
        configurable: true,
      });
    }
  },
};
