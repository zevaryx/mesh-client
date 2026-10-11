/**
 * Headless server entry point: serves the renderer to a browser and runs ported main-process
 * handlers under plain Node (no Electron). Built by `scripts/build-headless.mjs` with
 * `electron` aliased to `./electronShim`. See docs/development/headless-webui.md.
 */
import fs from 'node:fs';

import { validateHttpHost } from '../httpHostValidation';
import { destroyRegisteredTcpBridgeSockets, registerTcpBridgeIpcHandlers } from '../ipc/tcp-bridge';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { formatHeadlessAccessUrl, HeadlessConfigError, resolveHeadlessConfig } from './config';
import { BrowserWindow, configureHeadlessApp } from './electronShim';
import { headlessIpcRegistry } from './ipcRegistry';
import { createHeadlessWebServer } from './webServer';

declare const __MESH_CLIENT_APP_VERSION__: string | undefined;

/** Register every handler module that runs headless. Grow this list as modules are ported. */
function registerHeadlessHandlers(window: BrowserWindow): void {
  registerTcpBridgeIpcHandlers({
    getMainWindow: () => (window.isDestroyed() ? null : window),
    validateHost: validateHttpHost,
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = resolveHeadlessConfig(process.env, __dirname);
  } catch (err) {
    if (err instanceof HeadlessConfigError) {
      console.error(`[headless] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  configureHeadlessApp({
    dataDir: config.dataDir,
    version:
      typeof __MESH_CLIENT_APP_VERSION__ === 'string' ? __MESH_CLIENT_APP_VERSION__ : '0.0.0',
  });

  if (!fs.existsSync(`${config.rendererDir}/index.html`)) {
    console.error(
      `[headless] renderer build not found at ${sanitizeLogMessage(config.rendererDir)} ` +
        '(run pnpm run build:renderer or set MESH_CLIENT_RENDERER_DIR)',
    );
    process.exit(2);
  }

  const server = createHeadlessWebServer({
    registry: headlessIpcRegistry,
    rendererDir: config.rendererDir,
    bridgeScriptFile: config.bridgeScriptFile,
    token: config.token,
    host: config.host,
    port: config.port,
  });
  const window = new BrowserWindow(server.broadcast);
  registerHeadlessHandlers(window);

  const address = await server.listen();
  if (config.token === null) {
    console.warn(
      '[headless] MESH_CLIENT_WEB_AUTH=off — anyone who can reach this port has control',
    );
  }
  console.info(
    `[headless] ${headlessIpcRegistry.invokeChannels().length} IPC channels available; ` +
      `data dir ${sanitizeLogMessage(config.dataDir)}`,
  );
  // log-injection-ok token is generated or operator-supplied config, printed once by design
  console.info(`[headless] open ${formatHeadlessAccessUrl(config, address.port)}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[headless] ${signal} — shutting down`);
    window.destroy();
    destroyRegisteredTcpBridgeSockets('headless shutdown');
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

main().catch((err: unknown) => {
  console.error(
    '[headless] fatal:',
    sanitizeLogMessage(err instanceof Error ? (err.stack ?? err.message) : String(err)),
  );
  process.exit(1);
});
