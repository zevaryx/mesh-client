// @vitest-environment node
/**
 * Integration: `ipc/http-bridge.ts` on the headless `electron` shim against a fake Meshtastic
 * Wi-Fi radio (`/json/report`, `/api/v1/fromradio`, `/api/v1/toradio`), driven through the
 * registry exactly as bridge sessions drive it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { registerHttpBridgeIpcHandlers, stopHttpBridgePolling } = await import('../ipc/http-bridge');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  headlessIpcRegistry.invoke(channel, event, args);

describe('HTTP bridge on the headless shim', () => {
  let radio: http.Server;
  let radioHost = '';
  const pushes: { channel: string; args: unknown[] }[] = [];
  const writes: Buffer[] = [];
  /** Frames the fake radio hands out, one per fromradio GET, then empty bodies. */
  const pending: Buffer[] = [Buffer.from([0x0a, 0x01, 0x02])];
  /** Meshtastic background-ingest tap: sees the same polled frames as the renderer. */
  const tap = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() };

  beforeAll(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    radio = http.createServer((req, res) => {
      if (req.url === '/json/report') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url?.startsWith('/api/v1/fromradio')) {
        res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
        res.end(pending.shift() ?? Buffer.alloc(0));
        return;
      }
      if (req.url === '/api/v1/toradio' && req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          writes.push(Buffer.concat(chunks));
          res.writeHead(200);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      radio.listen(0, '127.0.0.1', resolve);
    });
    radioHost = `127.0.0.1:${(radio.address() as AddressInfo).port}`;

    const window = new BrowserWindow((channel, args) => {
      pushes.push({ channel, args });
    });
    registerHttpBridgeIpcHandlers({ getMainWindow: () => window, meshtasticTap: tap });
  });

  afterAll(async () => {
    stopHttpBridgePolling();
    await new Promise<void>((resolve) => {
      radio.close(() => {
        resolve();
      });
    });
    vi.restoreAllMocks();
  });

  it('preflights the radio and rejects bad hosts', async () => {
    await expect(invoke('http:preflight', radioHost, false)).resolves.toBeUndefined();
    await expect(invoke('http:preflight', 'bad host', false)).rejects.toThrow(
      'Invalid host format',
    );
    await expect(invoke('http:preflight', radioHost, 'no')).rejects.toThrow('Invalid tls');
  });

  it('polls fromradio into http:data pushes and PUTs toradio writes', async () => {
    await invoke('http:connect', radioHost, false);
    await vi.waitFor(
      () => {
        expect(pushes.find((p) => p.channel === 'http:data')).toBeDefined();
      },
      { timeout: 8000, interval: 100 },
    );
    const data = pushes.find((p) => p.channel === 'http:data');
    expect(Array.from(data?.args[0] as Uint8Array)).toEqual([0x0a, 0x01, 0x02]);

    expect(tap.onOpen).toHaveBeenCalledTimes(1);
    expect(tap.onData).toHaveBeenCalledWith(new Uint8Array([0x0a, 0x01, 0x02]));

    await invoke('http:write', [1, 2, 3]);
    expect(writes.map((w) => Array.from(w))).toEqual([[1, 2, 3]]);
    // The tap's writer reaches the same radio (used for background-ingest keep-alives).
    const tapWrite = tap.onOpen.mock.calls[0]?.[0] as (bytes: Uint8Array) => void;
    tapWrite(new Uint8Array([7]));
    await vi.waitFor(() => {
      expect(writes.map((w) => Array.from(w))).toEqual([[1, 2, 3], [7]]);
    });
    await expect(invoke('http:write', [256])).rejects.toThrow('byte values must be integers');

    await invoke('http:disconnect');
    expect(tap.onClose).toHaveBeenCalledTimes(1);
    await expect(invoke('http:write', [1])).rejects.toThrow('no active connection');
  }, 15_000);

  it('reports the host-link session meter and validates its protocol', async () => {
    await expect(invoke('hostLink:getSessionMeter', 'meshtastic')).resolves.toBeDefined();
    await expect(invoke('hostLink:getSessionMeter', 'reticulum')).rejects.toThrow(
      'Invalid protocol',
    );
  });

  it('refuses untrusted senders', async () => {
    await expect(
      headlessIpcRegistry.invoke(
        'http:connect',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [radioHost, false],
      ),
    ).rejects.toThrow('unauthorized sender');
  });
});
