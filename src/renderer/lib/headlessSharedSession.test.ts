import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSharedSessionSync,
  SHARED_SESSION_RELOAD_DEBOUNCE_MS,
  sharedLinkConnectArgs,
} from './headlessSharedSession';

function setup(status = 'disconnected') {
  const refresh = {
    refreshMessagesFromDb: vi.fn(() => Promise.resolve()),
    refreshNodesFromDb: vi.fn(() => Promise.resolve()),
  };
  const link = {
    status: vi.fn(() => status),
    join: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
  };
  const sync = createSharedSessionSync({ refresh: () => refresh, link: () => link });
  return { refresh, link, sync };
}

describe('createSharedSessionSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reloads once per burst of changes, per protocol and kind', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) t.sync.onDataChanged({ protocol: 'meshtastic', kind: 'messages' });
    t.sync.onDataChanged({ protocol: 'meshtastic', kind: 'nodes' });
    vi.advanceTimersByTime(SHARED_SESSION_RELOAD_DEBOUNCE_MS);
    expect(t.refresh.refreshMessagesFromDb).toHaveBeenCalledTimes(1);
    expect(t.refresh.refreshNodesFromDb).toHaveBeenCalledTimes(1);
  });

  it('joins a link another tab opened only while this tab is disconnected', () => {
    const t = setup('disconnected');
    t.sync.onLinkChanged({
      protocol: 'meshtastic',
      transport: 'tcp',
      state: 'connected',
      host: 'fd00::1',
      port: 4403,
    });
    expect(t.link.join).toHaveBeenCalledWith(expect.objectContaining({ host: 'fd00::1' }));
    const busy = setup('configured');
    busy.sync.onLinkChanged({
      protocol: 'meshcore',
      transport: 'tcp',
      state: 'connected',
      host: '10.0.0.5',
      port: 5000,
    });
    expect(busy.link.join).not.toHaveBeenCalled();
  });

  it("follows another tab's disconnect, and ignores it when already disconnected", () => {
    const connected = setup('configured');
    connected.sync.onLinkChanged({
      protocol: 'meshtastic',
      transport: 'tcp',
      state: 'disconnected',
    });
    expect(connected.link.disconnect).toHaveBeenCalledTimes(1);
    const idle = setup('disconnected');
    idle.sync.onLinkChanged({ protocol: 'meshtastic', transport: 'tcp', state: 'disconnected' });
    expect(idle.link.disconnect).not.toHaveBeenCalled();
  });

  it('logs failed reloads and joins instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.refresh.refreshMessagesFromDb.mockRejectedValueOnce(new Error('db closed'));
    t.link.join.mockRejectedValueOnce(new Error('refused'));
    t.sync.onDataChanged({ protocol: 'meshcore', kind: 'messages' });
    vi.advanceTimersByTime(SHARED_SESSION_RELOAD_DEBOUNCE_MS);
    t.sync.onLinkChanged({
      protocol: 'meshcore',
      transport: 'tcp',
      state: 'connected',
      host: '10.0.0.5',
      port: 5000,
    });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('sharedLinkConnectArgs', () => {
  const tcp = {
    protocol: 'meshtastic',
    transport: 'tcp',
    state: 'connected',
    host: 'fd00::1',
    port: 4403,
  } as const;

  it("reuses the connecting tab's saved type and address (HTTPS, MeshCore's http)", () => {
    expect(sharedLinkConnectArgs(tcp, { type: 'http', httpAddress: '10.0.0.5:5000' })).toEqual({
      type: 'http',
      address: '10.0.0.5:5000',
    });
    expect(
      sharedLinkConnectArgs(
        { protocol: 'meshtastic', transport: 'http', state: 'connected', host: 'r.lan', tls: true },
        { type: 'http', httpAddress: 'https://r.lan' },
      ),
    ).toEqual({ type: 'http', address: 'https://r.lan' });
  });

  it('falls back to the announced target', () => {
    expect(sharedLinkConnectArgs(tcp, { type: 'ble' })).toEqual({
      type: 'tcp',
      address: '[fd00::1]:4403',
    });
    expect(
      sharedLinkConnectArgs(
        {
          protocol: 'meshtastic',
          transport: 'http',
          state: 'connected',
          host: 'r.lan',
          tls: false,
        },
        null,
      ),
    ).toEqual({ type: 'http', address: 'r.lan' });
    expect(
      sharedLinkConnectArgs(
        { protocol: 'meshcore', transport: 'tcp', state: 'disconnected' },
        null,
      ),
    ).toBeNull();
  });
});
