// @vitest-environment node
/**
 * Integration: TAK server lifecycle (`tak/tak-server-host.ts` + `ipc/tak-handlers.ts`) on the
 * headless `electron` shim: start the real TLS server through IPC, observe the status push, complete
 * a TLS handshake against it, stop it. Plus the startup status calls the renderer makes.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow, configureHeadlessApp } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { createTakServerHost, IDLE_TAK_STATUS, validateTakSettings } =
  await import('../tak/tak-server-host');
const { registerTakIpcHandlers } = await import('../ipc/tak-handlers');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  headlessIpcRegistry.invoke(channel, event, args);

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => {
    srv.listen(0, '127.0.0.1', resolve);
  });
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
  return port;
}

describe('TAK on the headless shim', () => {
  let dataDir = '';
  const pushes: { channel: string; args: unknown[] }[] = [];
  let host: ReturnType<typeof createTakServerHost>;

  beforeAll(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-tak-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    const window = new BrowserWindow((channel, args) => {
      pushes.push({ channel, args });
    });
    host = createTakServerHost({ getMainWindow: () => window });
    registerTakIpcHandlers({
      idleTakStatus: IDLE_TAK_STATUS,
      ensureTakServerManager: () => host.ensure(),
      getTakServerManager: () => host.get(),
      validateTakSettings,
    });
  });

  afterAll(() => {
    host.get()?.stop();
    host.get()?.stopRemote();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('answers the startup status calls before the manager is loaded', async () => {
    await expect(invoke('tak:getStatus')).resolves.toEqual(IDLE_TAK_STATUS);
    await expect(invoke('tak:getConnectedClients')).resolves.toEqual([]);
    await expect(invoke('tak:getContacts')).resolves.toEqual([]);
    await expect(invoke('tak:remoteGetStatus')).resolves.toBeDefined();
  });

  it('auto-start restores nothing without saved settings', () => {
    expect(() => {
      host.autoStartFromSavedSettings();
    }).not.toThrow();
    expect(host.get()).toBeNull();
  });

  it('starts the TLS server, pushes status, accepts a TLS handshake, and stops', async () => {
    const port = await freePort();
    await invoke('tak:start', {
      enabled: true,
      port,
      serverName: 'headless-test',
      requireClientCert: false,
      autoStart: false,
    });
    await vi.waitFor(
      () => {
        expect(
          pushes.some(
            (p) =>
              p.channel === 'tak:status' && (p.args[0] as { running?: boolean }).running === true,
          ),
        ).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    expect(fs.existsSync(path.join(dataDir, 'tak-settings.json'))).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });

    await invoke('tak:stop');
    await expect(invoke('tak:getStatus')).resolves.toMatchObject({ running: false });
  }, 30_000);

  it('rejects invalid settings and untrusted senders', async () => {
    await expect(
      invoke('tak:start', {
        enabled: true,
        port: 80,
        serverName: 'x',
        requireClientCert: false,
        autoStart: false,
      }),
    ).rejects.toThrow('port must be an integer 1024–65535');
    await expect(
      headlessIpcRegistry.invoke(
        'tak:getStatus',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [],
      ),
    ).rejects.toThrow('unauthorized sender');
  });

  it('reports file dialogs as unavailable instead of silently cancelling', async () => {
    await expect(invoke('tak:remoteImportCredentials')).rejects.toThrow(
      'native file dialogs are not available in headless mode',
    );
  });
});
