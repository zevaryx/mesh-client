// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHeadless,
  HEADLESS_BRIDGE_PLATFORM_EXPR,
  HEADLESS_FORBIDDEN_PACKAGES,
  HEADLESS_SERVER_EXTERNALS,
  parseBuildHeadlessArgs,
} from './build-headless.mjs';

describe('build-headless', () => {
  let outdir = '';

  afterEach(() => {
    if (outdir) fs.rmSync(outdir, { recursive: true, force: true });
  });

  it('parses args', () => {
    expect(parseBuildHeadlessArgs([])).toEqual({ minify: false, outdir: 'dist-headless' });
    expect(parseBuildHeadlessArgs(['--minify', '--outdir=x'])).toEqual({
      minify: true,
      outdir: 'x',
    });
    expect(() => parseBuildHeadlessArgs(['--nope'])).toThrow('Unknown build-headless argument');
  });

  it('keeps the server bundle self-contained', () => {
    expect(HEADLESS_SERVER_EXTERNALS).toEqual([]);
    expect(HEADLESS_FORBIDDEN_PACKAGES).toEqual(['electron', 'electron-updater']);
  });

  it('bundles the server and browser bridge with no real electron dependency', async () => {
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-headless-build-'));
    await buildHeadless({ outdir, logLevel: 'silent' });

    const server = fs.readFileSync(path.join(outdir, 'server.js'), 'utf8');
    for (const pkg of HEADLESS_FORBIDDEN_PACKAGES) {
      expect(server).not.toContain(`require("${pkg}")`);
    }
    // Self-contained: ws is bundled, not required from node_modules at runtime.
    expect(server).not.toMatch(/require\(["']ws["']\)/);
    expect(server).toContain('meshtastic:tcp-connect');
    // electron-updater is aliased to a stub that throws, so its code never ships headless.
    expect(server).toContain('electron-updater is not available in headless builds');
    expect(server).not.toContain('checkForUpdatesAndNotify');

    const bridge = fs.readFileSync(path.join(outdir, 'web-bridge.js'), 'utf8');
    expect(bridge).not.toMatch(/require\(["']electron["']\)/);
    expect(bridge).not.toContain('process.platform');
    // getPlatform() reads the server-reported platform, not a build-time constant.
    expect(bridge).toContain(HEADLESS_BRIDGE_PLATFORM_EXPR);
    expect(bridge).toContain('exposeInMainWorld');
  }, 60_000);
});
