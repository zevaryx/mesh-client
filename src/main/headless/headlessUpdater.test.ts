// @vitest-environment node
/**
 * `initUpdater(window, { releaseCheckOnly: true })` on the headless shim: the GitHub release check
 * reports new versions to the renderer and never touches electron-updater.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const releases = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/shared/fetchGithubReleases', () => ({
  fetchAllGithubReleases: () => Promise.resolve(releases.rows),
}));
// If the release-check path ever reached electron-updater, this import would throw.
vi.mock('electron-updater', () => {
  throw new Error('electron-updater must not load in releaseCheckOnly mode');
});

const { BrowserWindow, configureHeadlessApp } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { initUpdater } = await import('../updater');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};

describe('headless release-check updater', () => {
  const pushes: { channel: string; args: unknown[] }[] = [];

  beforeAll(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    configureHeadlessApp({ dataDir: '/nonexistent-headless-updater-test', version: '1.0.0' });
    const window = new BrowserWindow((channel, args) => {
      pushes.push({ channel, args });
    });
    initUpdater(window, { releaseCheckOnly: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('reports a newer published release as available', async () => {
    releases.rows = [
      {
        tag_name: 'v1.2.0',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/Colorado-Mesh/mesh-client/releases/tag/v1.2.0',
      },
    ];
    await headlessIpcRegistry.invoke('update:check', event, []);
    expect(pushes.map((p) => p.channel)).toContain('update:checking');
    expect(pushes.find((p) => p.channel === 'update:available')?.args[0]).toMatchObject({
      version: '1.2.0',
    });
  });

  it('reports not-available when the running version is current', async () => {
    releases.rows = [
      {
        tag_name: 'v1.0.0',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/Colorado-Mesh/mesh-client/releases/tag/v1.0.0',
      },
    ];
    pushes.length = 0;
    await headlessIpcRegistry.invoke('update:check', event, []);
    expect(pushes.map((p) => p.channel)).toContain('update:not-available');
  });

  it('treats download as a no-op (no artifact to fetch headless)', async () => {
    await expect(headlessIpcRegistry.invoke('update:download', event, [])).resolves.toBeUndefined();
  });
});
