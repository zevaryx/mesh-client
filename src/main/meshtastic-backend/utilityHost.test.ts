// @vitest-environment node
import { EventEmitter } from 'node:events';

import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import {
  createDesktopMeshtasticBackend,
  isDesktopMeshtasticBackendEnabled,
} from './desktopBackend';
import type { MeshtasticBackendCommand, MeshtasticBackendHandle } from './hostProtocol';
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
  return { persistMessage: vi.fn(), onCaughtUp: vi.fn() };
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
    handle.tap.onOpen(write);
    handle.tap.onData(new Uint8Array([1, 2]));
    handle.tap.onClose();
    expect(child.sent).toEqual([
      { t: 'present', value: true },
      { t: 'open' },
      { t: 'data', bytes: new Uint8Array([1, 2]) },
      { t: 'close' },
    ]);

    handle.tap.onOpen(write);
    child.emit('message', { t: 'write', frame: new Uint8Array([9]) });
    child.emit('message', { t: 'persist', row: { payload: 'x' } });
    child.emit('message', { t: 'caughtUp', count: 3 });
    child.emit('message', { t: 'persist' }); // malformed
    expect(write).toHaveBeenCalledWith(new Uint8Array([9]));
    expect(d.persistMessage).toHaveBeenCalledWith({ payload: 'x' });
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
      missing.tap.onData(new Uint8Array([1]));
      missing.dispose();
    }).not.toThrow();

    const child = new FakeChild();
    const handle = startUtilityMeshtasticBackend(deps(), () => child);
    child.emit('exit', 1);
    handle.tap.onData(new Uint8Array([1]));
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
      tap: { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      setRendererPresent: (p) => present.push(p),
      dispose: vi.fn(),
    };
    const desktop = createDesktopMeshtasticBackend(deps(), () => inner);
    desktop.tap.onData(new Uint8Array([1])); // before start: dropped
    expect(inner.tap.onData).not.toHaveBeenCalled();

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

    desktop.tap.onData(new Uint8Array([2]));
    expect(inner.tap.onData).toHaveBeenCalledWith(new Uint8Array([2]));
    desktop.dispose();
    expect(inner.dispose).toHaveBeenCalled();
  });
});
