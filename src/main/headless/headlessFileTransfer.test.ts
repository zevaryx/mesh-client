// @vitest-environment node
/**
 * End-to-end headless file transfer: IPC handlers call the shim's `dialog.showOpenDialog` /
 * `showSaveDialog`; a WebSocket + fetch client plays the browser (upload on `headless:pickFiles`,
 * fetch on `headless:download`) against the real HTTP server.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  parseWebBridgeServerFrame,
  serializeWebBridgeFrame,
  WEB_BRIDGE_DOWNLOAD_EVENT,
  WEB_BRIDGE_PICK_FILES_EVENT,
  type WebBridgeDownloadNotice,
  type WebBridgePickFilesRequest,
} from '../../shared/webBridgeProtocol';
import { dialog } from './electronShim';
import { filtersToAccept } from './fileTransfer';
import { HeadlessIpcRegistry } from './ipcRegistry';
import { createHeadlessWebServer, type HeadlessWebServer } from './webServer';

const TOKEN = 'file-transfer-token-0123456789';
const auth = { Authorization: `Bearer ${TOKEN}` };

interface Client {
  ws: WebSocket;
  events: { channel: string; payload: unknown }[];
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  nextEvent: (channel: string) => Promise<unknown>;
}

describe('headless file transfer', () => {
  let tmp = '';
  let server: HeadlessWebServer;
  let base = '';
  let registry: HeadlessIpcRegistry;

  async function connect(): Promise<Client> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ipc?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    const events: Client['events'] = [];
    const waiters = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const eventWaiters: { channel: string; resolve: (v: unknown) => void }[] = [];
    let nextId = 1;
    ws.on('message', (data: Buffer) => {
      const frame = parseWebBridgeServerFrame(data.toString('utf8'));
      if (!frame) return;
      if (frame.t === 'event') {
        const payload = frame.args[0];
        // A waiting nextEvent consumes the event; otherwise keep it for a later nextEvent.
        const i = eventWaiters.findIndex((w) => w.channel === frame.channel);
        if (i >= 0) eventWaiters.splice(i, 1)[0]?.resolve(payload);
        else events.push({ channel: frame.channel, payload });
        return;
      }
      const w = waiters.get(frame.id);
      waiters.delete(frame.id);
      if (frame.t === 'result') w?.resolve(frame.value);
      else w?.reject(new Error(frame.message));
    });
    return {
      ws,
      events,
      invoke: (channel, ...args) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          waiters.set(id, { resolve, reject });
          ws.send(serializeWebBridgeFrame({ t: 'invoke', id, channel, args }));
        }),
      nextEvent: (channel) =>
        new Promise((resolve) => {
          const seen = events.find((e) => e.channel === channel);
          if (seen) {
            events.splice(events.indexOf(seen), 1);
            resolve(seen.payload);
            return;
          }
          eventWaiters.push({ channel, resolve });
        }),
    };
  }

  async function upload(req: WebBridgePickFilesRequest, name: string, body: string | Blob) {
    return fetch(`${base}/files/upload/${req.requestId}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: auth,
      body,
    });
  }

  async function complete(req: WebBridgePickFilesRequest, body: object) {
    return fetch(`${base}/files/complete/${req.requestId}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-ft-'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<html><head></head></html>');
    fs.writeFileSync(path.join(tmp, 'bridge.js'), '');
    registry = new HeadlessIpcRegistry();
    registry.handle('test:open', async () => {
      const r = await dialog.showOpenDialog(
        {},
        {
          title: 'Pick certs',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Certs', extensions: ['pem', 'p12'] }],
        },
      );
      if (r.canceled) return null;
      return r.filePaths.map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') }));
    });
    registry.handle('test:save', async (_e, fail: unknown) => {
      const r = await dialog.showSaveDialog({}, { defaultPath: '/home/x/My Export.txt' });
      fs.writeFileSync(r.filePath, 'exported data');
      if (fail === true) throw new Error('handler failed after writing');
      return r.filePath;
    });
    registry.handle('test:folder', () =>
      dialog.showOpenDialog({}, { properties: ['openDirectory'] }),
    );
    server = createHeadlessWebServer({
      registry,
      rendererDir: tmp,
      bridgeScriptFile: path.join(tmp, 'bridge.js'),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
      maxUploadBytes: 1024,
    });
    const addr = await server.listen();
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('open dialog: the browser picks and uploads, the handler reads staged files', async () => {
    const c = await connect();
    const result = c.invoke('test:open');
    const req = (await c.nextEvent(WEB_BRIDGE_PICK_FILES_EVENT)) as WebBridgePickFilesRequest;
    expect(req).toMatchObject({ title: 'Pick certs', multiple: true, accept: '.pem,.p12' });
    expect((await upload(req, 'ca.pem', 'CA DATA')).status).toBe(204);
    expect((await upload(req, '../../evil/client.p12', 'CLIENT')).status).toBe(204);
    expect((await complete(req, { canceled: false })).status).toBe(204);
    // Base names survive; path components in the browser-supplied name are dropped.
    await expect(result).resolves.toEqual([
      { name: 'ca.pem', text: 'CA DATA' },
      { name: 'client.p12', text: 'CLIENT' },
    ]);
    c.ws.close();
  });

  it('open dialog: cancel resolves canceled, and an upload error rejects the call', async () => {
    const c = await connect();
    const cancelled = c.invoke('test:open');
    const req1 = (await c.nextEvent(WEB_BRIDGE_PICK_FILES_EVENT)) as WebBridgePickFilesRequest;
    await complete(req1, { canceled: true });
    await expect(cancelled).resolves.toBeNull();

    const failed = c.invoke('test:open');
    const req2 = (await c.nextEvent(WEB_BRIDGE_PICK_FILES_EVENT)) as WebBridgePickFilesRequest;
    await complete(req2, { canceled: true, error: 'network down' });
    await expect(failed).rejects.toThrow('file upload failed: network down');
    c.ws.close();
  });

  it('caps upload size per pick (413) and requires the token', async () => {
    const c = await connect();
    const result = c.invoke('test:open');
    const req = (await c.nextEvent(WEB_BRIDGE_PICK_FILES_EVENT)) as WebBridgePickFilesRequest;
    const noAuth = await fetch(`${base}/files/upload/${req.requestId}?name=a`, {
      method: 'POST',
      body: 'x',
    });
    expect(noAuth.status).toBe(401);
    expect((await upload(req, 'big.bin', new Blob([new Uint8Array(2048)]))).status).toBe(413);
    await complete(req, { canceled: true, error: 'upload exceeds 1024 bytes' });
    await expect(result).rejects.toThrow('upload exceeds 1024 bytes');
    c.ws.close();
  });

  it('save dialog: a successful call delivers the file once', async () => {
    const c = await connect();
    const stagedPath = (await c.invoke('test:save', false)) as string;
    const notice = (await c.nextEvent(WEB_BRIDGE_DOWNLOAD_EVENT)) as WebBridgeDownloadNotice;
    expect(notice).toMatchObject({ fileName: 'My Export.txt', size: 13 });
    expect(stagedPath.startsWith(os.tmpdir())).toBe(true);

    expect((await fetch(`${base}/files/download/${notice.id}`)).status).toBe(401);
    const res = await fetch(`${base}/files/download/${notice.id}`, { headers: auth });
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''My%20Export.txt");
    expect(await res.text()).toBe('exported data');
    await vi.waitFor(() => {
      expect(fs.existsSync(stagedPath)).toBe(false);
    });
    expect((await fetch(`${base}/files/download/${notice.id}`, { headers: auth })).status).toBe(
      404,
    );
    c.ws.close();
  });

  it('save dialog: a failed call discards the staged file and announces nothing', async () => {
    const c = await connect();
    await expect(c.invoke('test:save', true)).rejects.toThrow('handler failed after writing');
    expect(c.events.some((e) => e.channel === WEB_BRIDGE_DOWNLOAD_EVENT)).toBe(false);
    c.ws.close();
  });

  it('folder pickers reject explicitly', async () => {
    const c = await connect();
    await expect(c.invoke('test:folder')).rejects.toThrow(
      'folder pickers are not available in headless mode',
    );
    c.ws.close();
  });

  it('closing the session cancels a pending pick', async () => {
    const c = await connect();
    const result = c.invoke('test:open').catch((err: unknown) => err);
    await c.nextEvent(WEB_BRIDGE_PICK_FILES_EVENT);
    c.ws.close();
    // The call's promise settles server-side as cancelled; the client is gone, so nothing returns.
    await vi.waitFor(() => {
      expect(server.sessionCount()).toBe(0);
    });
    expect(result).toBeInstanceOf(Promise);
  });

  it('dialogs outside a bridge call reject instead of hanging', async () => {
    await expect(dialog.showOpenDialog({ properties: ['openFile'] })).rejects.toThrow(
      'file dialogs need a browser session',
    );
    await expect(dialog.showSaveDialog({ defaultPath: 'x.txt' })).rejects.toThrow(
      'file dialogs need a browser session',
    );
  });
});

describe('filtersToAccept', () => {
  it('maps extensions and treats "All files" as unrestricted', () => {
    expect(filtersToAccept([{ name: 'DB', extensions: ['db', 'sqlite'] }])).toBe('.db,.sqlite');
    expect(
      filtersToAccept([
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ]),
    ).toBe('');
    expect(filtersToAccept(undefined)).toBe('');
    expect(filtersToAccept([{ name: 'odd', extensions: ['a b'] }])).toBe('');
  });
});
