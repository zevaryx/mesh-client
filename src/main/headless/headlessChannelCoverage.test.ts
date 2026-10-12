// @vitest-environment node
/**
 * Every channel the preload calls is either handled by the headless server, answered in the
 * browser (`browserLocalInvokes.ts`), or listed below as not ported yet. A new renderer channel
 * that headless mode cannot serve fails here instead of surfacing as "No handler registered" in a
 * browser tab. Shrink the pending list as plan steps land (docs/development/headless-webui.md).
 */
import fs from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => import('./electronShim'));

import { createBrowserLocalInvokes } from '../../preload/web/browserLocalInvokes';
import {
  HEADLESS_DROPPED_SEND_CHANNELS,
  HEADLESS_WINDOW_INVOKE_CHANNELS,
} from './headlessAppHandlers';

const ROOT = path.resolve(__dirname, '../../..');

/** Not ported to headless yet, by plan step. */
const HEADLESS_PENDING_CHANNELS: Record<string, readonly string[]> = {
  'step 4: offline maps': [
    'offline-maps:cancel',
    'offline-maps:clear',
    'offline-maps:download',
    'offline-maps:estimate',
    'offline-maps:status',
  ],
  'step 5: notifications': ['notify:message'],
  'step 6: BLE': [
    'ble-reset-pairing-retry-count',
    'bleCoexistence:acquireScan',
    'bleCoexistence:assertCanConnect',
    'bleCoexistence:getState',
    'bleCoexistence:register',
    'bleCoexistence:releaseScan',
    'bleCoexistence:suspendForReticulumBleConnect',
    'bleCoexistence:unregister',
    'bluetooth-cancel-pairing',
    'bluetooth-connect',
    'bluetooth-get-info',
    'bluetooth-pair',
    'bluetooth-provide-pin',
    'bluetooth-start-scan',
    'bluetooth-stop-scan',
    'bluetooth-unpair',
    'bluetooth-untrust',
    'gatt:clear-bond-recovery-exclusive',
    'gatt:connect',
    'gatt:disconnect',
    'gatt:is-connected',
    'gatt:pair',
    'gatt:pair-state',
    'gatt:release-ble-central',
    'gatt:start-scan',
    'gatt:stop-scan',
    'gatt:to-radio',
    'gatt:unpair',
  ],
};

async function headlessHandledChannels(): Promise<Set<string>> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/main/headless/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
    alias: {
      electron: './src/main/headless/electronShim.ts',
      'electron-updater': './src/main/headless/electronUpdaterUnavailable.ts',
    },
    define: { __MESH_CLIENT_APP_VERSION__: '"0"', __MESH_CLIENT_BUILD_INFO__: '""' },
  });
  const channels = new Set<string>();
  // Literal channel names, including ones prettier wraps onto the next line.
  const re = /\.(?:handle|on)\(\s*'([^']+)'/g;
  for (const file of Object.keys(result.metafile.inputs)) {
    if (!file.startsWith('src/main/') || !file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of source.matchAll(re)) if (m[1]) channels.add(m[1]);
  }
  // Registered from lists in headlessAppHandlers.ts rather than literal calls.
  for (const c of [...HEADLESS_WINDOW_INVOKE_CHANNELS, ...HEADLESS_DROPPED_SEND_CHANNELS]) {
    channels.add(c);
  }
  return channels;
}

function preloadChannels(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8');
  const re = /ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g;
  return [...new Set([...source.matchAll(re)].map((m) => m[1] ?? ''))].sort();
}

describe('headless IPC channel coverage', () => {
  it('serves every preload channel or lists it as pending', async () => {
    const handled = await headlessHandledChannels();
    const local = new Set(
      Object.keys(createBrowserLocalInvokes({ win: {} as Window, tokenStorageKey: 'k' })),
    );
    const missing = preloadChannels().filter((c) => !handled.has(c) && !local.has(c));
    const pending = Object.values(HEADLESS_PENDING_CHANNELS).flat().sort();
    expect(missing).toEqual(pending);
  }, 60_000);
});
