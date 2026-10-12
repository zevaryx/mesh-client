// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  parseWebBridgeServerFrame,
  serializeWebBridgeFrame,
  type WebBridgeServerFrame,
} from '../../shared/webBridgeProtocol';
import { HEADLESS_SENDER_URL, type HeadlessIpcEvent, HeadlessIpcRegistry } from './ipcRegistry';
import {
  createHeadlessWebServer,
  headlessHostAllowed,
  headlessTokenMatches,
  type HeadlessWebServer,
  injectWebBridgeScript,
  resolveStaticFile,
} from './webServer';

const TOKEN = 'test-token-0123456789';

let tmpDir: string;
let rendererDir: string;
let bridgeFile: string;
let server: HeadlessWebServer | null = null;
let registry: HeadlessIpcRegistry;

function writeFixture(rel: string, content: string): void {
  const file = path.join(rendererDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function startServer(token: string | null = TOKEN, maxSessions?: number): Promise<number> {
  server = createHeadlessWebServer({
    registry,
    rendererDir,
    bridgeScriptFile: bridgeFile,
    token,
    host: '127.0.0.1',
    port: 0,
    platform: 'win32',
    ...(maxSessions != null ? { maxSessions } : {}),
  });
  return (await server.listen()).port;
}

function openClient(
  port: number,
  query = `?token=${TOKEN}`,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ipc${query}`, { headers });
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

/** GET with an explicit Host header (`fetch` does not let tests set one). */
function getWithHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on('error', reject);
  });
}

function nextFrame(ws: WebSocket): Promise<WebBridgeServerFrame | null> {
  return new Promise((resolve) => {
    ws.once('message', (data: Buffer) => {
      resolve(parseWebBridgeServerFrame(data.toString('utf8')));
    });
  });
}

describe('headless web server', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-web-'));
    rendererDir = path.join(tmpDir, 'renderer');
    bridgeFile = path.join(tmpDir, 'web-bridge.js');
    writeFixture(
      'index.html',
      '<html><head><title>x</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
    );
    writeFixture('assets/app.js', 'console.debug("app")');
    fs.writeFileSync(bridgeFile, 'window.bridge = 1;');
    fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'outside root');
    registry = new HeadlessIpcRegistry();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('serves index.html with the bridge script injected before the app module', async () => {
    const port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html.indexOf('<script src="/web-bridge.js"></script>')).toBeLessThan(
      html.indexOf('type="module"'),
    );
    expect(html).toContain('content="win32"');
  });

  it('serves the bridge script, assets, SPA fallback and health check', async () => {
    const port = await startServer();
    const bridge = await fetch(`http://127.0.0.1:${port}/web-bridge.js`);
    expect(bridge.headers.get('content-type')).toContain('text/javascript');
    expect(await bridge.text()).toBe('window.bridge = 1;');

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const route = await fetch(`http://127.0.0.1:${port}/some/client/route`);
    expect(await route.text()).toContain('web-bridge.js');

    expect((await fetch(`http://127.0.0.1:${port}/missing.png`)).status).toBe(404);
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok');
    expect((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status).toBe(405);
  });

  it('rejects bridge upgrades with a missing or wrong token', async () => {
    const port = await startServer();
    await expect(openClient(port, '')).rejects.toThrow('401');
    await expect(openClient(port, '?token=wrong-token-0123456789')).rejects.toThrow('401');
  });

  it('with auth off, serves IP / localhost hosts only (rebinding guard)', async () => {
    const port = await startServer(null);
    const rebind = await getWithHost(port, `evil.example:${port}`);
    expect(rebind.status).toBe(421);
    expect(rebind.body).toContain('MESH_CLIENT_WEB_ALLOWED_HOSTS');
    await expect(
      openClient(port, '', { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` }),
    ).rejects.toThrow('421');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    (await openClient(port, '')).close();
  });

  it('serves any host name when a token is required', async () => {
    const port = await startServer();
    expect((await getWithHost(port, `station.example:${port}`)).status).toBe(200);
  });

  it('locks out a client after repeated bad tokens, even for the right token', async () => {
    const port = await startServer();
    for (let i = 0; i < 20; i++) {
      await expect(openClient(port, '?token=wrong-token-0123456789')).rejects.toThrow('401');
    }
    await expect(openClient(port, `?token=${TOKEN}`)).rejects.toThrow('429');
    const files = await fetch(`http://127.0.0.1:${port}/files/download/x`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(files.status).toBe(429);
  });

  it('refuses bridge sessions beyond the cap and frames from other sites', async () => {
    const port = await startServer(TOKEN, 1);
    const first = await openClient(port);
    await expect(openClient(port)).rejects.toThrow('503');
    first.close();
    await vi.waitFor(() => {
      expect(server?.sessionCount()).toBe(0);
    });
    (await openClient(port)).close();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('rejects cross-origin bridge upgrades even with a valid token', async () => {
    const port = await startServer();
    await expect(
      openClient(port, `?token=${TOKEN}`, { Origin: 'https://evil.example' }),
    ).rejects.toThrow('403');
    const ws = await openClient(port, `?token=${TOKEN}`, { Origin: `http://127.0.0.1:${port}` });
    ws.close();
  });

  it('accepts any client when auth is disabled', async () => {
    const port = await startServer(null);
    const ws = await openClient(port, '');
    ws.close();
  });

  it('dispatches invokes with an authenticated sender event and returns results', async () => {
    let seen: HeadlessIpcEvent | null = null;
    registry.handle('echo', (event, value) => {
      seen = event;
      return { got: value };
    });
    const port = await startServer();
    const ws = await openClient(port);
    const reply = nextFrame(ws);
    ws.send(
      serializeWebBridgeFrame({ t: 'invoke', id: 5, channel: 'echo', args: [new Uint8Array([7])] }),
    );
    const frame = await reply;
    expect(frame?.t).toBe('result');
    expect(frame?.t === 'result' ? frame.value : null).toEqual({ got: new Uint8Array([7]) });
    expect(seen).toMatchObject({ senderFrame: { url: HEADLESS_SENDER_URL } });
    ws.close();
  });

  it('returns error frames for failing and unported channels', async () => {
    registry.handle('fail', () => {
      throw new Error('handler failed');
    });
    const port = await startServer();
    const ws = await openClient(port);
    let reply = nextFrame(ws);
    ws.send(serializeWebBridgeFrame({ t: 'invoke', id: 1, channel: 'fail', args: [] }));
    expect(await reply).toEqual({ t: 'error', id: 1, message: 'handler failed' });

    reply = nextFrame(ws);
    ws.send(serializeWebBridgeFrame({ t: 'invoke', id: 2, channel: 'db:getNodes', args: [] }));
    expect(await reply).toMatchObject({ t: 'error', id: 2 });
    ws.close();
  });

  it('settles an invoke whose result cannot be encoded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registry.handle('fn', () => () => 1);
    const port = await startServer();
    const ws = await openClient(port);
    const reply = nextFrame(ws);
    ws.send(serializeWebBridgeFrame({ t: 'invoke', id: 3, channel: 'fn', args: [] }));
    expect(await reply).toMatchObject({ t: 'error', id: 3 });
    ws.close();
  });

  it('delivers sends to listeners, replies to the sender, and survives malformed frames', async () => {
    registry.on('hello', (event, name) => {
      event.reply('hello:reply', `hi ${String(name)}`);
    });
    const port = await startServer();
    const ws = await openClient(port);
    ws.send('garbage');
    const reply = nextFrame(ws);
    ws.send(serializeWebBridgeFrame({ t: 'send', channel: 'hello', args: ['bob'] }));
    expect(await reply).toEqual({ t: 'event', channel: 'hello:reply', args: ['hi bob'] });
    ws.close();
  });

  it('gives each session a sender that pushes to that tab only and reports its close', async () => {
    let destroyed = 0;
    registry.handle('subscribe', (event) => {
      const sender = event.sender as unknown as {
        send: (channel: string, ...args: unknown[]) => void;
        once: (name: string, fn: () => void) => void;
      };
      sender.once('destroyed', () => {
        destroyed += 1;
      });
      sender.send('feed:update', 'only for you');
      return 'ok';
    });
    const port = await startServer();
    const caller = await openClient(port);
    const other = await openClient(port);
    const otherFrames: unknown[] = [];
    other.on('message', (d: Buffer) => otherFrames.push(d.toString('utf8')));
    const pushed = nextFrame(caller);
    caller.send(serializeWebBridgeFrame({ t: 'invoke', id: 1, channel: 'subscribe', args: [] }));
    expect(await pushed).toEqual({ t: 'event', channel: 'feed:update', args: ['only for you'] });
    caller.close();
    await vi.waitFor(() => {
      expect(destroyed).toBe(1);
    });
    expect(otherFrames).toEqual([]);
    other.close();
  });

  it('broadcasts push events to every open session', async () => {
    const port = await startServer();
    const a = await openClient(port);
    const b = await openClient(port);
    await vi.waitFor(() => {
      expect(server?.sessionCount()).toBe(2);
    });
    const frames = Promise.all([nextFrame(a), nextFrame(b)]);
    server?.broadcast('mqtt:status', ['connected']);
    expect(await frames).toEqual([
      { t: 'event', channel: 'mqtt:status', args: ['connected'] },
      { t: 'event', channel: 'mqtt:status', args: ['connected'] },
    ]);
    a.close();
    b.close();
  });
});

describe('resolveStaticFile', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-static-'));
    rendererDir = path.join(tmpDir, 'renderer');
    writeFixture('index.html', 'index');
    writeFixture('assets/a.js', 'a');
    fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'outside root');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('never resolves outside the root', () => {
    expect(resolveStaticFile(rendererDir, '/../secret.txt')).toBeNull();
    expect(resolveStaticFile(rendererDir, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveStaticFile(rendererDir, '/assets/%2e%2e/%2e%2e/secret.txt')).toBeNull();
    expect(resolveStaticFile(rendererDir, '/a%00.js')).toBeNull();
    expect(resolveStaticFile(rendererDir, '/%E0%A4%A')).toBeNull();
  });

  it('resolves files, directories and extension-less SPA routes', () => {
    expect(resolveStaticFile(rendererDir, '/assets/a.js')).toBe(
      path.join(rendererDir, 'assets', 'a.js'),
    );
    expect(resolveStaticFile(rendererDir, '/')).toBe(path.join(rendererDir, 'index.html'));
    expect(resolveStaticFile(rendererDir, '/chat/room')).toBe(path.join(rendererDir, 'index.html'));
    expect(resolveStaticFile(rendererDir, '/missing.css')).toBeNull();
  });
});

describe('headlessHostAllowed (DNS-rebinding guard with auth off)', () => {
  it('accepts IP literals and localhost with or without a port', () => {
    for (const host of ['127.0.0.1:8080', '192.168.1.20', '[::1]:8080', 'localhost:8080']) {
      expect(headlessHostAllowed(host, [])).toBe(true);
    }
  });

  it('refuses other names unless listed, and missing or junk Host headers', () => {
    expect(headlessHostAllowed('evil.example:8080', [])).toBe(false);
    expect(headlessHostAllowed('Station.Local:8080', ['station.local'])).toBe(true);
    expect(headlessHostAllowed(undefined, [])).toBe(false);
    expect(headlessHostAllowed('bad host', [])).toBe(false);
  });
});

describe('helpers', () => {
  it('compares tokens exactly', () => {
    expect(headlessTokenMatches('abc', 'abc')).toBe(true);
    expect(headlessTokenMatches('abc', 'abd')).toBe(false);
    expect(headlessTokenMatches('abc', 'abcd')).toBe(false);
    expect(headlessTokenMatches('abc', null)).toBe(false);
  });

  it('injects the bridge into head when the page has no script', () => {
    expect(injectWebBridgeScript('<html><head></head></html>', 'linux')).toContain(
      '<script src="/web-bridge.js"></script>\n  </head>',
    );
  });

  it.each(['linux', 'darwin', 'win32'])('reports the %s server platform in a meta tag', (os) => {
    const html = injectWebBridgeScript('<head></head><script type="module"></script>', os);
    expect(html).toContain(`<meta name="mesh-client-host-platform" content="${os}" />`);
    expect(html.indexOf('mesh-client-host-platform')).toBeLessThan(html.indexOf('<script src='));
  });

  it('reports other Unix-likes as linux', () => {
    expect(injectWebBridgeScript('<head></head>', 'freebsd')).toContain('content="linux"');
  });
});
