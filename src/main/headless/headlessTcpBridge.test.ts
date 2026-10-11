// @vitest-environment node
/**
 * Integration: the unchanged `ipc/tcp-bridge.ts` module running on the headless `electron` shim,
 * driven through the registry exactly as bridge sessions drive it.
 */
import net from 'node:net';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { destroyRegisteredTcpBridgeSockets, registerTcpBridgeIpcHandlers } =
  await import('../ipc/tcp-bridge');
const { validateHttpHost } = await import('../httpHostValidation');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};

describe('TCP bridge on the headless shim', () => {
  let radio: net.Server;
  let radioPort: number;
  const pushes: { channel: string; args: unknown[] }[] = [];

  beforeAll(() => {
    // Module-level registry, like the real server: register once for the whole file.
    const window = new BrowserWindow((channel, args) => {
      pushes.push({ channel, args });
    });
    registerTcpBridgeIpcHandlers({ getMainWindow: () => window, validateHost: validateHttpHost });
  });

  beforeEach(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    radio = net.createServer((socket) => {
      socket.on('data', (data: Buffer) => {
        socket.write(Buffer.concat([Buffer.from([0xaa]), data]));
      });
    });
    await new Promise<void>((resolve) => {
      radio.listen(0, '127.0.0.1', resolve);
    });
    radioPort = (radio.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    destroyRegisteredTcpBridgeSockets('test');
    await new Promise<void>((resolve) => {
      radio.close(() => {
        resolve();
      });
    });
    vi.restoreAllMocks();
  });

  it('registers both protocol bridges and round-trips bytes as push events', async () => {
    expect(headlessIpcRegistry.invokeChannels()).toEqual(
      expect.arrayContaining([
        'meshcore:tcp-connect',
        'meshcore:tcp-write',
        'meshcore:tcp-disconnect',
        'meshtastic:tcp-connect',
        'meshtastic:tcp-write',
        'meshtastic:tcp-disconnect',
      ]),
    );

    await headlessIpcRegistry.invoke('meshtastic:tcp-connect', event, ['127.0.0.1', radioPort]);
    await expect(
      headlessIpcRegistry.invoke('meshtastic:tcp-write', event, [[1, 2, 3]]),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(pushes.find((p) => p.channel === 'meshtastic:tcp-data')).toBeDefined();
    });
    const data = pushes.find((p) => p.channel === 'meshtastic:tcp-data');
    expect(Array.from(data?.args[0] as Uint8Array)).toEqual([0xaa, 1, 2, 3]);

    await headlessIpcRegistry.invoke('meshtastic:tcp-disconnect', event, []);
    await expect(headlessIpcRegistry.invoke('meshtastic:tcp-write', event, [[1]])).resolves.toBe(
      'no-socket',
    );
  });

  it('keeps sender validation: an event from an untrusted origin is refused', async () => {
    await expect(
      headlessIpcRegistry.invoke(
        'meshcore:tcp-connect',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        ['127.0.0.1', radioPort],
      ),
    ).rejects.toThrow('unauthorized sender');
  });

  it('keeps host validation', async () => {
    await expect(
      headlessIpcRegistry.invoke('meshcore:tcp-connect', event, ['bad host', radioPort]),
    ).rejects.toThrow('Invalid host format');
  });
});
