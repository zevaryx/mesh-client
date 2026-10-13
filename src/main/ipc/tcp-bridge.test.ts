// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeSocket, sockets } = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    destroyed = false;
    writableEnded = false;
    readableEnded = false;
    remoteAddress = '127.0.0.1';
    remotePort = 5000;
    connecting = false;
    connectPort: number | null = null;
    connectHost: string | null = null;
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    private connectListener: (() => void) | undefined;
    readonly setNoDelay = vi.fn();
    readonly setKeepAlive = vi.fn();
    readonly connect = vi.fn((port: number, host: string, cb?: () => void) => {
      this.connectPort = port;
      this.connectHost = host;
      this.connecting = true;
      this.connectListener = cb;
      return this;
    });
    readonly write = vi.fn((_data: Uint8Array, cb?: (err?: Error) => void) => {
      cb?.();
      return true;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit('close', false);
    });

    constructor() {
      sockets.push(this);
    }

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
      return true;
    }

    completeConnect(): void {
      this.connecting = false;
      this.connectListener?.();
    }
  }
  return { FakeSocket, sockets };
});

vi.mock('net', () => ({
  default: {
    Socket: FakeSocket,
  },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../validate-ipc-sender', () => ({
  assertIpcSender: vi.fn(),
}));

vi.mock('../live-session-meter', () => ({
  clearLiveSessionMeter: vi.fn(),
  noteLiveSessionData: vi.fn(),
  noteLiveSessionWrite: vi.fn(),
  resetLiveSessionMeter: vi.fn(),
}));

vi.mock('../log-service', () => ({
  sanitizeLogMessage: (value: string) => value,
  logDeviceConnection: vi.fn(),
}));

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';

import { noteLiveSessionData, noteLiveSessionWrite } from '../live-session-meter';
import { assertIpcSender } from '../validate-ipc-sender';
import { createLinkSharing } from './linkSharingHost';
import {
  createTcpBridge,
  registerTcpBridgeIpcHandlers,
  TCP_BRIDGE_CONNECT_TIMEOUT_MS,
  TCP_BRIDGE_DATA_MAX_BYTES,
  TCP_BRIDGE_KEEPALIVE_INITIAL_DELAY_MS,
  TCP_BRIDGE_WRITE_MAX_BYTES,
} from './tcp-bridge';

const TCP_BRIDGE_SOURCE = readFileSync(join(__dirname, 'tcp-bridge.ts'), 'utf-8');
const event = {} as IpcMainInvokeEvent;

function validateHost(host: unknown): asserts host is string {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('Invalid host');
  }
}

function latestSocket(): InstanceType<typeof FakeSocket> {
  const sock = sockets[sockets.length - 1];
  if (!sock) throw new Error('expected a FakeSocket');
  return sock;
}

describe('createTcpBridge', () => {
  const send = vi.fn();
  const getMainWindow = (): BrowserWindow =>
    ({ webContents: { send } }) as unknown as BrowserWindow;

  beforeEach(() => {
    sockets.length = 0;
    send.mockReset();
    vi.clearAllMocks();
    vi.mocked(assertIpcSender).mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects MeshCore writes without a socket and returns no-socket for Meshtastic', async () => {
    const meshcore = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const meshtastic = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });

    await expect(meshcore.write(event, [1])).rejects.toThrow(
      'meshcore:tcp-write: no active socket',
    );
    expect(console.warn).toHaveBeenCalledWith('[IPC] meshcore:tcp-write: no active socket');
    expect(meshtastic.write(event, [1])).toBe('no-socket');
    expect(console.debug).toHaveBeenCalledWith('[IPC] meshtastic:tcp-write: no active socket');
  });

  it('keeps independent sockets so one protocol teardown does not affect the other', async () => {
    const meshcore = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const meshtastic = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });

    const meshcoreConnect = meshcore.connect(event, '10.0.0.1', 5000);
    const meshcoreSock = latestSocket();
    meshcoreSock.completeConnect();
    await meshcoreConnect;

    const meshtasticConnect = meshtastic.connect(event, '10.0.0.2', 4403);
    const meshtasticSock = latestSocket();
    meshtasticSock.completeConnect();
    await meshtasticConnect;

    meshcore.disconnect(event);
    await expect(meshtastic.write(event, [9])).resolves.toBeUndefined();
    expect(meshtasticSock.write).toHaveBeenCalled();
    await expect(meshcore.write(event, [9])).rejects.toThrow(
      'meshcore:tcp-write: no active socket',
    );
  });

  it('nulls the active ref before destroy so superseded closes do not emit disconnected', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });

    const first = bridge.connect(event, '192.168.1.8', 5000);
    const firstSock = latestSocket();
    firstSock.completeConnect();
    await first;

    const second = bridge.connect(event, '192.168.1.9', 5000);
    const secondSock = latestSocket();
    expect(firstSock.destroy).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('meshcore:tcp-disconnected');
    secondSock.completeConnect();
    await second;

    firstSock.emit('close', false);
    expect(send).not.toHaveBeenCalledWith('meshcore:tcp-disconnected');

    secondSock.emit('close', true);
    expect(send).toHaveBeenCalledWith('meshcore:tcp-disconnected');
  });

  it('rejects a still-pending connect when a later connect supersedes it', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });

    const first = bridge.connect(event, '192.168.1.8', 5000);
    const firstSock = latestSocket();
    const second = bridge.connect(event, '192.168.1.9', 5000);
    const secondSock = latestSocket();

    await expect(first).rejects.toThrow('meshcore:tcp-connect: closed before connect');
    expect(firstSock.destroy).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('meshcore:tcp-disconnected');

    secondSock.completeConnect();
    await second;
  });

  it('does not emit tcp-data for oversized chunks and destroys the socket', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });
    const connected = bridge.connect(event, '192.168.1.5', 4403);
    const sock = latestSocket();
    sock.completeConnect();
    await connected;

    sock.emit('data', Buffer.alloc(TCP_BRIDGE_DATA_MAX_BYTES + 1));
    expect(sock.destroy).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('meshtastic:tcp-data', expect.anything());
    expect(noteLiveSessionData).not.toHaveBeenCalled();
  });

  it('meters only the active socket and still fans out data from a live session', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const connected = bridge.connect(event, '192.168.1.5', 5000);
    const sock = latestSocket();
    sock.completeConnect();
    await connected;

    sock.emit('data', Buffer.from([1, 2, 3]));
    expect(noteLiveSessionData).toHaveBeenCalledWith('meshcore');
    expect(send).toHaveBeenCalledWith('meshcore:tcp-data', new Uint8Array([1, 2, 3]));
  });

  it('feeds the tap only from the active socket and stops its writes once replaced', async () => {
    const tap = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() };
    const bridge = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
      tap,
    });
    const first = bridge.connect(event, '192.168.1.5', 4403);
    const firstSock = latestSocket();
    firstSock.completeConnect();
    await first;
    expect(tap.onOpen).toHaveBeenCalledTimes(1);
    const tapWrite = tap.onOpen.mock.calls[0]?.[0] as (bytes: Uint8Array) => void;
    firstSock.emit('data', Buffer.from([9, 8]));
    expect(tap.onData).toHaveBeenCalledWith(new Uint8Array([9, 8]));
    tapWrite(new Uint8Array([1]));
    expect(firstSock.write).toHaveBeenCalledWith(new Uint8Array([1]));

    const second = bridge.connect(event, '192.168.1.6', 4403);
    const secondSock = latestSocket();
    expect(tap.onClose).toHaveBeenCalledTimes(1);
    secondSock.completeConnect();
    await second;
    firstSock.emit('data', Buffer.from([7]));
    expect(tap.onData).toHaveBeenCalledTimes(1);
    tapWrite(new Uint8Array([2]));
    expect(firstSock.write).toHaveBeenCalledTimes(1);

    secondSock.emit('close', true);
    expect(tap.onClose).toHaveBeenCalledTimes(2);
    bridge.disconnect(event);
    expect(tap.onClose).toHaveBeenCalledTimes(2);
  });

  it('enables TCP_NODELAY and keepalive, then times out a hung connect', async () => {
    vi.useFakeTimers();
    const bridge = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });
    const pending = bridge.connect(event, '192.168.1.5', 4403);
    const sock = latestSocket();
    expect(sock.setNoDelay).toHaveBeenCalledWith(true);
    expect(sock.setKeepAlive).toHaveBeenCalledWith(true, TCP_BRIDGE_KEEPALIVE_INITIAL_DELAY_MS);
    const expectation = expect(pending).rejects.toThrow(
      'meshtastic:tcp-connect: connection timeout',
    );
    await vi.advanceTimersByTimeAsync(TCP_BRIDGE_CONNECT_TIMEOUT_MS);
    await expectation;
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('returns no-socket for Meshtastic writes on a destroyed or classified-dead socket', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });
    const connected = bridge.connect(event, '192.168.1.5', 4403);
    const sock = latestSocket();
    sock.completeConnect();
    await connected;

    sock.destroyed = true;
    expect(bridge.write(event, [1])).toBe('no-socket');

    sock.destroyed = false;
    sock.writableEnded = true;
    expect(bridge.write(event, [1])).toBe('no-socket');

    sock.writableEnded = false;
    sock.write.mockImplementationOnce((_data: Uint8Array, cb?: (err?: Error) => void) => {
      const err = new Error('write EPIPE') as NodeJS.ErrnoException;
      err.code = 'EPIPE';
      cb?.(err);
      return true;
    });
    await expect(bridge.write(event, [1])).resolves.toBe('no-socket');
  });

  it('rejects MeshCore write errors instead of mapping them to no-socket', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const connected = bridge.connect(event, '192.168.1.5', 5000);
    const sock = latestSocket();
    sock.completeConnect();
    await connected;

    sock.write.mockImplementationOnce((_data: Uint8Array, cb?: (err?: Error) => void) => {
      const err = new Error('write EPIPE') as NodeJS.ErrnoException;
      err.code = 'EPIPE';
      cb?.(err);
      return true;
    });
    await expect(bridge.write(event, [1])).rejects.toThrow('write EPIPE');
    expect(noteLiveSessionWrite).not.toHaveBeenCalled();
  });

  it('rejects invalid ports, hosts, and write payloads before touching the socket', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    await expect(bridge.connect(event, '192.168.1.5', 0)).rejects.toThrow('Invalid port');
    await expect(bridge.connect(event, '', 5000)).rejects.toThrow('Invalid host');
    expect(sockets).toHaveLength(0);
    await expect(bridge.write(event, [256])).rejects.toThrow(
      'meshcore:tcp-write: byte values must be integers 0-255',
    );
    await expect(
      bridge.write(event, new Array(TCP_BRIDGE_WRITE_MAX_BYTES + 1).fill(1)),
    ).rejects.toThrow('invalid or oversized payload');
  });

  it('destroyForQuit tears down without emitting disconnected', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const connected = bridge.connect(event, '192.168.1.5', 5000);
    const sock = latestSocket();
    sock.completeConnect();
    await connected;

    bridge.destroyForQuit('quitMainProcess TCP socket destroy (ignored)');
    expect(sock.destroy).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('meshcore:tcp-disconnected');
    await expect(bridge.write(event, [1])).rejects.toThrow('meshcore:tcp-write: no active socket');
  });

  it('does not null the active socket in the error handler so close can emit disconnected', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
    });
    const pending = bridge.connect(event, '192.168.1.5', 5000);
    const sock = latestSocket();
    const boom = new Error('ECONNRESET');
    sock.emit('error', boom);
    await expect(pending).rejects.toThrow('ECONNRESET');
    expect(send).not.toHaveBeenCalledWith('meshcore:tcp-disconnected');
    sock.emit('close', true);
    expect(send).toHaveBeenCalledWith('meshcore:tcp-disconnected');
  });
});

describe('registerTcpBridgeIpcHandlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
  });

  it('registers both protocol channel literals with assertIpcSender inside the shared handlers', () => {
    registerTcpBridgeIpcHandlers({
      getMainWindow: () => null,
      validateHost,
    });
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      'meshcore:tcp-connect',
      'meshcore:tcp-write',
      'meshcore:tcp-disconnect',
      'meshtastic:tcp-connect',
      'meshtastic:tcp-write',
      'meshtastic:tcp-disconnect',
    ]);
    expect(TCP_BRIDGE_SOURCE).toContain("writeMissing: 'reject'");
    expect(TCP_BRIDGE_SOURCE).toContain("writeMissing: 'no-socket'");
    expect(TCP_BRIDGE_SOURCE).toContain('assertIpcSender(event, connectChannel)');
    expect(TCP_BRIDGE_SOURCE).toContain('assertIpcSender(event, writeChannel)');
    expect(TCP_BRIDGE_SOURCE).toContain('assertIpcSender(event, disconnectChannel)');
  });
});

describe('createTcpBridge shared viewing (headless tabs)', () => {
  const send = vi.fn();
  const getMainWindow = (): BrowserWindow =>
    ({ webContents: { send } }) as unknown as BrowserWindow;
  const announce = vi.fn();

  /** A browser tab's IPC event: `sender.id` is its session; `destroy()` closes the tab. */
  function tab(id: number) {
    const onDestroyed: (() => void)[] = [];
    const ev = {
      sender: {
        id,
        once: (name: string, fn: () => void) => {
          if (name === 'destroyed') onDestroyed.push(fn);
        },
      },
    } as unknown as IpcMainInvokeEvent;
    return {
      ev,
      close: () => {
        for (const fn of onDestroyed) fn();
      },
    };
  }

  function sharedBridge() {
    return createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
      sharing: createLinkSharing({
        sessionOf: (e) => (e.sender as unknown as { id: number }).id,
        announce,
      }),
    });
  }

  async function open(bridge: ReturnType<typeof sharedBridge>, ev: IpcMainInvokeEvent) {
    const pending = bridge.connect(ev, '10.0.0.5', 4403);
    latestSocket().completeConnect();
    await pending;
  }

  beforeEach(() => {
    sockets.length = 0;
    vi.clearAllMocks();
    vi.mocked(assertIpcSender).mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('lets a second tab join the open link instead of reconnecting the radio', async () => {
    const bridge = sharedBridge();
    await open(bridge, tab(1).ev);
    expect(announce).toHaveBeenCalledWith('meshtastic', {
      state: 'connected',
      transport: 'tcp',
      host: '10.0.0.5',
      port: 4403,
    });
    await bridge.connect(tab(2).ev, '10.0.0.5', 4403);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.destroy).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('gives a tab already on the link a real reconnect (its own recovery path)', async () => {
    const bridge = sharedBridge();
    const a = tab(1);
    await open(bridge, a.ev);
    await open(bridge, a.ev);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]?.destroy).toHaveBeenCalled();
  });

  it('opens a new link for another target, a closed tab, or while the link is connecting', async () => {
    const bridge = sharedBridge();
    const a = tab(1);
    const b = tab(2);
    await open(bridge, a.ev);
    await open(bridge, b.ev); // b was not on it, but its first connect attaches…
    expect(sockets).toHaveLength(1);
    b.close(); // …and a closed tab that reopens joins again rather than reconnecting
    await bridge.connect(tab(2).ev, '10.0.0.5', 4403);
    expect(sockets).toHaveLength(1);
    const other = bridge.connect(tab(3).ev, '10.0.0.6', 4403);
    expect(sockets).toHaveLength(2);
    // The replacement is still connecting: a fourth tab cannot join it yet.
    const joinWhileConnecting = bridge.connect(tab(4).ev, '10.0.0.6', 4403);
    expect(sockets).toHaveLength(3);
    latestSocket().completeConnect();
    await joinWhileConnecting;
    await expect(other).rejects.toThrow('closed before connect');
  });

  it("announces a user's disconnect to every tab and forgets who was on the link", async () => {
    const bridge = sharedBridge();
    const a = tab(1);
    await open(bridge, a.ev);
    await bridge.connect(tab(2).ev, '10.0.0.5', 4403);
    bridge.disconnect(a.ev);
    expect(announce).toHaveBeenLastCalledWith('meshtastic', {
      state: 'disconnected',
      transport: 'tcp',
    });
    // Disconnect with no link (the other tab following it) is not announced again.
    bridge.disconnect(tab(2).ev);
    expect(announce).toHaveBeenCalledTimes(2);
    await open(bridge, a.ev);
    expect(sockets).toHaveLength(2);
  });

  it('ignores a disconnect from a tab that is not on the link (its pre-connect cleanup)', async () => {
    const bridge = sharedBridge();
    await open(bridge, tab(1).ev);
    bridge.disconnect(tab(2).ev);
    expect(sockets[0]?.destroy).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledTimes(1);
    await bridge.connect(tab(2).ev, '10.0.0.5', 4403);
    expect(sockets).toHaveLength(1);
  });

  it('serializes MeshCore commands from several tabs and replies only to the asker', async () => {
    const tabSend = { 1: vi.fn(), 2: vi.fn() };
    const mkTab = (id: 1 | 2) =>
      ({
        sender: { id, send: tabSend[id], once: () => {} },
      }) as unknown as IpcMainInvokeEvent;
    const bridge = createTcpBridge({
      protocol: 'meshcore',
      writeMissing: 'reject',
      getMainWindow,
      validateHost,
      sharing: createLinkSharing({
        sessionOf: (e) => (e.sender as unknown as { id: number }).id,
        announce,
      }),
    });
    const pending = bridge.connect(mkTab(1), '10.0.0.5', 5000);
    latestSocket().completeConnect();
    await pending;
    await bridge.connect(mkTab(2), '10.0.0.5', 5000);
    const sock = latestSocket();
    await bridge.write(mkTab(1), [0x3c, 1, 0, 1]); // app start
    await bridge.write(mkTab(2), [0x3c, 1, 0, 1]);
    expect(sock.write).toHaveBeenCalledTimes(1);
    sock.emit('data', Buffer.from([0x3e, 2, 0, 5, 9])); // self info → tab 1
    expect(tabSend[1]).toHaveBeenCalledWith(
      'meshcore:tcp-data',
      Uint8Array.from([0x3e, 2, 0, 5, 9]),
    );
    expect(tabSend[2]).not.toHaveBeenCalled();
    expect(sock.write).toHaveBeenCalledTimes(2);
    sock.emit('data', Buffer.from([0x3e, 1, 0, 0x83])); // MsgWaiting push → every tab
    expect(send).toHaveBeenCalledWith('meshcore:tcp-data', Uint8Array.from([0x3e, 1, 0, 0x83]));
  });

  it('after a link drop the first reconnecting tab opens it and the rest join', async () => {
    const bridge = sharedBridge();
    const a = tab(1);
    const b = tab(2);
    await open(bridge, a.ev);
    await bridge.connect(b.ev, '10.0.0.5', 4403);
    sockets[0]?.emit('close', true);
    expect(send).toHaveBeenCalledWith('meshtastic:tcp-disconnected');
    await open(bridge, a.ev);
    await bridge.connect(b.ev, '10.0.0.5', 4403);
    expect(sockets).toHaveLength(2);
  });

  it('keeps the desktop behavior without sharing: every connect replaces the socket', async () => {
    const bridge = createTcpBridge({
      protocol: 'meshtastic',
      writeMissing: 'no-socket',
      getMainWindow,
      validateHost,
    });
    for (const id of [1, 2]) {
      const pending = bridge.connect(tab(id).ev, '10.0.0.5', 4403);
      latestSocket().completeConnect();
      await pending;
    }
    expect(sockets).toHaveLength(2);
  });
});
