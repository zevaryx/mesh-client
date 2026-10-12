// @vitest-environment node
/**
 * End-to-end: the background ingest's link keeper reconnects the radio itself while no tab is
 * attached. Fake radio on real TCP, WebSocket tabs, real SQLite, real keeper (timers shortened).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { fromBinary } from '@bufbuild/protobuf';
import { Mesh } from '@meshtastic/protobufs';
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
const { validateHttpHost } = await import('../httpHostValidation');
const { startInProcessMeshtasticBackend } = await import('../meshtastic-backend/inProcessHost');
const { withMeshtasticLinkKeeper } = await import('../meshtastic-backend/keptLink');
const { mainMeshtasticLinkKeeperDeps } = await import('../meshtastic-backend/mainLinks');
const { MESHTASTIC_LINK_TARGET_SETTING } = await import('../meshtastic-backend/linkTargetStore');
const { createMeshtasticBackendPersist } = await import('../meshtastic-backend/persist');
const { mainMeshtasticBackendPersistDb } = await import('../meshtastic-backend/mainPersist');
const persistMeshtasticBackendRecord = createMeshtasticBackendPersist(
  mainMeshtasticBackendPersistDb(),
);
const { serializeWebBridgeFrame, parseWebBridgeServerFrame } =
  await import('../../shared/webBridgeProtocol');
const { ALICE, BROADCAST, configDump, textPacket } =
  await import('../meshtastic-backend/meshtasticFrames.testUtil');

const TOKEN = 'meshtastic-reconnect-token-0123';
/** Keeper timers run fast here; the real delays are covered by `linkKeeper.test.ts`. */
const fastTimers = {
  setTimeout: (fn: () => void) => setTimeout(fn, 20),
  clearTimeout: (h: unknown) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

describe('headless Meshtastic link keeper', () => {
  let dataDir = '';
  let base = '';
  let radio: net.Server;
  let radioPort = 0;
  /** Each radio-side client socket and the ToRadio frames it received. */
  const clients: { socket: net.Socket; toRadio: Mesh.ToRadio[] }[] = [];
  let server: ReturnType<typeof createHeadlessWebServer>;
  let backend: ReturnType<typeof startInProcessMeshtasticBackend>;

  const savedTarget = (): unknown => {
    const row = getDatabase()
      .prepareOnce('SELECT value FROM app_settings WHERE key = ?')
      .get(MESHTASTIC_LINK_TARGET_SETTING) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : null;
  };
  const storedPayloads = async (): Promise<string[]> =>
    (
      (await headlessIpcRegistry.invoke(
        'db:getMessages',
        { senderFrame: { url: HEADLESS_SENDER_URL }, sender: { id: 99 }, reply: () => {} },
        [0],
      )) as { payload: string }[]
    ).map((m) => m.payload);

  async function tabInvoke(channel: string, ...args: unknown[]): Promise<WebSocket> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ipc?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (data: Buffer) => {
        const frame = parseWebBridgeServerFrame(data.toString('utf8'));
        if (frame?.t === 'result') resolve();
        else if (frame?.t === 'error') reject(new Error(frame.message));
      });
      ws.send(serializeWebBridgeFrame({ t: 'invoke', id: 1, channel, args }));
    });
    return ws;
  }
  const closeTab = async (ws: WebSocket) => {
    ws.close();
    await vi.waitFor(() => {
      expect(server.sessionCount()).toBe(0);
    });
  };

  beforeAll(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-mt-keeper-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    initDatabase();
    registerMeshtasticDbIpcHandlers();
    fs.writeFileSync(path.join(dataDir, 'index.html'), '<html><head></head></html>');
    fs.writeFileSync(path.join(dataDir, 'bridge.js'), '');

    radio = net.createServer((socket) => {
      const client = { socket, toRadio: [] as Mesh.ToRadio[] };
      clients.push(client);
      let buf = Buffer.alloc(0);
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 4 && buf[0] === 0x94 && buf[1] === 0xc3) {
          const len = ((buf[2] ?? 0) << 8) | (buf[3] ?? 0);
          if (buf.length < 4 + len) break;
          client.toRadio.push(fromBinary(Mesh.ToRadioSchema, buf.subarray(4, 4 + len)));
          buf = buf.subarray(4 + len);
        }
      });
    });
    await new Promise<void>((resolve) => {
      radio.listen(0, '127.0.0.1', resolve);
    });
    radioPort = (radio.address() as net.AddressInfo).port;

    const ingest = startInProcessMeshtasticBackend({
      persist: (record) => {
        persistMeshtasticBackendRecord(record);
      },
      onCaughtUp: () => {},
    });
    backend = withMeshtasticLinkKeeper(ingest, {
      ...mainMeshtasticLinkKeeperDeps(),
      ...fastTimers,
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
    const window = new BrowserWindow(server.broadcast);
    registerTcpBridgeIpcHandlers({
      getMainWindow: () => window,
      validateHost: validateHttpHost,
      meshtasticTap: backend.taps.tcp,
    });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
  });

  afterAll(async () => {
    backend.dispose();
    destroyRegisteredTcpBridgeSockets('test');
    await server.close();
    for (const c of clients) c.socket.destroy();
    await new Promise<void>((resolve) => {
      radio.close(() => {
        resolve();
      });
    });
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reconnects after a drop with no tab, asks for config, and stores what arrives', async () => {
    const tab = await tabInvoke('meshtastic:tcp-connect', '127.0.0.1', radioPort);
    expect(savedTarget()).toEqual({ kind: 'tcp', host: '127.0.0.1', port: radioPort });
    await closeTab(tab);

    clients.at(-1)?.socket.destroy(); // the radio reboots
    await vi.waitFor(() => {
      expect(clients).toHaveLength(2);
      expect(clients[1]?.toRadio[0]?.payloadVariant.case).toBe('wantConfigId');
    });
    clients[1]?.socket.write(
      Buffer.concat(
        [
          ...configDump(),
          textPacket({ from: ALICE, to: BROADCAST, id: 700, text: 'after reboot' }),
        ].map((f) => Buffer.from(f)),
      ),
    );
    await vi.waitFor(async () => {
      expect(await storedPayloads()).toContain('after reboot');
    });
  });

  it('restores the saved link on a fresh start (server restart)', async () => {
    backend.dispose(); // the old server process ends: its keeper must not reconnect
    clients.at(-1)?.socket.destroy();
    const afterShutdown = clients.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(clients.length).toBe(afterShutdown);
    // A new keeper reads the target back from SQLite, like the next server process would.
    const restarted = withMeshtasticLinkKeeper(
      startInProcessMeshtasticBackend({ persist: () => {}, onCaughtUp: () => {} }),
      { ...mainMeshtasticLinkKeeperDeps(), ...fastTimers },
    );
    const before = clients.length;
    await vi.waitFor(() => {
      expect(clients.length).toBeGreaterThan(before);
    });
    restarted.dispose();
  });

  it('stays disconnected after an explicit disconnect', async () => {
    const tab = await tabInvoke('meshtastic:tcp-disconnect');
    expect(savedTarget()).toBeNull();
    await closeTab(tab);
    const before = clients.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(clients.length).toBe(before);
  });
});
