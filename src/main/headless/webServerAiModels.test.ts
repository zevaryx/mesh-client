// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meshAiUrlToWebPath, webAiModelsPathToMeshAiUrl } from '../../shared/webBridgeProtocol';
import { headlessProtocolHandler, protocol } from './electronShim';
import { HeadlessIpcRegistry } from './ipcRegistry';
import { createHeadlessWebServer, type HeadlessWebServer } from './webServer';

const TOKEN = 'ai-models-token-0123456789';
const MODEL_BYTES = new Uint8Array(256 * 1024).map((_, i) => i % 251);

let tmpDir: string;
let server: HeadlessWebServer | null = null;
let aiModelHandler: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;

async function startServer(token: string | null = TOKEN, withModels = true): Promise<string> {
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
    ...(withModels ? { aiModelHandler } : {}),
  });
  return `http://127.0.0.1:${(await server.listen()).port}`;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('headless offline AI models', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-ai-'));
    aiModelHandler = vi.fn((request: Request) =>
      Promise.resolve(
        new URL(request.url).hostname === 'tiny'
          ? new Response(MODEL_BYTES, {
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(MODEL_BYTES.length),
              },
            })
          : new Response(null, { status: 404 }),
      ),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('maps mesh-ai: URLs to the server route and back', () => {
    expect(meshAiUrlToWebPath('mesh-ai://tiny/model.gguf')).toBe('/ai-models/tiny/model.gguf');
    expect(meshAiUrlToWebPath('https://example.com/model.gguf')).toBeNull();
    expect(webAiModelsPathToMeshAiUrl('/ai-models/tiny/model.gguf')).toBe(
      'mesh-ai://tiny/model.gguf',
    );
    expect(webAiModelsPathToMeshAiUrl('/ai-models/')).toBeNull();
    expect(webAiModelsPathToMeshAiUrl('/tiles/osm/1/2/3.png')).toBeNull();
  });

  it('streams a model file to token holders through the mesh-ai: handler', async () => {
    const base = await startServer();
    const res = await fetch(`${base}/ai-models/tiny/model.gguf`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MODEL_BYTES);
    expect(aiModelHandler).toHaveBeenCalledTimes(1);
    expect(aiModelHandler.mock.calls[0]?.[0].url).toBe('mesh-ai://tiny/model.gguf');
  });

  it('refuses requests without the token and never asks the handler', async () => {
    const base = await startServer();
    expect((await fetch(`${base}/ai-models/tiny/model.gguf`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/ai-models/tiny/model.gguf`, {
          headers: { Authorization: 'Bearer wrong-token-0123456789' },
        })
      ).status,
    ).toBe(401);
    expect(aiModelHandler).not.toHaveBeenCalled();
  });

  it('passes the handler status through, answers HEAD without a body, 404s when off', async () => {
    const base = await startServer();
    expect((await fetch(`${base}/ai-models/missing/model.gguf`, { headers: auth })).status).toBe(
      404,
    );
    const head = await fetch(`${base}/ai-models/tiny/model.gguf`, {
      method: 'HEAD',
      headers: auth,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(MODEL_BYTES.length));
    await server?.close();
    const off = await startServer(TOKEN, false);
    expect((await fetch(`${off}/ai-models/tiny/model.gguf`, { headers: auth })).status).toBe(404);
  });

  it('keeps the handler a module registers with protocol.handle for the web server', async () => {
    expect(headlessProtocolHandler('mesh-ai-test')).toBeNull();
    protocol.handle('mesh-ai-test', (request) => new Response(new URL(request.url).hostname));
    try {
      expect(protocol.isProtocolHandled('mesh-ai-test')).toBe(true);
      const handler = headlessProtocolHandler('mesh-ai-test');
      expect(await (await handler?.(new Request('mesh-ai-test://tiny/x')))?.text()).toBe('tiny');
    } finally {
      protocol.unhandle('mesh-ai-test');
    }
    expect(headlessProtocolHandler('mesh-ai-test')).toBeNull();
  });
});
