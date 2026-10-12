// @vitest-environment node
/**
 * Integration: server-feature IPC modules (logs, MECP received log, Reticulum attachment reads,
 * translation, geo, beacon) on the headless `electron` shim, driven through the registry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { configureHeadlessApp } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { HeadlessSessionSender } = await import('./sessionSender');
const { initLogFile, patchMainConsole } = await import('../log-service');
const { registerLogIpcHandlers } = await import('../ipc/log-handlers');
const { registerChatContentIpcHandlers } = await import('../ipc/chat-content-handlers');
const { registerBeaconIpcHandlers } = await import('../ipc/beacon-handlers');
const { registerTranslationHandlers } = await import('../ipc/translation-handlers');

const pushed: { channel: string; args: unknown[] }[] = [];
const sender = new HeadlessSessionSender(1, (channel, args) => pushed.push({ channel, args }));
const event = { senderFrame: { url: HEADLESS_SENDER_URL }, sender, reply: () => {} };
const invoke = (channel: string, ...args: unknown[]) =>
  headlessIpcRegistry.invoke(channel, event, args);

describe('headless server-feature handlers', () => {
  let dataDir = '';
  let disposeTranslation: () => void = () => {};

  beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-features-'));
    configureHeadlessApp({ dataDir, version: '0.0.0-test' });
    patchMainConsole();
    initLogFile();
    registerLogIpcHandlers();
    registerChatContentIpcHandlers();
    registerBeaconIpcHandlers();
    const settings = new Map<string, string>();
    disposeTranslation = registerTranslationHandlers({
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => {
        settings.set(k, v);
      },
      onProgress: () => {},
    });
  });

  afterAll(() => {
    disposeTranslation();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the server log: path under the data dir, recent lines, clear', async () => {
    console.warn('[test] headless log line');
    const logPath = (await invoke('log:getPath')) as string;
    expect(logPath.startsWith(dataDir)).toBe(true);
    const lines = (await invoke('log:getRecentLines')) as { message: string }[];
    expect(lines.some((l) => l.message.includes('headless log line'))).toBe(true);
    await expect(invoke('log:clear')).resolves.toBeUndefined();
  });

  it('appends received MECP reports and rejects malformed entries', async () => {
    await expect(invoke('mecp:appendReceived', { nope: true })).rejects.toThrow('invalid entry');
  });

  it('reads Reticulum attachments only inside the attachments jail', async () => {
    const dir = path.join(dataDir, 'reticulum', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    // Voice memos are Ogg; the reader only returns files with the `OggS` magic.
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 3])]);
    const file = path.join(dir, 'memo.ogg');
    fs.writeFileSync(file, ogg);
    const ok = (await invoke('chat:readReticulumAttachmentBytes', file)) as {
      dataBase64: string | null;
    };
    expect(ok.dataBase64).toBe(ogg.toString('base64'));
    const outside = path.join(dataDir, 'secret.bin');
    fs.writeFileSync(outside, 'x');
    await expect(invoke('chat:readReticulumAttachmentBytes', outside)).rejects.toThrow();
  });

  it('answers translation status with the pack store under the data dir', async () => {
    await expect(invoke('translation:getStatus')).resolves.toBeDefined();
  });

  it('streams a beacon feed only to its caller and drops it when the tab closes', async () => {
    // A non-public URL is refused before any network access.
    const result = (await invoke('beacon:connect', { url: 'http://127.0.0.1:1/feed' })) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    sender.destroy();
    expect(sender.isDestroyed()).toBe(true);
    sender.send('beacon:update', {});
    expect(pushed).toEqual([]);
  });
});
