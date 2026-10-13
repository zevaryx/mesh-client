// @vitest-environment node
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));
vi.mock('../validate-ipc-sender', () => ({ assertIpcSender: vi.fn() }));

const { registerSerialBridgeIpcHandlers } = await import('./serialBridge');
import type { SerialDevice } from './serialDevice';

/** A fake device: records writes; `radio()` / `unplug()` drive it from the radio side. */
class FakeDevice implements SerialDevice {
  written: Uint8Array[] = [];
  closed = false;
  private dataListener: ((bytes: Uint8Array) => void) | null = null;
  private closeListener: ((reason: string) => void) | null = null;
  write = vi.fn((bytes: Uint8Array) => {
    this.written.push(bytes);
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.closed = true;
  });
  onData(listener: (bytes: Uint8Array) => void): void {
    this.dataListener = listener;
  }
  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }
  radio(bytes: number[]): void {
    this.dataListener?.(new Uint8Array(bytes));
  }
  unplug(): void {
    this.closeListener?.('device closed');
  }
}

/** A browser tab: its IPC events carry `sender.id`; `close()` emits `destroyed`. */
function tab(id: number) {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const event = { sender: { id, send, once: emitter.once.bind(emitter) } };
  return {
    send,
    close: () => emitter.emit('destroyed'),
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)?.(event, ...args),
  };
}

const PORT = '/dev/serial/by-id/usb-radio';

function setup() {
  handlers.clear();
  const devices: FakeDevice[] = [];
  const openDevice = vi.fn(() => {
    const d = new FakeDevice();
    devices.push(d);
    return Promise.resolve(d);
  });
  const bridge = registerSerialBridgeIpcHandlers({
    listPorts: () => [{ portId: PORT, displayName: 'radio', portName: 'ttyUSB0' }],
    openDevice,
  });
  return { bridge, devices, openDevice };
}

/** MeshCore frame: '<' (to radio) or '>' (from radio), uint16 LE length, payload. */
function mcFrame(marker: '<' | '>', payload: number[]): number[] {
  return [marker.charCodeAt(0), payload.length & 0xff, payload.length >> 8, ...payload];
}

describe('serial bridge (headless)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('lists the server ports and opens only listed ports at supported baud rates', async () => {
    const t = setup();
    const a = tab(1);
    expect(a.call('serial:list')).toEqual([
      { portId: PORT, displayName: 'radio', portName: 'ttyUSB0' },
    ]);
    await expect(a.call('serial:open', '/etc/passwd', 115200)).rejects.toThrow('unknown port');
    await expect(a.call('serial:open', PORT, 12345)).rejects.toThrow('unsupported baud rate');
    expect(t.openDevice).not.toHaveBeenCalled();
    await expect(a.call('serial:open', PORT, 115200)).resolves.toEqual({ link: 1 });
    expect(t.openDevice).toHaveBeenCalledWith(PORT, 115200);
  });

  it('shares one device between tabs, keeps it when tabs close, closes it on the last disconnect', async () => {
    const t = setup();
    const a = tab(1);
    const b = tab(2);
    const [ra, rb] = await Promise.all([
      a.call('serial:open', PORT, 115200),
      b.call('serial:open', PORT, 9600),
    ]);
    expect(ra).toEqual(rb);
    expect(t.openDevice).toHaveBeenCalledTimes(1);
    // Meshtastic (not '<'): writes pass through and every tab gets the radio's bytes.
    await a.call('serial:write', 1, new Uint8Array([0x94, 0xc3, 0, 1, 7]));
    await b.call('serial:write', 1, new Uint8Array([0x94, 0xc3, 0, 1, 8]));
    expect(t.devices[0]?.written).toHaveLength(2);
    t.devices[0]?.radio([0x94, 0xc3, 0, 1, 9]);
    expect(a.send).toHaveBeenCalledWith('serial:data', 1, new Uint8Array([0x94, 0xc3, 0, 1, 9]));
    expect(b.send).toHaveBeenCalledWith('serial:data', 1, new Uint8Array([0x94, 0xc3, 0, 1, 9]));

    a.call('serial:close', 1);
    expect(t.devices[0]?.closed).toBe(false);
    // The last tab going away (closed, reloaded) keeps the radio connected, like a TCP link...
    b.close();
    expect(t.devices[0]?.closed).toBe(false);
    // ...a tab that comes back joins it...
    const c = tab(3);
    await expect(c.call('serial:open', PORT, 115200)).resolves.toEqual({ link: 1 });
    expect(t.openDevice).toHaveBeenCalledTimes(1);
    // ...and the last tab's explicit disconnect closes it.
    c.call('serial:close', 1);
    expect(t.devices[0]?.closed).toBe(true);
    await tab(4).call('serial:open', PORT, 115200);
    expect(t.openDevice).toHaveBeenCalledTimes(2);
  });

  it('rejects writes from a tab that is not on the link, and oversized writes', async () => {
    setup();
    const a = tab(1);
    await a.call('serial:open', PORT, 115200);
    await expect(tab(2).call('serial:write', 1, new Uint8Array([1]))).rejects.toThrow(
      'port not open',
    );
    await expect(a.call('serial:write', 1, [1, 2])).rejects.toThrow('invalid or oversized');
    await expect(a.call('serial:write', 1, new Uint8Array(64 * 1024 + 1))).rejects.toThrow(
      'invalid or oversized',
    );
  });

  it('serializes MeshCore commands: replies to the asking tab, pushes to all', async () => {
    const t = setup();
    const a = tab(1);
    const b = tab(2);
    await a.call('serial:open', PORT, 115200);
    await b.call('serial:open', PORT, 115200);
    await a.call('serial:write', 1, new Uint8Array(mcFrame('<', [22])));
    await b.call('serial:write', 1, new Uint8Array(mcFrame('<', [5])));
    const device = t.devices[0];
    // Only A's command is on the wire until it is answered.
    expect(device?.written).toEqual([new Uint8Array(mcFrame('<', [22]))]);
    device?.radio(mcFrame('>', [5, 1]));
    expect(a.send).toHaveBeenCalledWith('serial:data', 1, new Uint8Array(mcFrame('>', [5, 1])));
    expect(b.send).not.toHaveBeenCalled();
    expect(device?.written).toHaveLength(2);
    device?.radio(mcFrame('>', [0x83]));
    expect(a.send).toHaveBeenCalledWith('serial:data', 1, new Uint8Array(mcFrame('>', [0x83])));
    expect(b.send).toHaveBeenCalledWith('serial:data', 1, new Uint8Array(mcFrame('>', [0x83])));
  });

  it('tells the tabs when the device goes away and drops the link', async () => {
    const t = setup();
    const a = tab(1);
    await a.call('serial:open', PORT, 115200);
    t.devices[0]?.unplug();
    expect(a.send).toHaveBeenCalledWith('serial:closed', 1, 'device closed');
    await expect(a.call('serial:write', 1, new Uint8Array([1]))).rejects.toThrow('port not open');
    await a.call('serial:open', PORT, 115200);
    expect(t.openDevice).toHaveBeenCalledTimes(2);
  });

  it('closes every device on shutdown', async () => {
    const t = setup();
    await tab(1).call('serial:open', PORT, 115200);
    t.bridge.closeAll();
    expect(t.devices[0]?.closed).toBe(true);
  });
});
