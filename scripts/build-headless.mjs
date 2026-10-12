#!/usr/bin/env node
/**
 * Build the headless web UI server (see docs/development/headless-webui.md).
 *
 * Emits into dist-headless/:
 *   server.js      Self-contained Node entry (`src/main/headless/index.ts`), `electron` → headless shim
 *   web-bridge.js  Browser IIFE of `src/preload/index.ts`, `electron` → WebSocket shim
 *   translation-worker.js + translation-licenses/  Offline translation worker (as in the
 *                  Electron main build), spawned by `translation:*` next to server.js
 *
 * The renderer itself is the normal Vite build (`pnpm run build:renderer` → dist/renderer).
 * A main-process module that imports an Electron API the shim does not provide fails this
 * build with "No matching export" — port it deliberately instead of stubbing it silently.
 *
 * Usage: node scripts/build-headless.mjs [--minify] [--outdir=dist-headless]
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MAIN_ESBUILD_EXTERNALS } from './esbuild-main-externals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/**
 * Externals for the server bundle. Empty on purpose: unlike the Electron main bundle (which keeps
 * {@link MAIN_ESBUILD_EXTERNALS} out for size), the headless server is fully self-contained so the
 * Docker runtime image needs Node and the built files only — no node_modules.
 */
export const HEADLESS_SERVER_EXTERNALS = [];

/** Packages that must never reach the headless bundle (no Electron at runtime). */
export const HEADLESS_FORBIDDEN_PACKAGES = MAIN_ESBUILD_EXTERNALS.filter((pkg) =>
  pkg.startsWith('electron'),
);

/**
 * What `process.platform` compiles to in the browser bridge: a global set by
 * `electronRendererShim.ts` from the server-injected meta, so `electronAPI.getPlatform()` reports
 * the OS the headless server runs on (linux, darwin or win32), matching the Electron app.
 */
export const HEADLESS_BRIDGE_PLATFORM_EXPR = 'globalThis.__MESH_CLIENT_HOST_PLATFORM__';

/**
 * @param {string[]} argv
 * @returns {{ minify: boolean, outdir: string }}
 */
export function parseBuildHeadlessArgs(argv) {
  let minify = false;
  let outdir = 'dist-headless';
  for (const arg of argv) {
    if (arg === '--minify') {
      minify = true;
      continue;
    }
    if (arg.startsWith('--outdir=')) {
      outdir = arg.slice('--outdir='.length);
      continue;
    }
    throw new Error(`Unknown build-headless argument: ${arg}`);
  }
  return { minify, outdir };
}

/**
 * @param {{ minify?: boolean, outdir?: string, absWorkingDir?: string, logLevel?: import('esbuild').LogLevel }} [opts]
 */
export async function buildHeadless(opts = {}) {
  const absWorkingDir = opts.absWorkingDir ?? projectRoot;
  const outdir = path.resolve(absWorkingDir, opts.outdir ?? 'dist-headless');
  const minify = opts.minify === true;
  const logLevel = opts.logLevel ?? 'info';
  const pkg = JSON.parse(fs.readFileSync(path.join(absWorkingDir, 'package.json'), 'utf8'));

  fs.mkdirSync(outdir, { recursive: true });

  await esbuild.build({
    absWorkingDir,
    entryPoints: ['src/main/headless/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(outdir, 'server.js'),
    external: HEADLESS_SERVER_EXTERNALS,
    alias: {
      electron: './src/main/headless/electronShim.ts',
      'electron-updater': './src/main/headless/electronUpdaterUnavailable.ts',
    },
    define: {
      __MESH_CLIENT_APP_VERSION__: JSON.stringify(String(pkg.version ?? '0.0.0')),
      __MESH_CLIENT_BUILD_INFO__: JSON.stringify(process.env.MESH_CLIENT_BUILD_INFO ?? ''),
    },
    minify,
    sourcemap: true,
    logLevel,
  });

  await esbuild.build({
    absWorkingDir,
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2023',
    format: 'iife',
    outfile: path.join(outdir, 'web-bridge.js'),
    alias: { electron: './src/preload/web/electronRendererShim.ts' },
    define: {
      'process.platform': HEADLESS_BRIDGE_PLATFORM_EXPR,
    },
    minify,
    sourcemap: true,
    logLevel,
  });

  // Offline translation worker: `bergamotWorker.ts` spawns `translation-worker.js` from the
  // directory of the running bundle, as in the Electron main build.
  await esbuild.build({
    absWorkingDir,
    entryPoints: ['src/main/translation/bergamotWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(outdir, 'translation-worker.js'),
    minify,
    logLevel,
  });
  const noticeDirectory = path.join(outdir, 'translation-licenses');
  fs.mkdirSync(noticeDirectory, { recursive: true });
  for (const notice of ['LICENSE-MPL-2.0.txt', 'LICENSE-fastText.txt', 'README.md']) {
    fs.copyFileSync(
      path.resolve(absWorkingDir, 'src/main/translation/vendor', notice),
      path.join(noticeDirectory, notice),
    );
  }

  return { outdir };
}

async function main() {
  const { minify, outdir } = parseBuildHeadlessArgs(process.argv.slice(2));
  await buildHeadless({ minify, outdir });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
