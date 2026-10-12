/**
 * Headless server entry point: serves the renderer to a browser and runs ported main-process
 * handlers under plain Node (no Electron). Built by `scripts/build-headless.mjs` with
 * `electron` aliased to `./electronShim`. See docs/development/headless-webui.md.
 */
import fs from 'node:fs';

// Resolves to the headless shim at bundle time (scripts/build-headless.mjs aliases `electron`).
import { ipcMain } from 'electron';

import {
  closeDatabase,
  getDatabase,
  initDatabase,
  isDatabaseSchemaTooNewError,
  isDatabaseSchemaUpgradeDeclinedError,
} from '../database';
import { MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE_ENV } from '../fatal-startup-dialog';
import { validateHttpHost } from '../httpHostValidation';
import { registerAppSettingsIpcHandlers } from '../ipc/app-settings-handlers';
import { registerChatOutboxIpcHandlers } from '../ipc/chat-outbox-handlers';
import { registerMeshcoreDbIpcHandlers } from '../ipc/db-meshcore-handlers';
import { registerMeshtasticDbIpcHandlers } from '../ipc/db-meshtastic-handlers';
import { registerEnvironmentTelemetryIpcHandlers } from '../ipc/environment-telemetry-handlers';
import { registerHttpBridgeIpcHandlers, stopHttpBridgePolling } from '../ipc/http-bridge';
import { registerMqttIpcHandlers } from '../ipc/mqtt-handlers';
import { registerReticulumDbIpcHandlers } from '../ipc/reticulum-db-handlers';
import { registerRrcDbIpcHandlers } from '../ipc/rrc-db-handlers';
import { registerSecureSecretsIpcHandlers } from '../ipc/secure-secrets-handlers';
import { destroyRegisteredTcpBridgeSockets, registerTcpBridgeIpcHandlers } from '../ipc/tcp-bridge';
import { MeshcoreMqttAdapter } from '../meshcore-mqtt-adapter';
import { MQTTManager } from '../mqtt-manager';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { formatHeadlessAccessUrl, HeadlessConfigError, resolveHeadlessConfig } from './config';
import { BrowserWindow, configureHeadlessApp, configureHeadlessSafeStorage } from './electronShim';
import { headlessIpcRegistry } from './ipcRegistry';
import { createHeadlessWebServer } from './webServer';

declare const __MESH_CLIENT_APP_VERSION__: string | undefined;

const mqttManager = new MQTTManager();
const meshcoreMqttAdapter = new MeshcoreMqttAdapter();

/** Register every handler module that runs headless. Grow this list as modules are ported. */
function registerHeadlessHandlers(window: BrowserWindow): void {
  registerSecureSecretsIpcHandlers({ getDatabase });
  registerAppSettingsIpcHandlers({ getDatabase });
  registerMeshtasticDbIpcHandlers();
  registerMeshcoreDbIpcHandlers();
  registerChatOutboxIpcHandlers();
  registerReticulumDbIpcHandlers({ ipcMain });
  registerRrcDbIpcHandlers({ ipcMain });
  registerEnvironmentTelemetryIpcHandlers({ ipcMain });
  registerTcpBridgeIpcHandlers({
    getMainWindow: () => (window.isDestroyed() ? null : window),
    validateHost: validateHttpHost,
  });
  registerHttpBridgeIpcHandlers({ getMainWindow: () => (window.isDestroyed() ? null : window) });
  registerMqttIpcHandlers({
    mqttManager,
    meshcoreMqttAdapter,
    getMainWindow: () => (window.isDestroyed() ? null : window),
    // TAK is not ported to headless yet.
    getTakServerManager: () => null,
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

  configureHeadlessSafeStorage(config.secretKey);
  if (config.secretKey === null) {
    console.warn(
      '[headless] no MESH_CLIENT_SECRET_KEY_FILE / MESH_CLIENT_SECRET_KEY — saved credentials ' +
        'stay in memory and are lost on restart',
    );
  } else {
    console.debug(`[headless] secret storage key from ${config.secretKeySource ?? 'unknown'}`);
  }

  try {
    initDatabase();
  } catch (err) {
    // Failure point: the DB is never half-migrated — initDatabase refuses an upgrade it cannot
    // confirm and closes the handle. Exit non-zero so the container restarts visibly.
    if (isDatabaseSchemaUpgradeDeclinedError(err)) {
      console.error(
        `[headless] database needs an irreversible schema upgrade; back up ${sanitizeLogMessage(config.dataDir)} ` +
          `and restart with ${MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE_ENV}=1`,
      );
      process.exit(2);
    }
    if (isDatabaseSchemaTooNewError(err)) {
      console.error(
        '[headless] database was written by a newer Mesh Client; run that version or restore a backup',
      );
      process.exit(2);
    }
    throw err;
  }

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
  console.debug(
    `[headless] ${headlessIpcRegistry.invokeChannels().length} IPC channels available; ` +
      `data dir ${sanitizeLogMessage(config.dataDir)}`,
  );
  // log-injection-ok token is generated or operator-supplied config, printed once by design
  console.debug(`[headless] open ${formatHeadlessAccessUrl(config, address.port)}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.debug(`[headless] ${signal} — shutting down`);
    window.destroy();
    destroyRegisteredTcpBridgeSockets('headless shutdown');
    stopHttpBridgePolling();
    mqttManager.disconnect();
    meshcoreMqttAdapter.disconnect();
    void server.close().then(() => {
      // After the server stops accepting invokes, so no handler races the close.
      closeDatabase();
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
