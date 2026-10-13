// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSerialPortListing } from '../../shared/webSerialBridge';
import {
  createWebSerialPolyfill,
  GRANTED_SERIAL_PORTS_KEY,
  type WebSerialIpc,
  type WebSerialPortPolyfill,
} from './webSerialPolyfill';

type Listener = (event: unknown, ...args: unknown[]) => void;

const RADIO: WebSerialPortListing = {
  portId: '/dev/serial/by-id/usb-radio',
  displayName: 'usb-radio',
  portName: 'ttyUSB0',
  vendorId: '10c4',
  productId: 'ea60',
};

/** A fake bridge: answers serial:* invokes, records local events, lets the test push events. */
function fakeIpc(ports: WebSerialPortListing[] = [RADIO]) {
  const listeners = new Map<string, Set<Listener>>();
  const local: { channel: string; args: unknown[] }[] = [];
  const invoke = vi.fn((channel: string, ...args: unknown[]): Promise<unknown> => {
    if (channel === 'serial:list') return Promise.resolve(ports);
    if (channel === 'serial:open') return Promise.resolve({ link: 7, args });
    return Promise.resolve(undefined);
  });
  const ipc: WebSerialIpc = {
    invoke,
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => listeners.get(channel)?.delete(listener),
    emitLocal: (channel, args) => {
      local.push({ channel, args });
    },
  };
  const push = (channel: string, ...args: unknown[]) => {
    for (const l of listeners.get(channel) ?? []) l({}, ...args);
  };
  return { ipc, invoke, local, push, listeners };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    map,
  };
}

/** requestPort, answering the picker with `portId` once the page shows it. */
async function pick(
  polyfill: ReturnType<typeof createWebSerialPolyfill>,
  local: { channel: string }[],
  portId: string | null,
): Promise<WebSerialPortPolyfill> {
  const request = polyfill.serial.requestPort();
  await vi.waitFor(() => {
    expect(local.some((e) => e.channel === 'serial-ports-discovered')).toBe(true);
  });
  if (portId === null) polyfill.localSends['serial-port-cancelled']?.();
  else polyfill.localSends['serial-port-selected']?.(portId);
  return request;
}

describe('web serial polyfill', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the server ports in the page picker and remembers the pick for getPorts', async () => {
    const f = fakeIpc();
    const storage = memoryStorage();
    const polyfill = createWebSerialPolyfill(f.ipc, storage);
    expect(await polyfill.serial.getPorts()).toEqual([]);
    const port = await pick(polyfill, f.local, RADIO.portId);
    expect(f.local[0]).toEqual({ channel: 'serial-ports-discovered', args: [[RADIO]] });
    expect(port.portId).toBe(RADIO.portId);
    expect(port.getInfo()).toEqual({ usbVendorId: 0x10c4, usbProductId: 0xea60 });
    expect(JSON.parse(storage.map.get(GRANTED_SERIAL_PORTS_KEY) ?? '[]')).toEqual([RADIO.portId]);
    // Same object for the same port, as Web Serial does.
    expect(await polyfill.serial.getPorts()).toEqual([port]);
  });

  it('offers ports the server has open in getPorts, so a new browser can join them', async () => {
    const f = fakeIpc([
      { ...RADIO, open: true },
      { ...RADIO, portId: '/dev/ttyUSB1' },
    ]);
    const polyfill = createWebSerialPolyfill(f.ipc, memoryStorage());
    const ports = await polyfill.serial.getPorts();
    expect(ports.map((p) => p.portId)).toEqual([RADIO.portId]);
  });

  it('rejects with NotFoundError when the picker is cancelled', async () => {
    const f = fakeIpc();
    const polyfill = createWebSerialPolyfill(f.ipc, memoryStorage());
    await expect(pick(polyfill, f.local, null)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('opens on the server, reads pushed bytes for its link, and writes through invoke', async () => {
    const f = fakeIpc();
    const polyfill = createWebSerialPolyfill(f.ipc, memoryStorage());
    const port = await pick(polyfill, f.local, RADIO.portId);
    expect(port.readable).toBeNull();
    await port.open({ baudRate: 115200 });
    expect(f.invoke).toHaveBeenCalledWith('serial:open', RADIO.portId, 115200);
    // Bytes that arrive before anyone reads are queued.
    f.push('serial:data', 7, new Uint8Array([1, 2]));
    f.push('serial:data', 8, new Uint8Array([9])); // another link: ignored
    const reader = port.readable?.getReader();
    expect(await reader?.read()).toEqual({ done: false, value: new Uint8Array([1, 2]) });
    const writer = port.writable?.getWriter();
    await writer?.write(new Uint8Array([3, 4]));
    expect(f.invoke).toHaveBeenCalledWith('serial:write', 7, new Uint8Array([3, 4]));
    writer?.releaseLock();
    reader?.releaseLock();
    await port.close();
    expect(f.invoke).toHaveBeenCalledWith('serial:close', 7);
    expect(port.readable).toBeNull();
    expect(f.listeners.get('serial:data')?.size ?? 0).toBe(0);
  });

  it('errors the streams and fires disconnect when the server reports the device gone', async () => {
    const f = fakeIpc();
    const polyfill = createWebSerialPolyfill(f.ipc, memoryStorage());
    const port = await pick(polyfill, f.local, RADIO.portId);
    await port.open({ baudRate: 115200 });
    const reader = port.readable?.getReader();
    const onPort = vi.fn();
    const onSerial = vi.fn();
    port.addEventListener('disconnect', onPort);
    polyfill.serial.addEventListener('disconnect', onSerial);
    f.push('serial:closed', 7, 'device closed');
    await expect(reader?.read()).rejects.toMatchObject({ name: 'NetworkError' });
    expect(onPort).toHaveBeenCalledTimes(1);
    expect(onSerial).toHaveBeenCalledTimes(1);
    // The port can be opened again (replugged).
    await port.open({ baudRate: 115200 });
    expect(port.readable).not.toBeNull();
  });

  it('reports open failures as NetworkError and stays closed', async () => {
    const f = fakeIpc();
    f.invoke.mockImplementation((channel: string) => {
      if (channel === 'serial:list') return Promise.resolve([RADIO]);
      return Promise.reject(new Error("Error invoking remote method 'serial:open': Error: EBUSY"));
    });
    const polyfill = createWebSerialPolyfill(f.ipc, memoryStorage());
    const port = await pick(polyfill, f.local, RADIO.portId);
    await expect(port.open({ baudRate: 115200 })).rejects.toMatchObject({ name: 'NetworkError' });
    expect(port.readable).toBeNull();
  });

  it('forget() closes the port and drops it from getPorts', async () => {
    const f = fakeIpc();
    const storage = memoryStorage();
    const polyfill = createWebSerialPolyfill(f.ipc, storage);
    const port = await pick(polyfill, f.local, RADIO.portId);
    await port.open({ baudRate: 115200 });
    await port.forget();
    expect(f.invoke).toHaveBeenCalledWith('serial:close', 7);
    expect(await polyfill.serial.getPorts()).toEqual([]);
  });

  it('does not support control signals (firmware flashing)', async () => {
    const f = fakeIpc();
    const polyfill = createWebSerialPolyfill(f.ipc, null);
    const port = await pick(polyfill, f.local, RADIO.portId);
    await expect(port.setSignals()).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});
