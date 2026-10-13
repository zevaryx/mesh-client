// @vitest-environment node
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: vi.fn(),
  },
}));
vi.mock('../validate-ipc-sender', () => ({
  assertIpcSender: vi.fn(),
  validateIpcSender: () => true,
}));
vi.mock('../mqtt-broker-client-id', () => ({ resolveMqttBrokerClientId: () => 'client-1' }));

const { registerMqttIpcHandlers } = await import('../ipc/mqtt-handlers');
const { createMqttConnectionReuse } = await import('./mqttConnectionReuse');

class FakeClient extends EventEmitter {
  status = 'disconnected';
  connect = vi.fn(() => {
    this.status = 'connected';
  });
  disconnect = vi.fn(() => {
    this.status = 'disconnected';
  });
  getStatus = () => this.status;
}

const settings = {
  server: 'mqtt.example.org',
  port: 1883,
  username: '',
  password: '',
  topicPrefix: 'msh/US/',
  mqttTransportProtocol: 'meshtastic',
};

function setup(reuse: boolean) {
  handlers.clear();
  const meshtastic = new FakeClient();
  const meshcore = new FakeClient();
  const send = vi.fn();
  registerMqttIpcHandlers({
    mqttManager: meshtastic as never,
    meshcoreMqttAdapter: meshcore as never,
    getMainWindow: () => ({ webContents: { send } }),
    getTakServerManager: () => null,
    ...(reuse ? { keepLiveConnection: createMqttConnectionReuse() } : {}),
  });
  const connect = (s: object) => handlers.get('mqtt:connect')?.({}, s);
  return { meshtastic, send, connect };
}

describe('mqtt:connect reuse (headless shared viewing)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('keeps a live connection with the same settings and re-sends its status', () => {
    const t = setup(true);
    t.connect(settings);
    t.connect(settings);
    expect(t.meshtastic.connect).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith('mqtt:status', {
      status: 'connected',
      protocol: 'meshtastic',
    });
  });

  it('reconnects for new settings or a dropped connection', () => {
    const t = setup(true);
    t.connect(settings);
    t.connect({ ...settings, topicPrefix: 'msh/EU/' });
    expect(t.meshtastic.connect).toHaveBeenCalledTimes(2);
    t.meshtastic.status = 'error';
    t.connect({ ...settings, topicPrefix: 'msh/EU/' });
    expect(t.meshtastic.connect).toHaveBeenCalledTimes(3);
  });

  it('always reconnects on desktop (no reuse)', () => {
    const t = setup(false);
    t.connect(settings);
    t.connect(settings);
    expect(t.meshtastic.connect).toHaveBeenCalledTimes(2);
  });
});
