// @vitest-environment node
/**
 * Integration: the `db:*` / `chat:outbox:*` handler modules moved out of `index.ts`, running on
 * the headless `electron` shim against a real SQLite file and driven through the registry
 * exactly as bridge sessions drive them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { configureHeadlessApp, ipcMain } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { closeDatabase, initDatabase } = await import('../database');
const { registerMeshtasticDbIpcHandlers } = await import('../ipc/db-meshtastic-handlers');
const { registerMeshcoreDbIpcHandlers } = await import('../ipc/db-meshcore-handlers');
const { registerChatOutboxIpcHandlers } = await import('../ipc/chat-outbox-handlers');
const { registerReticulumDbIpcHandlers } = await import('../ipc/reticulum-db-handlers');
const { registerRrcDbIpcHandlers } = await import('../ipc/rrc-db-handlers');
const { registerEnvironmentTelemetryIpcHandlers } =
  await import('../ipc/environment-telemetry-handlers');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};
const untrusted = { ...event, senderFrame: { url: 'https://evil.example/' } };

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  headlessIpcRegistry.invoke(channel, event, args);

describe('headless db:* handlers', () => {
  let dataDir = '';

  beforeAll(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-db-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    initDatabase();
    registerMeshtasticDbIpcHandlers();
    registerMeshcoreDbIpcHandlers();
    registerChatOutboxIpcHandlers();
    // The pre-existing modules take ipcMain injected; the shim's ipcMain is the registry.
    const injected = { ipcMain } as unknown as Parameters<typeof registerRrcDbIpcHandlers>[0];
    registerReticulumDbIpcHandlers(injected);
    registerRrcDbIpcHandlers(injected);
    registerEnvironmentTelemetryIpcHandlers(injected);
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers every channel the renderer asks for at startup', () => {
    const channels = headlessIpcRegistry.invokeChannels();
    for (const channel of [
      'db:getNodes',
      'db:getMessages',
      'db:getMeshcoreMessages',
      'db:getMeshcoreContacts',
      'db:getAllMeshcoreHopHistory',
      'db:getAllMeshcorePathHistory',
      'db:pruneMessagesByCount',
      'db:pruneMeshcoreContactsByCount',
      'db:migrateRfStubNodes',
      'db:getBlockedContacts',
      'db:getReticulumMessages',
      'db:getEnvironmentTelemetry',
      'chat:outbox:list',
    ]) {
      expect(channels).toContain(channel);
    }
  });

  it('round-trips Meshtastic nodes and messages', async () => {
    await invoke('db:saveNode', { node_id: 0x1234, long_name: 'Base', short_name: 'BASE' });
    const nodes = (await invoke('db:getNodes')) as { node_id: number; long_name: string }[];
    expect(nodes).toEqual([expect.objectContaining({ node_id: 0x1234, long_name: 'Base' })]);

    await invoke('db:saveMessage', {
      sender_id: 0x1234,
      sender_name: 'Base',
      payload: 'hello mesh',
      channel: 0,
      timestamp: 1_700_000_000_000,
    });
    const messages = (await invoke('db:getMessages', 0)) as { payload: string }[];
    expect(messages.map((m) => m.payload)).toEqual(['hello mesh']);
  });

  it('keeps boundary validation on the moved handlers', async () => {
    await expect(invoke('db:saveMessage', { payload: 42 })).rejects.toThrow(
      'payload must be a string',
    );
    await expect(invoke('db:saveNode', { node_id: 1, long_name: 'x'.repeat(600) })).rejects.toThrow(
      'long_name exceeds maximum length',
    );
  });

  it('round-trips MeshCore contacts', async () => {
    await invoke('db:saveMeshcoreContact', {
      node_id: 42,
      public_key: 'ab'.repeat(32),
      adv_name: 'Repeater',
      on_radio: 1,
    });
    // Counts only contacts currently stored on the radio.
    await expect(invoke('db:getMeshcoreContactCount')).resolves.toBeGreaterThanOrEqual(1);
    const contacts = (await invoke('db:getMeshcoreContacts')) as { adv_name: string }[];
    expect(contacts.map((c) => c.adv_name)).toContain('Repeater');
  });

  it('queues and lists chat outbox entries', async () => {
    const added = await invoke('chat:outbox:add', {
      protocol: 'meshtastic',
      viewKey: 'channel:0',
      channel: 0,
      payload: 'queued while offline',
    });
    expect(added).toMatchObject({ payload: 'queued while offline', status: 'queued' });
    const list = (await invoke('chat:outbox:list', 'meshtastic')) as { payload: string }[];
    expect(list.map((e) => e.payload)).toContain('queued while offline');
    await expect(invoke('chat:outbox:list', 'not-a-protocol')).rejects.toThrow('invalid protocol');
  });

  it('serves the pre-existing Reticulum / RRC / telemetry modules', async () => {
    await expect(invoke('db:getBlockedContacts')).resolves.toBeDefined();
    await expect(invoke('db:getReticulumMessages')).resolves.toEqual(expect.any(Array));
  });

  it('refuses untrusted senders on reads and writes', async () => {
    await expect(headlessIpcRegistry.invoke('db:getNodes', untrusted, [])).rejects.toThrow(
      'unauthorized sender',
    );
    await expect(headlessIpcRegistry.invoke('db:clearMessages', untrusted, [])).rejects.toThrow();
    await expect(
      headlessIpcRegistry.invoke('chat:outbox:list', untrusted, ['meshtastic']),
    ).rejects.toThrow('unauthorized sender');
  });
});
