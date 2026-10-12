// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseWebBridgeClientFrame,
  serializeWebBridgeFrame,
  type WebBridgeClientFrame,
  type WebBridgeServerFrame,
} from '../../shared/webBridgeProtocol';
import {
  type BridgeSocket,
  buildBridgeSocketUrl,
  readHeadlessHostPlatform,
  takeHeadlessToken,
  WebIpcRenderer,
} from './electronRendererShim';

class FakeSocket implements BridgeSocket {
  readyState = 0;
  sent: WebBridgeClientFrame[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    const frame = parseWebBridgeClientFrame(data);
    if (frame) this.sent.push(frame);
  }

  close(): void {
    this.drop();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  receive(frame: WebBridgeServerFrame): void {
    this.onmessage?.({ data: serializeWebBridgeFrame(frame) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const renderer = new WebIpcRenderer({
    url: 'ws://host/ipc?token=t',
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
    },
  });
  const current = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  return { renderer, sockets, scheduled, current };
}

describe('WebIpcRenderer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues invokes until the socket opens, then resolves from result frames', async () => {
    const { renderer, current } = setup();
    const p = renderer.invoke('meshtastic:tcp-connect', '10.0.0.2', 4403);
    expect(current().sent).toEqual([]);
    current().open();
    expect(current().sent).toEqual([
      { t: 'invoke', id: 1, channel: 'meshtastic:tcp-connect', args: ['10.0.0.2', 4403] },
    ]);
    current().receive({ t: 'result', id: 1, value: new Uint8Array([4]) });
    expect(await p).toEqual(new Uint8Array([4]));
  });

  it('rejects with an Electron-shaped message on error frames', async () => {
    const { renderer, current } = setup();
    current().open();
    const p = renderer.invoke('db:getNodes');
    current().receive({ t: 'error', id: 1, message: 'nope' });
    await expect(p).rejects.toThrow("Error invoking remote method 'db:getNodes': Error: nope");
  });

  it('rejects in-flight invokes on disconnect, keeps unsent ones, and reconnects with backoff', async () => {
    const { renderer, sockets, scheduled, current } = setup();
    current().open();
    const inFlight = renderer.invoke('a');
    current().drop();
    await expect(inFlight).rejects.toThrow('headless server connection lost');
    expect(scheduled.map((s) => s.ms)).toEqual([500]);

    const queued = renderer.invoke('b');
    scheduled[0]?.fn();
    expect(sockets).toHaveLength(2);
    current().drop(); // fails before opening: backoff doubles, queued invoke survives
    expect(scheduled.map((s) => s.ms)).toEqual([500, 1000]);
    scheduled[1]?.fn();
    current().open();
    expect(current().sent).toEqual([{ t: 'invoke', id: 2, channel: 'b', args: [] }]);
    current().receive({ t: 'result', id: 2, value: 'ok' });
    await expect(queued).resolves.toBe('ok');
  });

  it('raises power:suspend when a live connection drops and power:resume after the reconnect flush', () => {
    const { renderer, scheduled, current } = setup();
    const log: string[] = [];
    renderer.on('power:suspend', () => {
      log.push('suspend');
      // Recovery code calls into main while disconnected; the call must ride the reconnect.
      void renderer.invoke('mqtt:powerSuspend').catch(() => undefined);
    });
    renderer.on('power:resume', () => {
      log.push(
        `resume after ${current()
          .sent.map((f) => f.channel)
          .join(',')}`,
      );
    });

    current().drop(); // initial connect fails: no outage yet
    scheduled[0]?.fn();
    current().open(); // first successful open: nothing to resync
    expect(log).toEqual([]);

    current().drop();
    expect(log).toEqual(['suspend']);
    scheduled[1]?.fn();
    current().drop(); // failed retries stay within the same outage
    scheduled[2]?.fn();
    expect(log).toEqual(['suspend']);
    current().open();
    expect(log).toEqual(['suspend', 'resume after mqtt:powerSuspend']);

    current().drop();
    scheduled[3]?.fn();
    current().open();
    expect(log).toEqual([
      'suspend',
      'resume after mqtt:powerSuspend',
      'suspend',
      'resume after mqtt:powerSuspend',
    ]);
  });

  it('answers browser-local channels in the page without touching the socket', async () => {
    const sockets: FakeSocket[] = [];
    const clip = vi.fn(() => Promise.resolve());
    const renderer = new WebIpcRenderer({
      url: 'ws://host/ipc?token=t',
      createSocket: (url) => {
        const sock = new FakeSocket(url);
        sockets.push(sock);
        return sock;
      },
      schedule: () => {},
      localInvokes: {
        'clipboard:writeText': clip,
        'app:focusWindow': () => Promise.reject(new Error('blocked')),
      },
    });
    sockets[0]?.open();
    await renderer.invoke('clipboard:writeText', 'hi');
    expect(clip).toHaveBeenCalledWith('hi');
    await expect(renderer.invoke('app:focusWindow')).rejects.toThrow(
      "Error invoking remote method 'app:focusWindow': Error: blocked",
    );
    expect(sockets[0]?.sent).toEqual([]);
  });

  it('delivers events to on/once listeners and stops after off', () => {
    const { renderer, current } = setup();
    current().open();
    const on = vi.fn();
    const once = vi.fn();
    renderer.on('mqtt:status', on);
    renderer.once('mqtt:status', once);
    current().receive({ t: 'event', channel: 'mqtt:status', args: ['connected'] });
    current().receive({ t: 'event', channel: 'mqtt:status', args: ['disconnected'] });
    expect(on).toHaveBeenCalledTimes(2);
    expect(on).toHaveBeenLastCalledWith(
      expect.objectContaining({ sender: renderer }),
      'disconnected',
    );
    expect(once).toHaveBeenCalledTimes(1);
    renderer.off('mqtt:status', on);
    expect(renderer.listenerCount('mqtt:status')).toBe(0);
  });

  it('isolates a throwing listener', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { renderer, current } = setup();
    current().open();
    const after = vi.fn();
    renderer.on('x', () => {
      throw new Error('boom');
    });
    renderer.on('x', after);
    current().receive({ t: 'event', channel: 'x', args: [] });
    expect(after).toHaveBeenCalled();
  });

  it('sends fire-and-forget frames and rejects unencodable invoke args', async () => {
    const { renderer, current } = setup();
    current().open();
    renderer.send('set-tray-unread', 3);
    expect(current().sent).toEqual([{ t: 'send', channel: 'set-tray-unread', args: [3] }]);
    await expect(renderer.invoke('x', () => 1)).rejects.toThrow(TypeError);
  });
});

describe('token + URL helpers', () => {
  function fakeWindow(href: string, stored: string | null = null) {
    const storage = new Map<string, string>(stored ? [['mesh-client.headless.token', stored]] : []);
    const replaced: string[] = [];
    const win = {
      location: { href },
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
      },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
      },
    } as unknown as Window;
    return { win, storage, replaced };
  }

  it('takes the token from the URL, stores it and strips it from the address bar', () => {
    const { win, storage, replaced } = fakeWindow('http://h:8080/?token=abc&x=1#frag');
    expect(takeHeadlessToken(win)).toBe('abc');
    expect(storage.get('mesh-client.headless.token')).toBe('abc');
    expect(replaced).toEqual(['http://h:8080/?x=1#frag']);
  });

  it('falls back to the stored token', () => {
    const { win, replaced } = fakeWindow('http://h:8080/', 'stored');
    expect(takeHeadlessToken(win)).toBe('stored');
    expect(replaced).toEqual([]);
  });

  it('builds ws/wss URLs on the page origin', () => {
    expect(buildBridgeSocketUrl({ protocol: 'http:', host: 'h:8080' } as Location, 'a b')).toBe(
      'ws://h:8080/ipc?token=a+b',
    );
    expect(
      buildBridgeSocketUrl({ protocol: 'https:', host: 'mesh.example' } as Location, null),
    ).toBe('wss://mesh.example/ipc');
  });
});

describe('readHeadlessHostPlatform', () => {
  function docWith(content: string | null): Pick<Document, 'querySelector'> {
    return {
      querySelector: (selector: string) =>
        content !== null && selector === 'meta[name="mesh-client-host-platform"]'
          ? ({ getAttribute: () => content } as unknown as Element)
          : null,
    };
  }

  it.each(['linux', 'darwin', 'win32'])('reads %s from the server meta tag', (os) => {
    expect(readHeadlessHostPlatform(docWith(os))).toBe(os);
  });

  it('falls back to linux when the meta is missing or unexpected', () => {
    expect(readHeadlessHostPlatform(docWith(null))).toBe('linux');
    expect(readHeadlessHostPlatform(docWith('aix'))).toBe('linux');
  });
});
