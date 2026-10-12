#!/usr/bin/env node
/**
 * Browser smoke test for a running headless server (the Docker image in CI, or
 * `pnpm run start:headless` locally):
 *
 *   node scripts/headless-smoke.mjs --url http://127.0.0.1:8080 --token <token> \
 *     [--browser /path/to/chromium] [--screenshot smoke.png]
 *
 * Checks, in order: `/healthz`; that `/tiles` and the bridge refuse requests without the token;
 * then, in Chromium, that the app loads with `?token=`, strips the token from the address bar,
 * reports `hostKind === 'web'`, answers IPC (settings, log path, offline-map status), and that no
 * channel the page uses comes back "No handler registered". Exits 1 with a list of failures.
 *
 * `--browser` (or `MESH_CLIENT_SMOKE_BROWSER`) points at a Chromium / Chrome binary; without it
 * Playwright's own Chromium is used.
 */
import { chromium } from '@playwright/test';

const PAGE_SETTLE_MS = 8000;

/** @param {string[]} argv */
export function parseSmokeArgs(argv) {
  /** @type {{ url: string, token: string | null, browser: string | null, screenshot: string | null }} */
  const opts = {
    url: 'http://127.0.0.1:8080',
    token: null,
    browser: process.env.MESH_CLIENT_SMOKE_BROWSER ?? null,
    screenshot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--url', '--token', '--browser', '--screenshot'].includes(flag ?? '')) {
      throw new Error(`unknown argument: ${String(flag)}`);
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    opts[/** @type {'url' | 'token' | 'browser' | 'screenshot'} */ (flag.slice(2))] = value;
    i++;
  }
  opts.url = opts.url.replace(/\/+$/, '');
  return opts;
}

/**
 * @param {ReturnType<typeof parseSmokeArgs>} opts
 * @returns {Promise<{ failures: string[], report: Record<string, unknown> }>}
 */
export async function runHeadlessSmoke(opts) {
  /** @type {string[]} */
  const failures = [];
  /** @type {Record<string, unknown>} */
  const report = {};
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
  };

  const health = await fetch(`${opts.url}/healthz`);
  expect(health.ok, `/healthz answered ${health.status}`);

  if (opts.token) {
    const tiles = await fetch(`${opts.url}/tiles/osm/1/0/0.png`);
    expect(tiles.status === 401, `/tiles without the cookie answered ${tiles.status}, not 401`);
    const files = await fetch(`${opts.url}/files/download/${'0'.repeat(32)}`);
    expect(files.status === 401, `/files without the token answered ${files.status}, not 401`);
  }

  const browser = await chromium.launch(
    opts.browser ? { executablePath: opts.browser } : undefined,
  );
  try {
    const page = await browser.newPage();
    /** @type {Set<string>} */
    const unhandled = new Set();
    /** @type {string[]} */
    const pageErrors = [];
    page.on('console', (msg) => {
      const text = msg.text();
      const m = /No handler registered for '([^']+)'/.exec(text);
      if (m) unhandled.add(m[1] ?? text);
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    const query = opts.token ? `/?token=${encodeURIComponent(opts.token)}` : '/';
    await page.goto(`${opts.url}${query}`);
    await page.waitForTimeout(PAGE_SETTLE_MS);

    const state = await page.evaluate(async () => {
      const api = /** @type {any} */ (window).electronAPI;
      const settled = async (fn) => {
        try {
          return { ok: true, value: await fn() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      };
      return {
        hostKind: api?.hostKind,
        addressHasToken: new URL(location.href).searchParams.has('token'),
        rendered: (document.getElementById('root')?.childElementCount ?? 0) > 0,
        settings: await settled(() => api.appSettings.getAll()),
        logPath: await settled(() => api.log.getPath()),
        offlineMaps: await settled(() => api.offlineMaps.status()),
      };
    });
    report.state = state;
    report.unhandledChannels = [...unhandled];
    report.pageErrors = pageErrors;
    expect(state.hostKind === 'web', `electronAPI.hostKind is ${String(state.hostKind)}`);
    expect(!state.addressHasToken, 'the token stayed in the address bar');
    expect(state.rendered, 'the app did not render into #root');
    for (const key of /** @type {const} */ (['settings', 'logPath', 'offlineMaps'])) {
      expect(state[key].ok, `${key} invoke failed: ${state[key].error ?? ''}`);
    }
    expect(unhandled.size === 0, `channels with no handler: ${[...unhandled].join(', ')}`);
    if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
  } finally {
    await browser.close();
  }
  return { failures, report };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const { failures, report } = await runHeadlessSmoke(parseSmokeArgs(process.argv.slice(2)));
    console.info(JSON.stringify(report, null, 2));
    if (failures.length > 0) {
      console.error(`headless smoke: ${failures.length} failure(s)`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.info('headless smoke: ok');
  } catch (err) {
    console.error('headless smoke: error', err);
    process.exit(1);
  }
}
