/**
 * Headless server entry point: serves the renderer to a browser and runs ported main-process
 * handlers under plain Node (no Electron). Built by `scripts/build-headless.mjs` with
 * `electron` aliased to `./electronShim`. See docs/development/headless-webui.md.
 */
import fs from 'node:fs';
import path from 'node:path';

// Resolves to the headless shim at bundle time (scripts/build-headless.mjs aliases `electron`).
import { app, type BrowserWindow as ElectronBrowserWindow, ipcMain } from 'electron';

import { WEB_BRIDGE_LINK_CHANGED_EVENT } from '../../shared/webBridgeDataSync';
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
import { registerBeaconIpcHandlers } from '../ipc/beacon-handlers';
import { registerChatContentIpcHandlers } from '../ipc/chat-content-handlers';
import { registerChatOutboxIpcHandlers } from '../ipc/chat-outbox-handlers';
import { registerMeshcoreDbIpcHandlers } from '../ipc/db-meshcore-handlers';
import { registerMeshtasticDbIpcHandlers } from '../ipc/db-meshtastic-handlers';
import { registerEnvironmentTelemetryIpcHandlers } from '../ipc/environment-telemetry-handlers';
import { registerFileDialogIpcHandlers } from '../ipc/file-dialog-handlers';
import { registerFlasherHandlers } from '../ipc/flasher-handlers';
import { registerGeoIpcHandlers } from '../ipc/geo-handlers';
import { registerGpsIpcHandlers } from '../ipc/gps-handlers';
import { registerHttpBridgeIpcHandlers, stopHttpBridgePolling } from '../ipc/http-bridge';
import { createLinkSharing } from '../ipc/linkSharingHost';
import { registerLogIpcHandlers } from '../ipc/log-handlers';
import { sendMeshtasticBackendCaughtUp } from '../ipc/meshtastic-backend-push';
import { registerMqttIpcHandlers } from '../ipc/mqtt-handlers';
import { registerNotificationSoundHandlers } from '../ipc/notification-sound-handlers';
import { registerOfflineMapsIpcHandlers } from '../ipc/offline-maps-handlers';
import { registerReticulumDbIpcHandlers } from '../ipc/reticulum-db-handlers';
import {
  IDLE_RETICULUM_STATUS,
  registerReticulumIpcHandlers,
  wireReticulumSidecarBridge,
} from '../ipc/reticulum-handlers';
import { registerReticulumIdentityIpcHandlers } from '../ipc/reticulum-identity-handlers';
import { registerRrcDbIpcHandlers } from '../ipc/rrc-db-handlers';
import { registerSecureSecretsIpcHandlers } from '../ipc/secure-secrets-handlers';
import { registerServiceAnnouncementIpcHandlers } from '../ipc/service-announcement-handlers';
import { registerTakIpcHandlers } from '../ipc/tak-handlers';
import { destroyRegisteredTcpBridgeSockets, registerTcpBridgeIpcHandlers } from '../ipc/tcp-bridge';
import { registerTranslationHandlers } from '../ipc/translation-handlers';
import { initLogFile, patchMainConsole, setMainWindow } from '../log-service';
import { MeshcoreMqttAdapter } from '../meshcore-mqtt-adapter';
import type { MeshtasticBackendHandle } from '../meshtastic-backend/hostProtocol';
import { startInProcessMeshtasticBackend } from '../meshtastic-backend/inProcessHost';
import { withMeshtasticLinkKeeper } from '../meshtastic-backend/keptLink';
import { mainMeshtasticLinkKeeperDeps } from '../meshtastic-backend/mainLinks';
import { mainMeshtasticBackendPersistDb } from '../meshtastic-backend/mainPersist';
import { createMeshtasticMqttBackground } from '../meshtastic-backend/mqttRecords';
import { createMeshtasticBackendPersist } from '../meshtastic-backend/persist';
import { MQTTManager } from '../mqtt-manager';
import { createMeshTilesProtocolHandler } from '../offline-maps/protocol';
import { createTileCache, type TileCache } from '../offline-maps/tile-cache';
import { ReticulumSidecarManager } from '../reticulum-sidecar-manager';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { createTakServerHost, IDLE_TAK_STATUS, validateTakSettings } from '../tak/tak-server-host';
import { initUpdater } from '../updater';
import { formatHeadlessAccessUrl, HeadlessConfigError, resolveHeadlessConfig } from './config';
import { BrowserWindow, configureHeadlessApp, configureHeadlessSafeStorage } from './electronShim';
import { registerHeadlessAppHandlers } from './headlessAppHandlers';
import { headlessIpcRegistry } from './ipcRegistry';
import { createHeadlessWebServer } from './webServer';

declare const __MESH_CLIENT_APP_VERSION__: string | undefined;

let headlessWindow: BrowserWindow | null = null;
const pushTarget = (): BrowserWindow | null =>
  headlessWindow && !headlessWindow.isDestroyed() ? headlessWindow : null;

const mqttManager = new MQTTManager();
const meshcoreMqttAdapter = new MeshcoreMqttAdapter();
const takServerHost = createTakServerHost({ getMainWindow: pushTarget });

let reticulumSidecarManager: ReticulumSidecarManager | null = null;

/** Same lazy creation as the Electron app (the sidecar binary is spawned on reticulum:start). */
function ensureReticulumSidecarManager(): ReticulumSidecarManager {
  if (!reticulumSidecarManager) {
    reticulumSidecarManager = new ReticulumSidecarManager();
    wireReticulumSidecarBridge(reticulumSidecarManager, pushTarget);
  }
  return reticulumSidecarManager;
}

/**
 * Meshtastic background ingest (in-process): stores TCP chat, nodes, positions and telemetry
 * while no browser tab owns the
 * radio link, then tells the tab that takes the link back to reload. `null` when disabled.
 */
let meshtasticBackend: MeshtasticBackendHandle | null = null;
/** Background-ingest sink (RF and MQTT records) on the server's database. */
const persistMeshtasticBackendRecord = createMeshtasticBackendPersist(
  mainMeshtasticBackendPersistDb(),
);
/** Browser tabs connected right now (bridge sessions). */
let attachedTabs = 0;
/** Map tile cache under the data dir (same layout as the desktop app's userData). */
let tileCache: TileCache | null = null;
/** Stops the translation worker on shutdown (set when handlers register). */
let disposeTranslation: (() => void) | null = null;

function startMeshtasticBackend(): MeshtasticBackendHandle {
  const ingest = startInProcessMeshtasticBackend({
    persist: (record) => {
      persistMeshtasticBackendRecord(record);
    },
    onCaughtUp: (count) => {
      console.debug(`[headless] Meshtastic: ${count} record(s) stored while no tab was attached`);
      sendMeshtasticBackendCaughtUp(pushTarget(), { count });
    },
  });
  // Reconnects TCP / HTTP to the last radio a tab used, e.g. after a server restart.
  return withMeshtasticLinkKeeper(ingest, mainMeshtasticLinkKeeperDeps());
}

/**
 * Shared viewing: tabs join an open radio link (TCP or HTTP) instead of reconnecting it, and every
 * tab follows a connect or a user's disconnect (`ipc/linkSharing.ts`, `shared/webBridgeDataSync.ts`).
 */
const linkSharing = createLinkSharing({
  sessionOf: (event) => {
    const id = (event.sender as { id?: unknown }).id;
    return typeof id === 'number' ? id : null;
  },
  announce: (protocol, change) => {
    pushTarget()?.webContents.send(WEB_BRIDGE_LINK_CHANGED_EVENT, { protocol, ...change });
  },
});

/** Register every handler module that runs headless. Grow this list as modules are ported. */
function registerHeadlessHandlers(window: BrowserWindow): void {
  headlessWindow = window;
  registerHeadlessAppHandlers();
  registerSecureSecretsIpcHandlers({ getDatabase });
  registerAppSettingsIpcHandlers({ getDatabase });
  registerMeshtasticDbIpcHandlers();
  registerMeshcoreDbIpcHandlers();
  registerChatOutboxIpcHandlers();
  registerReticulumDbIpcHandlers({ ipcMain });
  registerRrcDbIpcHandlers({ ipcMain });
  registerEnvironmentTelemetryIpcHandlers({ ipcMain });
  registerTcpBridgeIpcHandlers({
    getMainWindow: pushTarget,
    validateHost: validateHttpHost,
    sharing: linkSharing,
    ...(meshtasticBackend ? { meshtasticTap: meshtasticBackend.taps.tcp } : {}),
  });
  registerHttpBridgeIpcHandlers({
    getMainWindow: pushTarget,
    sharing: linkSharing,
    ...(meshtasticBackend ? { meshtasticTap: meshtasticBackend.taps.http } : {}),
  });
  registerMqttIpcHandlers({
    mqttManager,
    meshcoreMqttAdapter,
    getMainWindow: pushTarget,
    getTakServerManager: () => takServerHost.get(),
    // Every tab auto-connects MQTT on open; keep a matching live connection instead of bouncing it.
    reuseSameConnection: true,
    // MQTT chat / nodes are stored here while no tab is open (the tabs store them otherwise).
    ...(meshtasticBackend
      ? {
          meshtasticBackground: createMeshtasticMqttBackground({
            isRendererPresent: () => attachedTabs > 0,
            persist: (record) => {
              persistMeshtasticBackendRecord(record);
            },
            ...(meshtasticBackend.channelIdentity
              ? { channelIdentity: meshtasticBackend.channelIdentity }
              : {}),
          }),
        }
      : {}),
  });
  registerTakIpcHandlers({
    idleTakStatus: IDLE_TAK_STATUS,
    ensureTakServerManager: () => takServerHost.ensure(),
    getTakServerManager: () => takServerHost.get(),
    validateTakSettings,
  });
  // Server location (OS / IP geolocation), not the viewer's: the server is the station.
  registerGpsIpcHandlers();
  registerServiceAnnouncementIpcHandlers({ ipcMain });
  registerLogIpcHandlers();
  registerChatContentIpcHandlers();
  registerGeoIpcHandlers();
  registerBeaconIpcHandlers();
  registerNotificationSoundHandlers();
  registerFlasherHandlers();
  // Region downloads fill the cache the web server's /tiles route reads.
  registerOfflineMapsIpcHandlers(
    () => pushTarget() as unknown as ElectronBrowserWindow | null,
    () => tileCache,
  );
  disposeTranslation = registerTranslationHandlers({
    getSetting: (key) =>
      (
        getDatabase().prepareOnce('SELECT value FROM app_settings WHERE key = ?').get(key) as
          { value: string } | undefined
      )?.value,
    setSetting: (key, value) => {
      getDatabase()
        .prepareOnce('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)')
        .run(key, value);
    },
    onProgress: (progress) => {
      pushTarget()?.webContents.send('translation:packProgress', progress);
    },
  });
  // Typed against Electron's BrowserWindow (the dialog parent). At runtime `electron` is the shim,
  // whose dialogs ignore the parent and serve the calling browser instead; one cast, here.
  registerFileDialogIpcHandlers({
    getMainWindow: () => pushTarget() as unknown as ElectronBrowserWindow | null,
  });
  // BLE (RNode / LoRa GATT) is not wired headless: the sidecar's btleplug needs host BlueZ.
  registerReticulumIpcHandlers({
    idleStatus: IDLE_RETICULUM_STATUS,
    ensureManager: ensureReticulumSidecarManager,
    getManager: () => reticulumSidecarManager,
    getMainWindow: pushTarget,
  });
  registerReticulumIdentityIpcHandlers({ ipcMain });
  // Reports new releases; container images update by pulling a new image.
  initUpdater(window, { releaseCheckOnly: true });
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
    // dist-headless/.. — resources/reticulum-sidecar/<binary> is resolved under it.
    appPath: path.resolve(__dirname, '..'),
  });
  // Same log file as the desktop app (<data dir>/mesh-client.log), so the Log panel works.
  // console.* still echoes to stdout for `docker logs`.
  patchMainConsole();
  initLogFile();

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

  if (config.meshtasticBackgroundIngest) meshtasticBackend = startMeshtasticBackend();
  tileCache = createTileCache(config.dataDir);
  const server = createHeadlessWebServer({
    registry: headlessIpcRegistry,
    rendererDir: config.rendererDir,
    bridgeScriptFile: config.bridgeScriptFile,
    token: config.token,
    host: config.host,
    port: config.port,
    maxUploadBytes: config.maxUploadBytes,
    maxSessions: config.maxSessions,
    trustProxy: config.trustProxy,
    allowedHosts: config.allowedHosts,
    // The desktop `mesh-tiles:` handler: cached tile, else fetched from the basemap and cached.
    tileHandler: createMeshTilesProtocolHandler({
      cache: tileCache,
      getAppVersion: () => app.getVersion(),
    }),
    onSessionCountChange: (count) => {
      attachedTabs = count;
      meshtasticBackend?.setRendererPresent(count > 0);
    },
  });
  const window = new BrowserWindow(server.broadcast);
  setMainWindow(window as unknown as ElectronBrowserWindow);
  registerHeadlessHandlers(window);
  // Same restore as the Electron app: TAK server / remote relay when saved with auto-start.
  takServerHost.autoStartFromSavedSettings();

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
    meshtasticBackend?.dispose();
    disposeTranslation?.();
    stopHttpBridgePolling();
    mqttManager.disconnect();
    meshcoreMqttAdapter.disconnect();
    takServerHost.get()?.stop();
    takServerHost.get()?.stopRemote();
    void server.close().then(async () => {
      // Stop the Reticulum sidecar (it owns its own files) before closing SQLite. A failed
      // stop is logged, not fatal: the process is exiting and the sidecar is our child.
      try {
        await reticulumSidecarManager?.stop({ forQuit: true });
      } catch (err) {
        console.warn(
          '[headless] reticulum sidecar stop failed:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
      }
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
