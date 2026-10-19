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
  // AI conversation summaries (upstream `ipc/ai-handlers.ts`), ported next.
  aiSummaries: [
    'ai:cancel',
    'ai:cancelLocalModel',
    'ai:getHistory',
    'ai:getStatus',
    'ai:installLocalModel',
    'ai:listEndpointModels',
    'ai:listLocalModels',
    'ai:probeOsAi',
    'ai:removeLocalModel',
    'ai:selectLocalModel',
    'ai:setConfig',
    'ai:setEnabled',
    'ai:summarize',
    'ai:testConfig',
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
