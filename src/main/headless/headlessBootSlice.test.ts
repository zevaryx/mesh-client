// @vitest-environment node
/**
 * Integration: the boot-gate handlers (`secureSecrets:*`, `appSettings:*`) and `database.ts`
 * running on the headless `electron` shim against a real SQLite file, driven through the
 * registry exactly as bridge sessions drive them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { configureHeadlessApp, configureHeadlessSafeStorage } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { closeDatabase, getDatabase, initDatabase } = await import('../database');
const { registerSecureSecretsIpcHandlers } = await import('../ipc/secure-secrets-handlers');
const { registerAppSettingsIpcHandlers } = await import('../ipc/app-settings-handlers');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  headlessIpcRegistry.invoke(channel, event, args);

describe('headless boot slice (secrets + app settings + database)', () => {
  let dataDir = '';

  beforeAll(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-boot-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    configureHeadlessSafeStorage('integration-test-key-material');
    initDatabase();
    registerSecureSecretsIpcHandlers({ getDatabase });
    registerAppSettingsIpcHandlers({ getDatabase });
  });

  afterAll(() => {
    closeDatabase();
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates the database in the configured data dir', () => {
    expect(fs.existsSync(path.join(dataDir, 'mesh-client.db'))).toBe(true);
  });

  it('persists secrets encrypted when an operator key is configured', async () => {
    await expect(invoke('secureSecrets:status')).resolves.toEqual({
      available: true,
      persistent: true,
    });
    await expect(
      invoke('secureSecrets:set', 'meshcore:identity', '[1,2,3]', true),
    ).resolves.toEqual({ available: true, persistent: true, verified: true });
    await expect(invoke('secureSecrets:get', 'meshcore:identity')).resolves.toBe('[1,2,3]');

    const row = getDatabase()
      .prepareOnce('SELECT ciphertext FROM secure_secrets WHERE key = ?')
      .get('meshcore:identity') as { ciphertext: string };
    expect(Buffer.from(row.ciphertext, 'base64').toString('utf8')).not.toContain('[1,2,3]');
  });

  it('keeps secrets in memory only, and refuses required persistence, without a key', async () => {
    configureHeadlessSafeStorage(null);
    try {
      await expect(invoke('secureSecrets:status')).resolves.toEqual({
        available: true,
        persistent: false,
      });
      await expect(invoke('secureSecrets:set', 'mqtt:meshtastic', 'pw', true)).rejects.toThrow(
        'OS key storage unavailable',
      );
      await expect(invoke('secureSecrets:set', 'mqtt:meshtastic', 'pw')).resolves.toMatchObject({
        persistent: false,
      });
      const rows = getDatabase()
        .prepareOnce('SELECT key FROM secure_secrets WHERE key = ?')
        .all('mqtt:meshtastic');
      expect(rows).toEqual([]);
    } finally {
      configureHeadlessSafeStorage('integration-test-key-material');
    }
  });

  it('rejects secret keys outside the allow-list', async () => {
    await expect(invoke('secureSecrets:set', 'anything:else', 'x')).rejects.toThrow(
      'secureSecrets: invalid key',
    );
  });

  it('round-trips allow-listed app settings and rejects others', async () => {
    await expect(invoke('appSettings:set', 'use24HourTime', '1')).resolves.toEqual({ changes: 1 });
    await expect(invoke('appSettings:get')).resolves.toMatchObject({ use24HourTime: '1' });
    await expect(invoke('appSettings:remove', 'use24HourTime')).resolves.toEqual({ changes: 1 });
    await expect(invoke('appSettings:set', 'notAllowed', '1')).rejects.toThrow(
      'appSettings:set: key not allowed',
    );
    await expect(invoke('appSettings:set', 'locale', 'x'.repeat(300))).rejects.toThrow(
      'value must be a string under',
    );
  });

  it('keeps sender validation on the moved handlers', async () => {
    await expect(
      headlessIpcRegistry.invoke(
        'appSettings:get',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [],
      ),
    ).rejects.toThrow('IPC sender validation failed');
    await expect(
      headlessIpcRegistry.invoke(
        'secureSecrets:getAll',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [],
      ),
    ).rejects.toThrow('unauthorized sender');
  });
});
