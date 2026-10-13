/**
 * Server-side serial for the headless web UI. The browser bridge replaces `navigator.serial` with a
 * polyfill (`preload/web/webSerialPolyfill.ts`) whose ports live on the server
 * (`main/headless/serialBridge.ts`), so the renderer's Web Serial code (Meshtastic, MeshCore) runs
 * unchanged against a radio plugged into the server.
 */

/** `() => WebSerialPortListing[]`: the server's serial ports. */
export const WEB_SERIAL_LIST = 'serial:list';
/** `(portId, baudRate) => { link }`: open the port, or join it when another tab has it open. */
export const WEB_SERIAL_OPEN = 'serial:open';
/** `(link, bytes: Uint8Array) => void` */
export const WEB_SERIAL_WRITE = 'serial:write';
/** `(link) => void`: disconnect; the port closes when no other tab is on it (a closed tab keeps it). */
export const WEB_SERIAL_CLOSE = 'serial:close';
/** Push `(link, bytes: Uint8Array)` to the tabs on the link. */
export const WEB_SERIAL_DATA_EVENT = 'serial:data';
/** Push `(link, reason: string)`: the port went away (unplugged, read error). */
export const WEB_SERIAL_CLOSED_EVENT = 'serial:closed';

/** Same shape as Electron's `select-serial-port` list (`SerialPortInfo` in the renderer). */
export interface WebSerialPortListing {
  /** Stable device path on the server (`/dev/serial/by-id/…` when there is one). */
  portId: string;
  displayName: string;
  portName: string;
  /** USB ids as 4-digit lowercase hex, like Electron's port list. */
  vendorId?: string;
  productId?: string;
  /** The server has this port open (a tab or the background): every tab may join it. */
  open?: boolean;
}

export interface WebSerialOpenResult {
  link: number;
}

/** Baud rates the server accepts (what `stty` takes on Linux and macOS). */
export const WEB_SERIAL_BAUD_RATES: readonly number[] = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

export function isWebSerialPortListing(value: unknown): value is WebSerialPortListing {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.portId === 'string' &&
    typeof v.displayName === 'string' &&
    typeof v.portName === 'string' &&
    (v.vendorId === undefined || typeof v.vendorId === 'string') &&
    (v.productId === undefined || typeof v.productId === 'string') &&
    (v.open === undefined || typeof v.open === 'boolean')
  );
}
