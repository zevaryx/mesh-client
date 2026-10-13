/**
 * `navigator.serial` for the headless web UI, backed by the server's serial ports
 * (`main/headless/serialBridge.ts`). The renderer's Web Serial code (Meshtastic
 * `TransportWebSerial`, MeshCore `WebSerialConnection`, reconnect through `getPorts()`) runs
 * unchanged; a radio plugged into the server shows up in the usual port picker.
 *
 * `requestPort()` plays Electron's `select-serial-port` part: it lists the server's ports, raises
 * `serial-ports-discovered` in the page (the renderer shows its picker) and waits for the
 * `serial-port-selected` / `serial-port-cancelled` sends, which this module answers in the page.
 * Picked ports are remembered (per browser) for `getPorts()`.
 *
 * Not supported: `setSignals` / `getSignals` (DTR/RTS, used by firmware flashing), and `connect`
 * events for ports plugged in later (the picker lists the ports at the time it opens).
 * A port that goes away (unplugged on the server) errors its streams with `NetworkError` and fires
 * `disconnect` on the port and on `navigator.serial`, as Web Serial does.
 */
import {
  isWebSerialPortListing,
  WEB_SERIAL_CLOSE,
  WEB_SERIAL_CLOSED_EVENT,
  WEB_SERIAL_DATA_EVENT,
  WEB_SERIAL_LIST,
  WEB_SERIAL_OPEN,
  WEB_SERIAL_WRITE,
  type WebSerialOpenResult,
  type WebSerialPortListing,
} from '../../shared/webSerialBridge';

export const SERIAL_PORTS_DISCOVERED_CHANNEL = 'serial-ports-discovered';
export const SERIAL_PORT_SELECTED_CHANNEL = 'serial-port-selected';
export const SERIAL_PORT_CANCELLED_CHANNEL = 'serial-port-cancelled';
export const GRANTED_SERIAL_PORTS_KEY = 'mesh-client.headless.serialPorts';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The bridge calls the polyfill needs (`WebIpcRenderer`). */
export interface WebSerialIpc {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: IpcListener) => unknown;
  removeListener: (channel: string, listener: IpcListener) => unknown;
  /** Raise an event in this page only. */
  emitLocal: (channel: string, args: unknown[]) => void;
}

export interface WebSerialStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function lostError(): Error {
  return new DOMException('The device has been lost.', 'NetworkError');
}

function hexId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 16);
  return Number.isFinite(n) ? n : undefined;
}

export class WebSerialPortPolyfill extends EventTarget {
  /** The server's device path; the renderer saves it to find the port again. */
  readonly portId: string;
  private link: number | null = null;
  private readableStream: ReadableStream<Uint8Array> | null = null;
  private readController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private writableStream: WritableStream<Uint8Array> | null = null;
  private opening: Promise<void> | null = null;
  ondisconnect: ((event: Event) => void) | null = null;

  constructor(
    private listing: WebSerialPortListing,
    private readonly ipc: WebSerialIpc,
    private readonly onLost: (port: WebSerialPortPolyfill) => void,
    private readonly onForget: (port: WebSerialPortPolyfill) => void,
  ) {
    super();
    this.portId = listing.portId;
  }

  /** Refresh the listing (ids can appear after a replug). */
  update(listing: WebSerialPortListing): void {
    this.listing = listing;
  }

  /** The server lists only ports that exist, so a port handed out is a connected one. */
  readonly connected = true;

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    const usbVendorId = hexId(this.listing.vendorId);
    const usbProductId = hexId(this.listing.productId);
    return {
      ...(usbVendorId === undefined ? {} : { usbVendorId }),
      ...(usbProductId === undefined ? {} : { usbProductId }),
    };
  }

  get readable(): ReadableStream<Uint8Array> | null {
    if (this.link === null) return null;
    return this.ensureReadable();
  }

  /** Created at open (and again after a cancel), so bytes that arrive first are queued. */
  private ensureReadable(): ReadableStream<Uint8Array> {
    this.readableStream ??= new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.readController = controller;
      },
      cancel: () => {
        this.readController = null;
        this.readableStream = null;
      },
    });
    return this.readableStream;
  }

  get writable(): WritableStream<Uint8Array> | null {
    if (this.link === null) return null;
    const link = this.link;
    this.writableStream ??= new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await this.ipc.invoke(WEB_SERIAL_WRITE, link, new Uint8Array(chunk));
      },
      close: () => {
        this.writableStream = null;
      },
      abort: () => {
        this.writableStream = null;
      },
    });
    return this.writableStream;
  }

  private readonly onData: IpcListener = (_event, link, bytes) => {
    if (link !== this.link || !(bytes instanceof Uint8Array)) return;
    this.readController?.enqueue(bytes);
  };

  private readonly onClosed: IpcListener = (_event, link) => {
    if (link !== this.link) return;
    this.teardown(lostError());
    const event = new Event('disconnect', { bubbles: true });
    this.ondisconnect?.(event);
    this.dispatchEvent(event);
    this.onLost(this);
  };

  open(options: { baudRate: number }): Promise<void> {
    if (this.link !== null) {
      return Promise.reject(new DOMException('The port is already open.', 'InvalidStateError'));
    }
    this.opening ??= (async () => {
      try {
        const result = (await this.ipc.invoke(
          WEB_SERIAL_OPEN,
          this.portId,
          options.baudRate,
        )) as WebSerialOpenResult;
        this.link = result.link;
        this.ensureReadable();
        this.ipc.on(WEB_SERIAL_DATA_EVENT, this.onData);
        this.ipc.on(WEB_SERIAL_CLOSED_EVENT, this.onClosed);
      } catch (err) {
        throw new DOMException(
          `Failed to open serial port: ${err instanceof Error ? err.message : String(err)}`,
          'NetworkError',
        );
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /** Lenient about locked streams (Web Serial rejects): transports close in varying orders. */
  async close(): Promise<void> {
    const link = this.link;
    if (link === null) return;
    this.teardown(null);
    await this.ipc.invoke(WEB_SERIAL_CLOSE, link);
  }

  async forget(): Promise<void> {
    await this.close();
    this.onForget(this);
  }

  setSignals(): Promise<void> {
    return Promise.reject(
      new DOMException(
        'Serial control signals are not available on the server.',
        'NotSupportedError',
      ),
    );
  }

  getSignals(): Promise<never> {
    return Promise.reject(
      new DOMException(
        'Serial control signals are not available on the server.',
        'NotSupportedError',
      ),
    );
  }

  private teardown(error: Error | null): void {
    this.link = null;
    this.ipc.removeListener(WEB_SERIAL_DATA_EVENT, this.onData);
    this.ipc.removeListener(WEB_SERIAL_CLOSED_EVENT, this.onClosed);
    const controller = this.readController;
    this.readController = null;
    this.readableStream = null;
    this.writableStream = null;
    if (!controller) return;
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch {
      // catch-no-log-ok the reader already cancelled or errored the stream
    }
  }
}

export interface WebSerialPolyfill {
  serial: EventTarget & {
    requestPort: (options?: unknown) => Promise<WebSerialPortPolyfill>;
    getPorts: () => Promise<WebSerialPortPolyfill[]>;
  };
  /** Sends answered in the page (the port picker's answer). */
  localSends: Record<string, (...args: unknown[]) => void>;
}

export function createWebSerialPolyfill(
  ipc: WebSerialIpc,
  storage: WebSerialStorage | null,
): WebSerialPolyfill {
  const ports = new Map<string, WebSerialPortPolyfill>();
  let pickerAnswer: ((portId: string) => void) | null = null;
  const serial = new EventTarget() as WebSerialPolyfill['serial'];

  const loadGranted = (): Set<string> => {
    try {
      const raw = storage?.getItem(GRANTED_SERIAL_PORTS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [],
      );
    } catch {
      // catch-no-log-ok unreadable storage: no remembered ports, the picker still works
      return new Set();
    }
  };
  const saveGranted = (granted: Set<string>): void => {
    try {
      storage?.setItem(GRANTED_SERIAL_PORTS_KEY, JSON.stringify([...granted]));
    } catch {
      // catch-no-log-ok storage full or blocked: reconnect falls back to the picker
    }
  };

  const portFor = (listing: WebSerialPortListing): WebSerialPortPolyfill => {
    let port = ports.get(listing.portId);
    if (port) {
      port.update(listing);
      return port;
    }
    port = new WebSerialPortPolyfill(
      listing,
      ipc,
      (lost) => {
        ports.delete(lost.portId);
        serial.dispatchEvent(new Event('disconnect'));
      },
      (forgotten) => {
        ports.delete(forgotten.portId);
        const granted = loadGranted();
        granted.delete(forgotten.portId);
        saveGranted(granted);
      },
    );
    ports.set(listing.portId, port);
    return port;
  };

  const listServerPorts = async (): Promise<WebSerialPortListing[]> => {
    const value = await ipc.invoke(WEB_SERIAL_LIST);
    return Array.isArray(value) ? value.filter(isWebSerialPortListing) : [];
  };

  serial.requestPort = async () => {
    const listings = await listServerPorts();
    // A picker still open from an earlier request is cancelled, as Electron does.
    pickerAnswer?.('');
    const portId = await new Promise<string>((resolve) => {
      pickerAnswer = resolve;
      ipc.emitLocal(SERIAL_PORTS_DISCOVERED_CHANNEL, [listings]);
    });
    const listing = listings.find((l) => l.portId === portId);
    if (!listing) throw new DOMException('No port selected by the user.', 'NotFoundError');
    const granted = loadGranted();
    granted.add(listing.portId);
    saveGranted(granted);
    return portFor(listing);
  };

  serial.getPorts = async () => {
    const granted = loadGranted();
    // Ports the server has open are offered to every tab: another tab, or the background, opened
    // them, and this tab may join without the picker.
    return (await listServerPorts())
      .filter((l) => granted.has(l.portId) || l.open === true)
      .map(portFor);
  };

  const answer = (portId: string): void => {
    const resolve = pickerAnswer;
    pickerAnswer = null;
    resolve?.(portId);
  };

  return {
    serial,
    localSends: {
      [SERIAL_PORT_SELECTED_CHANNEL]: (portId) => {
        answer(typeof portId === 'string' ? portId : '');
      },
      [SERIAL_PORT_CANCELLED_CHANNEL]: () => {
        answer('');
      },
    },
  };
}
