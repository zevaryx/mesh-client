// @vitest-environment node
/**
 * End-to-end: Meshtastic background ingest on the headless server. A fake radio speaks the TCP
 * stream protocol; a WebSocket client plays the browser tab (connects the radio, leaves, comes
 * back). Messages that arrive with no tab owning the link must land in SQLite, and the tab that
 * takes the link back must be told to reload.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow, configureHeadlessApp } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { createHeadlessWebServer } = await import('./webServer');
const { closeDatabase, getDatabase, initDatabase } = await import('../database');
const { registerMeshtasticDbIpcHandlers } = await import('../ipc/db-meshtastic-handlers');
const { destroyRegisteredTcpBridgeSockets, registerTcpBridgeIpcHandlers } =
  await import('../ipc/tcp-bridge');
const { sendMeshtasticBackendCaughtUp } = await import('../ipc/meshtastic-backend-push');
const { validateHttpHost } = await import('../httpHostValidation');
const { startInProcessMeshtasticBackend } = await import('../meshtastic-backend/inProcessHost');
const { persistMeshtasticBackendRow } = await import('../meshtastic-backend/persist');
const { parseWebBridgeServerFrame, serializeWebBridgeFrame } =
  await import('../../shared/webBridgeProtocol');
const { computeChannelIdentityKey } = await import('../../shared/channelIdentityKey');
const { ALICE, BROADCAST, configDump, ME, PSK, textPacket } =
  await import('../meshtastic-backend/meshtasticFrames.testUtil');

const TOKEN = 'meshtastic-backend-token-0123';

interface Tab {
  ws: WebSocket;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  events: { channel: string; args: unknown[] }[];
  close: () => Promise<void>;
}

interface StoredRow {
  sender_id: number;
  sender_name: string;
  payload: string;
  packetId: number;
  received_via?: string;
  receivedVia?: string;
  channel_key?: string;
  channelKey?: string;
}

describe('headless Meshtastic background ingest', () => {
  let dataDir = '';
  let base = '';
  let radio: net.Server;
  let radioPort = 0;
  const radioSockets: net.Socket[] = [];
  let server: ReturnType<typeof createHeadlessWebServer>;
  let backend: ReturnType<typeof startInProcessMeshtasticBackend>;

  /** Send to the radio's newest client (the socket the bridge currently holds). */
  const radioSend = (...frames: Uint8Array[]): void => {
    const sock = radioSockets.at(-1);
    if (!sock) throw new Error('radio has no client');
    for (const f of frames) sock.write(f);
  };

  const storedMessages = async (): Promise<StoredRow[]> =>
    (await headlessIpcRegistry.invoke(
      'db:getMessages',
      { senderFrame: { url: HEADLESS_SENDER_URL }, sender: { id: 99 }, reply: () => {} },
      [0],
    )) as StoredRow[];

  /** Total radio bytes a tab received as `meshtastic:tcp-data` pushes. */
  const bytesSeen = (tab: Tab): number =>
    tab.events
      .filter((e) => e.channel === 'meshtastic:tcp-data')
      .reduce((n, e) => n + ((e.args[0] as Uint8Array | undefined)?.length ?? 0), 0);
  const totalLength = (frames: Uint8Array[]): number => frames.reduce((n, f) => n + f.length, 0);

  async function openTab(): Promise<Tab> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ipc?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    const events: Tab['events'] = [];
    const waiters = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let nextId = 1;
    ws.on('message', (data: Buffer) => {
      const frame = parseWebBridgeServerFrame(data.toString('utf8'));
      if (!frame) return;
      if (frame.t === 'event') {
        events.push({ channel: frame.channel, args: frame.args });
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
      close: async () => {
        ws.close();
        await vi.waitFor(() => {
          expect(server.sessionCount()).toBe(0);
        });
      },
    };
  }

  beforeAll(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-mt-backend-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    initDatabase();
    registerMeshtasticDbIpcHandlers();
    fs.writeFileSync(path.join(dataDir, 'index.html'), '<html><head></head></html>');
    fs.writeFileSync(path.join(dataDir, 'bridge.js'), '');

    radio = net.createServer((socket) => {
      radioSockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      radio.listen(0, '127.0.0.1', resolve);
    });
    radioPort = (radio.address() as net.AddressInfo).port;

    let window: InstanceType<typeof BrowserWindow> | null = null;
    backend = startInProcessMeshtasticBackend({
      persistMessage: (row) => {
        persistMeshtasticBackendRow(row);
      },
      onCaughtUp: (count) => {
        sendMeshtasticBackendCaughtUp(window, { count });
      },
    });
    server = createHeadlessWebServer({
      registry: headlessIpcRegistry,
      rendererDir: dataDir,
      bridgeScriptFile: path.join(dataDir, 'bridge.js'),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
      onSessionCountChange: (count) => {
        backend.setRendererPresent(count > 0);
      },
    });
    window = new BrowserWindow(server.broadcast);
    const pushWindow = window;
    registerTcpBridgeIpcHandlers({
      getMainWindow: () => pushWindow,
      validateHost: validateHttpHost,
      meshtasticTap: backend.tap,
    });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
  });

  afterAll(async () => {
    destroyRegisteredTcpBridgeSockets('test');
    backend.dispose();
    await server.close();
    for (const s of radioSockets) s.destroy();
    await new Promise<void>((resolve) => {
      radio.close(() => {
        resolve();
      });
    });
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('stores chat while no tab owns the link and tells the returning tab to reload', async () => {
    // A tab connects the radio: it owns the link, so the backend stores nothing.
    const first = await openTab();
    await first.invoke('meshtastic:tcp-connect', '127.0.0.1', radioPort);
    const firstFrames = [
      ...configDump(),
      textPacket({ from: ALICE, to: BROADCAST, id: 300, text: 'seen' }),
    ];
    radioSend(...firstFrames);
    await vi.waitFor(() => {
      expect(bytesSeen(first)).toBe(totalLength(firstFrames));
    });
    expect(await storedMessages()).toEqual([]);

    // Every tab closes; the radio socket stays up on the server.
    await first.close();
    radioSend(textPacket({ from: ALICE, to: BROADCAST, id: 301, text: 'while away' }));
    await vi.waitFor(async () => {
      expect((await storedMessages()).map((m) => m.payload)).toEqual(['while away']);
    });

    // A tab is back but has not reconnected the radio yet: still the backend's job.
    const second = await openTab();
    radioSend(textPacket({ from: ALICE, to: ME, id: 302, text: 'during page load' }));
    await vi.waitFor(async () => {
      expect(await storedMessages()).toHaveLength(2);
    });
    const [row] = await storedMessages();
    expect(row).toMatchObject({ sender_id: ALICE, sender_name: 'ALI', packetId: 301 });
    expect(row?.channel_key ?? row?.channelKey).toBe(
      computeChannelIdentityKey('meshtastic', 'Ops', PSK),
    );

    // Its runtime reconnects: ownership moves back and it is told to reload.
    await second.invoke('meshtastic:tcp-connect', '127.0.0.1', radioPort);
    await vi.waitFor(() => {
      expect(second.events).toContainEqual({
        channel: 'meshtastic:backend-caught-up',
        args: [{ count: 2 }],
      });
    });
    const liveFrames = [
      ...configDump(),
      textPacket({ from: ALICE, to: BROADCAST, id: 303, text: 'live' }),
    ];
    const before = bytesSeen(second);
    radioSend(...liveFrames);
    await vi.waitFor(() => {
      expect(bytesSeen(second) - before).toBe(totalLength(liveFrames));
    });
    expect(await storedMessages()).toHaveLength(2);
    await second.close();
  });

  it('drops rows from blocked senders, like PacketRouter', async () => {
    const blocked = 0x0badbeef;
    getDatabase()
      .prepareOnce(
        'INSERT INTO blocked_contacts (protocol, identity_id, blocked_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('meshtastic', 'lora-blocklist', String(blocked), Date.now());
    const row = (from: number, packetId: number) => ({
      sender_id: from,
      sender_name: 'x',
      payload: 'hello',
      channel: 0,
      timestamp: 1_700_000_100_000,
      packetId,
      receivedVia: 'rf',
    });
    expect(persistMeshtasticBackendRow(row(blocked, 900))).toBe(false);
    expect(persistMeshtasticBackendRow(row(ALICE, 901))).toBe(true);
    const senders = (await storedMessages()).map((m) => m.sender_id);
    expect(senders).not.toContain(blocked);
    expect(senders).toContain(ALICE);
  });
});
