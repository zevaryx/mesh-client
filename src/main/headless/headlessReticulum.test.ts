// @vitest-environment node
/**
 * Reticulum on the headless `electron` shim: the sidecar binary resolves under
 * `app.getAppPath()/resources/reticulum-sidecar/` (where the Docker image puts it), and the
 * `reticulum:*` handlers answer the renderer's startup calls before a sidecar is started.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

const { BrowserWindow, configureHeadlessApp } = await import('./electronShim');
const { HEADLESS_SENDER_URL, headlessIpcRegistry } = await import('./ipcRegistry');
const { resolveSidecarBinaryPath, sidecarBinaryName } = await import('../reticulum-sidecar-path');
const { IDLE_RETICULUM_STATUS, registerReticulumIpcHandlers } =
  await import('../ipc/reticulum-handlers');

const event = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};

describe('Reticulum on the headless shim', () => {
  let root = '';
  let binary = '';

  beforeAll(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-rns-'));
    const appPath = path.join(root, 'app');
    binary = path.join(appPath, 'resources', 'reticulum-sidecar', sidecarBinaryName());
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '');
    configureHeadlessApp({ dataDir: path.join(root, 'data'), version: '0.0.0-test', appPath });
    const window = new BrowserWindow(() => {});
    registerReticulumIpcHandlers({
      idleStatus: IDLE_RETICULUM_STATUS,
      ensureManager: () => {
        throw new Error('test must not start a sidecar');
      },
      getManager: () => null,
      getMainWindow: () => window,
    });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves the sidecar binary under appPath/resources (Docker image layout)', () => {
    expect(resolveSidecarBinaryPath()).toBe(binary);
  });

  it('reports idle status before a sidecar is started', async () => {
    await expect(headlessIpcRegistry.invoke('reticulum:getStatus', event, [])).resolves.toEqual(
      IDLE_RETICULUM_STATUS,
    );
  });

  it('refuses untrusted senders', async () => {
    await expect(
      headlessIpcRegistry.invoke(
        'reticulum:getStatus',
        { ...event, senderFrame: { url: 'https://evil.example/' } },
        [],
      ),
    ).rejects.toThrow('unauthorized sender');
  });
});
