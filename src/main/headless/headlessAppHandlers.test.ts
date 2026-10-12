// @vitest-environment node
/** Headless answers for window / OS channels, driven through the registry like a bridge session. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { HEADLESS_QUIT_UNAVAILABLE, HEADLESS_WINDOW_INVOKE_CHANNELS, registerHeadlessAppHandlers } =
  await import('./headlessAppHandlers');

const event = { senderFrame: { url: HEADLESS_SENDER_URL }, sender: { id: 1 }, reply: () => {} };
const untrusted = { ...event, senderFrame: { url: 'https://evil.example/' } };
const invoke = (channel: string, ...args: unknown[]) =>
  headlessIpcRegistry.invoke(channel, event, args);

describe('headless app handlers', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerHeadlessAppHandlers();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('answers window chrome and login items without a window', async () => {
    await expect(invoke('app:requestAttention')).resolves.toBeUndefined();
    await expect(invoke('app:showEmojiPanel')).resolves.toBeUndefined();
    await expect(invoke('app:getLoginItem')).resolves.toEqual({ openAtLogin: false });
    await expect(invoke('app:setLoginItem', true)).resolves.toBeUndefined();
  });

  it('refuses to quit or relaunch the shared server from a browser', async () => {
    await expect(invoke('app:quit')).rejects.toThrow(HEADLESS_QUIT_UNAVAILABLE);
    await expect(invoke('app:relaunch')).rejects.toThrow(HEADLESS_QUIT_UNAVAILABLE);
  });

  it('reports process uptime and liveness, and grants media (the browser prompts)', async () => {
    expect(await invoke('app:getProcessUptimeSec')).toBeTypeOf('number');
    expect(await invoke('app:getRendererLiveness')).toEqual({
      mainUptimeSec: expect.any(Number) as number,
      lastRendererHeartbeatAgeMs: null,
      rendererUnresponsiveSeen: false,
      rss: expect.any(Number) as number,
      heapUsed: expect.any(Number) as number,
    });
    await expect(invoke('media:ensureMicrophoneAccess')).resolves.toEqual({
      granted: true,
      status: 'granted',
    });
    await expect(invoke('media:ensureCameraAccess')).resolves.toMatchObject({ granted: true });
  });

  it('drops Electron chooser and power signals, and still checks senders', async () => {
    for (const channel of [
      'set-tray-unread',
      'device-connected',
      'device-disconnected',
      'serial-port-selected',
      'serial-port-cancelled',
    ]) {
      expect(headlessIpcRegistry.emit(channel, event, [])).toBe(true); // a listener took it
    }
    expect(console.warn).not.toHaveBeenCalled();
    headlessIpcRegistry.emit('set-tray-unread', untrusted, [1]);
    expect(console.warn).toHaveBeenCalledWith('[headless] set-tray-unread: unauthorized sender');
    await expect(headlessIpcRegistry.invoke('app:getLoginItem', untrusted, [])).rejects.toThrow();
  });

  it('registers every channel it lists, and declines show-in-folder', async () => {
    for (const channel of HEADLESS_WINDOW_INVOKE_CHANNELS) {
      expect(headlessIpcRegistry.hasHandler(channel)).toBe(true);
    }
    await expect(invoke('chat:showItemInFolder', '/srv/file.bin')).resolves.toEqual({ ok: false });
  });
});
