// @vitest-environment node
/**
 * Integration: `ipc/mqtt-handlers.ts` with a real `MQTTManager` on the headless `electron` shim,
 * against a minimal in-process MQTT 3.1.1 broker (CONNACK / SUBACK / PINGRESP, records PUBLISH
 * topics). Driven through the registry exactly as bridge sessions drive it.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow, configureHeadlessApp } = await import('./electronShim');
const { closeDatabase, initDatabase } = await import('../database');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { registerMqttIpcHandlers } = await import('../ipc/mqtt-handlers');
const { MQTTManager } = await import('../mqtt-manager');
const { MeshcoreMqttAdapter } = await import('../meshcore-mqtt-adapter');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  headlessIpcRegistry.invoke(channel, event, args);

/** Split a TCP stream into MQTT control packets (fixed header + varint remaining length). */
function* mqttPackets(buf: Buffer): Generator<{ type: number; flags: number; body: Buffer }> {
  let off = 0;
  while (off + 2 <= buf.length) {
    let mult = 1;
    let len = 0;
    let i = off + 1;
    let byte: number;
    do {
      if (i >= buf.length) return;
      byte = buf[i++] ?? 0;
      len += (byte & 0x7f) * mult;
      mult *= 128;
    } while (byte & 0x80);
    if (i + len > buf.length) return;
    const first = buf[off] ?? 0;
    yield { type: first >> 4, flags: first & 0x0f, body: buf.subarray(i, i + len) };
    off = i + len;
  }
}

describe('MQTT on the headless shim', () => {
  let broker: net.Server;
  let brokerPort = 0;
  let dataDir = '';
  const published: string[] = [];
  const pushes: { channel: string; args: unknown[] }[] = [];
  const mqttManager = new MQTTManager();
  const meshcoreMqttAdapter = new MeshcoreMqttAdapter();

  beforeAll(async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // mqtt:connect resolves a persisted broker client id from SQLite, as on the real server.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-mqtt-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    initDatabase();
    broker = net.createServer((socket) => {
      socket.on('data', (data: Buffer) => {
        for (const p of mqttPackets(data)) {
          if (p.type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK
          if (p.type === 8) {
            // SUBACK: echo packet id, grant QoS 0 for each requested topic
            const topics = Math.max(1, Math.floor((p.body.length - 2) / 3));
            const suback = Buffer.alloc(4 + topics - 1);
            suback[0] = 0x90;
            suback[1] = 2 + topics;
            p.body.copy(suback, 2, 0, 2);
            socket.write(suback);
          }
          if (p.type === 3) {
            const topicLen = p.body.readUInt16BE(0);
            published.push(p.body.subarray(2, 2 + topicLen).toString('utf8'));
          }
          if (p.type === 12) socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
        }
      });
      socket.on('error', () => {
        // catch-no-log-ok client teardown resets the socket in tests
      });
    });
    await new Promise<void>((resolve) => {
      broker.listen(0, '127.0.0.1', resolve);
    });
    brokerPort = (broker.address() as net.AddressInfo).port;

    const window = new BrowserWindow((channel, args) => {
      pushes.push({ channel, args });
    });
    registerMqttIpcHandlers({
      mqttManager,
      meshcoreMqttAdapter,
      getMainWindow: () => window,
      getTakServerManager: () => null,
    });
  });

  afterAll(async () => {
    mqttManager.disconnect();
    meshcoreMqttAdapter.disconnect();
    await new Promise<void>((resolve) => {
      broker.close(() => {
        resolve();
      });
    });
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const statusPushes = (): unknown[] =>
    pushes.filter((p) => p.channel === 'mqtt:status').map((p) => p.args[0]);

  it('connects, pushes status to the renderer, publishes, and disconnects', async () => {
    await invoke('mqtt:connect', {
      server: '127.0.0.1',
      port: brokerPort,
      topicPrefix: 'msh/US/',
      username: '',
      password: '',
      mqttTransportProtocol: 'meshtastic',
    });
    await vi.waitFor(
      () => {
        expect(statusPushes()).toContainEqual({ status: 'connected', protocol: 'meshtastic' });
      },
      { timeout: 8000, interval: 50 },
    );
    await expect(invoke('mqtt:getClientId', 'meshtastic')).resolves.toEqual(expect.any(String));

    await invoke('mqtt:publish', {
      text: 'hello from headless',
      from: 0x1234,
      channel: 0,
      publishJsonMirror: false,
    });
    await vi.waitFor(
      () => {
        expect(published.some((t) => t.startsWith('msh/US/'))).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    await invoke('mqtt:disconnect', 'meshtastic');
    await vi.waitFor(() => {
      expect(statusPushes()).toContainEqual({ status: 'disconnected', protocol: 'meshtastic' });
    });
  }, 20_000);

  it('keeps settings and payload validation', async () => {
    await expect(invoke('mqtt:connect', { server: 'bad host', port: 1883 })).rejects.toThrow(
      'server hostname invalid',
    );
    await expect(invoke('mqtt:connect', { server: '127.0.0.1', port: 0 })).rejects.toThrow(
      'port must be 1–65535',
    );
    await expect(
      invoke('mqtt:publish', { text: 'x', from: 0, channel: 0, publishJsonMirror: false }),
    ).rejects.toThrow('from must be a positive node id');
  });

  it('refuses untrusted senders', async () => {
    await expect(
      headlessIpcRegistry.invoke(
        'mqtt:connect',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [{ server: '127.0.0.1', port: brokerPort }],
      ),
    ).rejects.toThrow('unauthorized sender');
  });
});
