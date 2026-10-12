// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { createDesktopMeshtasticBackend } from './desktopBackend';
import { isDesktopMeshtasticBackendEnabled } from './desktopBackendFlag';
import { loadDesktopMeshtasticHost } from './desktopHostLoader';
import {
  createMeshtasticLinkTaps,
  type MeshtasticBackendCommand,
  type MeshtasticBackendHandle,
} from './hostProtocol';
import { type MeshtasticBackendChild, startUtilityMeshtasticBackend } from './utilityHost';

class FakeChild extends EventEmitter implements MeshtasticBackendChild {
  sent: MeshtasticBackendCommand[] = [];
  killed = false;
  postMessage(message: MeshtasticBackendCommand): void {
    this.sent.push(message);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function deps() {
  return { persist: vi.fn(), onCaughtUp: vi.fn() };
}

describe('startUtilityMeshtasticBackend', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('relays tap and presence to the worker and worker events to the host', () => {
    const child = new FakeChild();
    const d = deps();
    const handle = startUtilityMeshtasticBackend(d, () => child);
    const write = vi.fn();
    handle.setRendererPresent(true);
    handle.taps.tcp.onOpen(write);
    handle.taps.tcp.onData(new Uint8Array([1, 2]));
    handle.taps.tcp.onClose();
    expect(child.sent).toEqual([
      { t: 'present', value: true },
      { t: 'open', kind: 'tcp', origin: 'renderer' },
      { t: 'data', bytes: new Uint8Array([1, 2]) },
      { t: 'close', kind: 'tcp' },
    ]);

    handle.taps.tcp.onOpen(write);
    child.emit('message', { t: 'write', frame: new Uint8Array([9]) });
    child.emit('message', { t: 'persist', record: { kind: 'message', row: { payload: 'x' } } });
    child.emit('message', { t: 'caughtUp', count: 3 });
    child.emit('message', { t: 'persist' }); // malformed
    expect(write).toHaveBeenCalledWith(new Uint8Array([9]));
    expect(d.persist).toHaveBeenCalledWith({ kind: 'message', row: { payload: 'x' } });
    expect(d.onCaughtUp).toHaveBeenCalledWith(3);
    expect(console.warn).toHaveBeenCalledWith(
      '[meshtastic-backend] dropped malformed worker event',
    );

    handle.dispose();
    expect(child.killed).toBe(true);
  });

  it('becomes a no-op when the worker is missing or exits', () => {
    const missing = startUtilityMeshtasticBackend(deps(), () => null);
    expect(() => {
      missing.taps.tcp.onData(new Uint8Array([1]));
      missing.dispose();
    }).not.toThrow();

    const child = new FakeChild();
    const handle = startUtilityMeshtasticBackend(deps(), () => child);
    child.emit('exit', 1);
    handle.taps.tcp.onOpen(vi.fn());
    handle.taps.tcp.onData(new Uint8Array([1]));
    expect(child.sent).toEqual([]);
  });
});

describe('createDesktopMeshtasticBackend', () => {
  it('is opt-in through MESH_CLIENT_MESHTASTIC_BACKEND=on', () => {
    expect(isDesktopMeshtasticBackendEnabled({})).toBe(false);
    expect(isDesktopMeshtasticBackendEnabled({ MESH_CLIENT_MESHTASTIC_BACKEND: ' ON ' })).toBe(
      true,
    );
    expect(isDesktopMeshtasticBackendEnabled({ MESH_CLIENT_MESHTASTIC_BACKEND: 'off' })).toBe(
      false,
    );
  });

  // No OS branch: the same Electron window events drive presence on linux, darwin and win32.
  it('forwards the tap after start and tracks renderer presence from window events', () => {
    const present: boolean[] = [];
    const inner: MeshtasticBackendHandle = {
      taps: {
        tcp: { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
        http: { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn(), onUserDisconnect: vi.fn() },
        ble: { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      },
      setRendererPresent: (p) => present.push(p),
      dispose: vi.fn(),
    };
    const keeperDeps = { connect: vi.fn(), loadTarget: () => null, saveTarget: vi.fn() };
    const desktop = createDesktopMeshtasticBackend(deps(), keeperDeps, () => inner);
    desktop.taps.tcp.onData(new Uint8Array([1])); // before start: dropped
    expect(inner.taps.tcp.onData).not.toHaveBeenCalled();

    const wc = new EventEmitter();
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    desktop.watchWindow(win as unknown as BrowserWindow);
    desktop.start();
    wc.emit('did-finish-load');
    wc.emit('did-start-loading'); // reload: not decoding until it finishes
    wc.emit('did-finish-load');
    wc.emit('render-process-gone');
    win.emit('closed');
    expect(present).toEqual([false, true, false, true, false, false]);

    desktop.taps.ble.onData(new Uint8Array([2]));
    expect(inner.taps.ble.onData).toHaveBeenCalledWith(new Uint8Array([2]));
    expect(inner.taps.tcp.onData).not.toHaveBeenCalled();
    // Link info and explicit disconnects reach the keeper behind the forwarding taps.
    const write = vi.fn();
    const info = {
      origin: 'renderer' as const,
      target: { kind: 'tcp' as const, host: 'radio', port: 4403 },
    };
    desktop.taps.tcp.onOpen(write, info);
    expect(inner.taps.tcp.onOpen).toHaveBeenCalledWith(write, info);
    desktop.taps.http.onUserDisconnect?.();
    expect(inner.taps.http.onUserDisconnect).toHaveBeenCalled();
    // BLE packets from the sidecar GATT proxy reach the BLE tap.
    const proxy = Object.assign(new EventEmitter(), { toRadio: vi.fn() });
    desktop.attachGatt(proxy);
    proxy.emit('fromRadio', { sessionId: 'meshtastic', bytes: new Uint8Array([3]) });
    expect(inner.taps.ble.onData).toHaveBeenCalledWith(new Uint8Array([3]));
    desktop.dispose();
    expect(inner.dispose).toHaveBeenCalled();
  });
});

describe('loadDesktopMeshtasticHost', () => {
  it('returns null (and warns) when the host bundle was not built, and loads it when present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-backend-host-'));
    try {
      expect(loadDesktopMeshtasticHost(dir)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[meshtastic-backend] meshtastic-backend-host.js not built; disabled',
      );
      fs.writeFileSync(
        path.join(dir, 'meshtastic-backend-host.js'),
        'exports.createDesktopMeshtasticBackend = () => "loaded";',
      );
      expect(loadDesktopMeshtasticHost(dir)?.createDesktopMeshtasticBackend).toBeTypeOf('function');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      warn.mockRestore();
    }
  });
});

describe('createMeshtasticLinkTaps', () => {
  it('feeds only the most recently opened link and sends heartbeats to it', () => {
    const sent: MeshtasticBackendCommand[] = [];
    const links = createMeshtasticLinkTaps((cmd) => sent.push(cmd));
    const httpWrite = vi.fn();
    const tcpWrite = vi.fn();
    links.taps.http.onOpen(httpWrite);
    links.taps.tcp.onOpen(tcpWrite); // renderer switched transports; HTTP still polling
    links.taps.http.onData(new Uint8Array([1])); // stale link: ignored
    links.taps.tcp.onData(new Uint8Array([2]));
    links.write(new Uint8Array([9]));
    links.taps.http.onClose(); // stale close: ignored
    expect(sent).toEqual([
      { t: 'open', kind: 'http', origin: 'renderer' },
      { t: 'open', kind: 'tcp', origin: 'renderer' },
      { t: 'data', bytes: new Uint8Array([2]) },
    ]);
    expect(tcpWrite).toHaveBeenCalledWith(new Uint8Array([9]));
    expect(httpWrite).not.toHaveBeenCalled();
    links.taps.tcp.onClose();
    links.write(new Uint8Array([8]));
    expect(sent.at(-1)).toEqual({ t: 'close', kind: 'tcp' });
    expect(tcpWrite).toHaveBeenCalledTimes(1);
  });
});
