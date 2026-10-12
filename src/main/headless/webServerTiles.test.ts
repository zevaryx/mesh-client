// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meshTilesUrlToWebPath, webTilesPathToMeshTilesUrl } from '../../shared/webBridgeProtocol';
import { HeadlessIpcRegistry } from './ipcRegistry';
import {
  createHeadlessWebServer,
  headlessTilesCookieValue,
  type HeadlessWebServer,
} from './webServer';

const TOKEN = 'tiles-token-0123456789';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let tmpDir: string;
let server: HeadlessWebServer | null = null;
let tileHandler: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;

async function startServer(token: string | null = TOKEN, withTiles = true): Promise<string> {
  const rendererDir = path.join(tmpDir, 'renderer');
  fs.mkdirSync(rendererDir, { recursive: true });
  fs.writeFileSync(path.join(rendererDir, 'index.html'), '<html><head></head></html>');
  const bridgeFile = path.join(tmpDir, 'web-bridge.js');
  fs.writeFileSync(bridgeFile, '');
  server = createHeadlessWebServer({
    registry: new HeadlessIpcRegistry(),
    rendererDir,
    bridgeScriptFile: bridgeFile,
    token,
    host: '127.0.0.1',
    port: 0,
    ...(withTiles ? { tileHandler } : {}),
  });
  return `http://127.0.0.1:${(await server.listen()).port}`;
}

async function tilesCookie(base: string): Promise<string> {
  const res = await fetch(`${base}/session/tiles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(204);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

describe('headless map tiles', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-tiles-'));
    tileHandler = vi.fn(() =>
      Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/png' } })),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('issues an HttpOnly cookie scoped to /tiles that is not the token', async () => {
    const base = await startServer();
    const res = await fetch(`${base}/session/tiles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`mesh_client_tiles=${headlessTilesCookieValue(TOKEN)}`);
    expect(setCookie).toContain('Path=/tiles');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain(TOKEN);
  });

  it('marks the cookie Secure behind a TLS proxy', async () => {
    const base = await startServer();
    const res = await fetch(`${base}/session/tiles`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-Proto': 'https' },
    });
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('refuses the cookie without the token or with the wrong method', async () => {
    const base = await startServer();
    const wrong = await fetch(`${base}/session/tiles`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${base}/session/tiles`)).status).toBe(405);
  });

  it('serves tiles through the mesh-tiles handler to cookie holders', async () => {
    const base = await startServer();
    const cookie = await tilesCookie(base);
    const res = await fetch(`${base}/tiles/dark/3/4/5.png?source=r2`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(tileHandler).toHaveBeenCalledTimes(1);
    expect(tileHandler.mock.calls[0]?.[0].url).toBe('mesh-tiles://dark/3/4/5.png?source=r2');
  });

  it('refuses tiles without a valid cookie and never asks the handler', async () => {
    const base = await startServer();
    expect((await fetch(`${base}/tiles/osm/1/1/1.png`)).status).toBe(401);
    const forged = await fetch(`${base}/tiles/osm/1/1/1.png`, {
      headers: { cookie: `mesh_client_tiles=${TOKEN}` },
    });
    expect(forged.status).toBe(401);
    expect(tileHandler).not.toHaveBeenCalled();
  });

  it('passes the handler status through (miss while offline → 404)', async () => {
    tileHandler.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const base = await startServer();
    const cookie = await tilesCookie(base);
    const res = await fetch(`${base}/tiles/osm/1/1/1.png`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 500 when the handler throws', async () => {
    tileHandler.mockRejectedValueOnce(new Error('disk gone'));
    const base = await startServer();
    const cookie = await tilesCookie(base);
    expect((await fetch(`${base}/tiles/osm/1/1/1.png`, { headers: { cookie } })).status).toBe(500);
  });

  it('serves tiles without a cookie when auth is off', async () => {
    const base = await startServer(null);
    expect((await fetch(`${base}/tiles/osm/1/1/1.png`)).status).toBe(200);
    const res = await fetch(`${base}/session/tiles`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('is 404 when no tile handler is configured', async () => {
    const base = await startServer(TOKEN, false);
    const cookie = await tilesCookie(base);
    expect((await fetch(`${base}/tiles/osm/1/1/1.png`, { headers: { cookie } })).status).toBe(404);
  });
});

describe('tile URL mapping', () => {
  it('maps mesh-tiles URLs to the web tile path and back', () => {
    const template = 'mesh-tiles://dark/{z}/{x}/{y}.png?source=r2';
    expect(meshTilesUrlToWebPath(template)).toBe('/tiles/dark/{z}/{x}/{y}.png?source=r2');
    expect(webTilesPathToMeshTilesUrl('/tiles/osm/1/2/3.png', '?a=1')).toBe(
      'mesh-tiles://osm/1/2/3.png?a=1',
    );
  });

  it('leaves other URLs alone', () => {
    expect(meshTilesUrlToWebPath('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(webTilesPathToMeshTilesUrl('/ipc', '')).toBeNull();
  });
});
