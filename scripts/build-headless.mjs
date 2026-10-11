#!/usr/bin/env node
/**
 * Build the headless web UI server (see docs/development/headless-webui.md).
 *
 * Emits into dist-headless/:
 *   server.js      Self-contained Node entry (`src/main/headless/index.ts`), `electron` → headless shim
 *   web-bridge.js  Browser IIFE of `src/preload/index.ts`, `electron` → WebSocket shim
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

/** Platform reported by `electronAPI.getPlatform()` in the browser: the server's OS. */
export const HEADLESS_BRIDGE_PLATFORM = 'linux';

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
    alias: { electron: './src/main/headless/electronShim.ts' },
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
      'process.platform': JSON.stringify(HEADLESS_BRIDGE_PLATFORM),
    },
    minify,
    sourcemap: true,
    logLevel,
  });

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
