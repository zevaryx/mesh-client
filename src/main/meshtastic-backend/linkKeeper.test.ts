// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MESHTASTIC_LINK_KEEPER_MAX_RETRY_MS,
  MESHTASTIC_LINK_KEEPER_MIN_RETRY_MS,
  MESHTASTIC_LINK_KEEPER_STARTUP_DELAY_MS,
  MeshtasticLinkKeeper,
} from './linkKeeper';
import { type MeshtasticLinkTarget, parseMeshtasticLinkTarget } from './linkTarget';

const RADIO: MeshtasticLinkTarget = { kind: 'tcp', host: '192.168.1.20', port: 4403 };

function setup(saved: MeshtasticLinkTarget | null = RADIO) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let stored = saved;
  const connect = vi.fn<(target: MeshtasticLinkTarget) => Promise<void>>(() => Promise.resolve());
  const keeper = new MeshtasticLinkKeeper({
    connect,
    loadTarget: () => stored,
    saveTarget: (t) => {
      stored = t;
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const tap = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn(), onUserDisconnect: vi.fn() };
  const wrapped = keeper.wrap(tap);
  const pending = () => timers.filter((t) => !t.cleared);
  /** Fire the pending timer and let the connect attempt settle. */
  const fire = async () => {
    const t = pending().at(-1);
    if (!t) throw new Error('no pending timer');
    t.cleared = true;
    t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { keeper, connect, tap, wrapped, pending, fire, stored: () => stored };
}

describe('MeshtasticLinkKeeper', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconnects the saved radio after the startup grace when no renderer shows up', async () => {
    const k = setup();
    k.keeper.start();
    expect(k.pending().map((t) => t.ms)).toEqual([MESHTASTIC_LINK_KEEPER_STARTUP_DELAY_MS]);
    await k.fire();
    expect(k.connect).toHaveBeenCalledWith(RADIO);
  });

  it('leaves the connection to a present renderer', async () => {
    const k = setup();
    k.keeper.start();
    k.keeper.setRendererPresent(true);
    expect(k.pending()).toEqual([]);
    k.wrapped.onClose(); // the renderer's runtime reconnects drops itself
    expect(k.pending()).toEqual([]);
    k.keeper.setRendererPresent(false); // last tab gone with the link down: take over
    await k.fire();
    expect(k.connect).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a saved radio, and saves what a renderer connects to', () => {
    const k = setup(null);
    k.keeper.start();
    expect(k.pending()).toEqual([]);
    const http: MeshtasticLinkTarget = { kind: 'http', host: 'meshtastic.local', tls: false };
    k.wrapped.onOpen(vi.fn(), { origin: 'renderer', target: http });
    expect(k.stored()).toEqual(http);
    expect(k.tap.onOpen).toHaveBeenCalled();
    // Links the keeper opened itself never overwrite the renderer's choice.
    k.wrapped.onOpen(vi.fn(), { origin: 'backend', target: RADIO });
    expect(k.stored()).toEqual(http);
  });

  it('stops for good after an explicit renderer disconnect', () => {
    const k = setup();
    k.keeper.start();
    k.wrapped.onUserDisconnect?.();
    expect(k.stored()).toBeNull();
    expect(k.pending()).toEqual([]);
    k.wrapped.onClose();
    expect(k.pending()).toEqual([]);
    expect(k.tap.onUserDisconnect).toHaveBeenCalled();
  });

  it('backs off on failures up to the cap and resets once the link opens', async () => {
    const k = setup();
    k.connect.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    k.keeper.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await k.fire();
      delays.push(k.pending().at(-1)?.ms ?? -1);
    }
    expect(delays).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(delays.at(-1)).toBe(MESHTASTIC_LINK_KEEPER_MAX_RETRY_MS);

    k.wrapped.onOpen(vi.fn(), { origin: 'backend', target: RADIO });
    expect(k.pending()).toEqual([]);
    k.wrapped.onClose(); // drop while detached: retry from the minimum again
    expect(k.pending().at(-1)?.ms).toBe(MESHTASTIC_LINK_KEEPER_MIN_RETRY_MS);
  });

  it('cancels its timer on dispose', () => {
    const k = setup();
    k.keeper.start();
    k.keeper.dispose();
    expect(k.pending()).toEqual([]);
  });
});

describe('parseMeshtasticLinkTarget', () => {
  it('accepts tcp and http targets and rejects malformed values', () => {
    expect(parseMeshtasticLinkTarget(RADIO)).toEqual(RADIO);
    expect(parseMeshtasticLinkTarget({ kind: 'http', host: 'radio.lan', tls: true })).toEqual({
      kind: 'http',
      host: 'radio.lan',
      tls: true,
    });
    for (const bad of [
      null,
      'tcp',
      { kind: 'tcp', host: 'x', port: 0 },
      { kind: 'tcp', host: '', port: 4403 },
      { kind: 'http', host: 'x' },
      { kind: 'ble', host: 'x' },
    ]) {
      expect(parseMeshtasticLinkTarget(bad)).toBeNull();
    }
  });
});
