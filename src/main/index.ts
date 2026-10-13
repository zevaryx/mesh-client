import { spawn } from 'child_process';
import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  type NativeImage,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  type Session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { APP_ABOUT_TAGLINE } from '../shared/appTagline';
import { docsSitePageUrl } from '../shared/docsSite';
import { findLxmUrlInArgv, isForwardableMeshClientOpenUrl } from '../shared/meshClientDeepLink';
import type { MeshProtocol } from '../shared/meshProtocol';
import {
  formatMeshtasticBluetoothPin,
  parseMeshtasticBluetoothPin,
} from '../shared/meshtasticBluetoothPin';
import {
  bleCoexistenceCoordinator,
  BlePeripheralConflictError,
  type BlePeripheralOwner,
  BleScanBusyError,
  type BleScanOwner,
} from './ble-coexistence-coordinator';
import { formatBluetoothctlSpawnError } from './bluetoothctlSpawnError';
import { ensureCameraAccess, isAllowedCameraPrivacySettingsUrl } from './cameraAccess';
import { showCrashReportDialog } from './crash-report-dialog';
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  isDatabaseSchemaTooNewError,
  isDatabaseSchemaUpgradeDeclinedError,
} from './database';
import { getDbForIpc } from './db-ipc-lifecycle';
import { formatDatabaseSchemaTooNewMessage, showFatalStartupError } from './fatal-startup-dialog';
import {
  type GattDiscoveredDevice,
  type GattSessionProfile,
  gattSidecarProxy,
} from './gatt-sidecar-proxy';
import { writeGattToRadio } from './gattIpcWrite';
import { isHarmlessSocketOptionError } from './harmlessSocketOptionError';
import { validateHttpHost } from './httpHostValidation';
import { registerAppSettingsIpcHandlers } from './ipc/app-settings-handlers';
import { registerBeaconIpcHandlers } from './ipc/beacon-handlers';
import { registerChatContentIpcHandlers } from './ipc/chat-content-handlers';
import { registerChatOutboxIpcHandlers } from './ipc/chat-outbox-handlers';
import { registerMeshcoreDbIpcHandlers } from './ipc/db-meshcore-handlers';
import {
  insertMeshtasticMessageRow,
  insertPositionHistoryRow,
  registerMeshtasticDbIpcHandlers,
  upsertMeshtasticNodeRow,
} from './ipc/db-meshtastic-handlers';
import { registerEnvironmentTelemetryIpcHandlers } from './ipc/environment-telemetry-handlers';
import { registerFileDialogIpcHandlers } from './ipc/file-dialog-handlers';
import { registerFlasherHandlers } from './ipc/flasher-handlers';
import { registerGattPairingIpcHandlers } from './ipc/gatt-pairing-handlers';
import { registerGeoIpcHandlers } from './ipc/geo-handlers';
import { registerGpsIpcHandlers } from './ipc/gps-handlers';
import { connectMeshtasticHttpFromMain, registerHttpBridgeIpcHandlers } from './ipc/http-bridge';
import { registerLogIpcHandlers } from './ipc/log-handlers';
import { registerMqttIpcHandlers } from './ipc/mqtt-handlers';
import { registerNotificationSoundHandlers } from './ipc/notification-sound-handlers';
import { registerOfflineMapsIpcHandlers } from './ipc/offline-maps-handlers';
import { registerReticulumDbIpcHandlers } from './ipc/reticulum-db-handlers';
import {
  IDLE_RETICULUM_STATUS,
  registerReticulumIpcHandlers,
  wireReticulumSidecarBridge,
} from './ipc/reticulum-handlers';
import { registerReticulumIdentityIpcHandlers } from './ipc/reticulum-identity-handlers';
import { registerRrcDbIpcHandlers } from './ipc/rrc-db-handlers';
import { registerSecureSecretsIpcHandlers } from './ipc/secure-secrets-handlers';
import { registerServiceAnnouncementIpcHandlers } from './ipc/service-announcement-handlers';
import { registerTakIpcHandlers } from './ipc/tak-handlers';
import {
  connectMeshtasticTcpFromMain,
  destroyRegisteredTcpBridgeSockets,
  registerTcpBridgeIpcHandlers,
} from './ipc/tcp-bridge';
import { registerTranslationHandlers } from './ipc/translation-handlers';
import {
  flushLogBeforeQuit,
  formatRuntimeLogTag,
  forwardRendererConsoleMessage,
  initLogFile,
  patchMainConsole,
  sanitizeLogMessage,
  setMainWindow,
} from './log-service';
import { MeshcoreMqttAdapter } from './meshcore-mqtt-adapter';
import { loadDesktopMeshtasticHost } from './meshtastic-backend/desktopHostLoader';
import { ensureMicrophoneAccess, isAllowedMicrophonePrivacySettingsUrl } from './microphoneAccess';
import { MQTTManager } from './mqtt-manager';
import { createMeshTilesProtocolHandler } from './offline-maps/protocol';
import { createTileCache, type TileCache } from './offline-maps/tile-cache';
import { PermissionDecisionLogger } from './permissionDecisionLog';
import { createRendererHeartbeatWatchdog } from './rendererHeartbeatWatchdog';
import { resolveRendererLoadUrl } from './resolveRendererLoadUrl';
import { assertReticulumAttachmentPathJailed } from './reticulum-attachment-path';
import { ReticulumSidecarManager } from './reticulum-sidecar-manager';
import { errorMessageText } from './sanitize-log-message';
import { createTakServerHost, IDLE_TAK_STATUS, validateTakSettings } from './tak/tak-server-host';
import type { TakServerManager } from './tak-server-manager';
import { updateUnreadAppBadge } from './unreadAppBadge';
import { getCheckNowFromMenu, initUpdater } from './updater';
import { assertIpcSender, validateIpcSender } from './validate-ipc-sender';
import { buildWindowsAboutDocumentHtml } from './windows-about-html';

// Route main-process console through log file + Log panel (must run before other code logs)
patchMainConsole();

// Capture native minidumps locally (no upload). Failure point: crashReporter unavailable in some test harnesses.
try {
  crashReporter.start({ uploadToServer: false });
  console.debug('[main] crashReporter started (uploadToServer: false)');
} catch (e: unknown) {
  console.warn('[main] crashReporter.start failed:', sanitizeLogMessage(errorMessageText(e)));
}

// Custom scheme for offline map tiles (must register before app.whenReady).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mesh-tiles',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Linux: SIGSEGV in Electron GPU process on some Wayland / driver stacks (electron#41980).
// Must run before app.whenReady(). CLI flags --disable-gpu also work; env avoids wrapper scripts.
if (process.platform === 'linux' && process.env.MESH_CLIENT_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

// ─── Single instance lock ───────────────────────────────────────────
// Must run before app.whenReady() to take effect. Second instance will
// focus the existing window and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.meshclient.app');
}

/** Trusted Help menu / About credits URLs (static, not user-controlled). */
const HELP_URL_WEBSITE = 'https://coloradomesh.org/';
const HELP_URL_GITHUB = 'https://github.com/Colorado-Mesh/mesh-client';
const HELP_URL_DISCORD = 'https://discord.com/invite/McChKR5NpS';

// ─── Window state persistence ───────────────────────────────────────
interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_WINDOW_STATE: WindowState = { x: 0, y: 0, width: 1200, height: 800 };

function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(WINDOW_STATE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf-8')) as unknown;
      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as Record<string, unknown>).x === 'number' &&
        typeof (raw as Record<string, unknown>).y === 'number' &&
        typeof (raw as Record<string, unknown>).width === 'number' &&
        typeof (raw as Record<string, unknown>).height === 'number'
      ) {
        return raw as WindowState;
      }
    }
  } catch {
    // catch-no-log-ok: non-critical; fall through to defaults
  }
  return DEFAULT_WINDOW_STATE;
}

function saveWindowState(state: WindowState): void {
  try {
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify(state), 'utf-8');
  } catch {
    // catch-no-log-ok: non-critical persistence failure
  }
}

function isWindowStateOnScreen(state: WindowState): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const { x, y, width, height } = d.workArea;
    return (
      state.x < x + width &&
      state.x + state.width > x &&
      state.y < y + height &&
      state.y + state.height > y
    );
  });
}

const mqttManager = new MQTTManager();
const meshcoreMqttAdapter = new MeshcoreMqttAdapter();
const takServerHost = createTakServerHost({ getMainWindow: () => mainWindow });
const ensureTakServerManager = (): Promise<TakServerManager> => takServerHost.ensure();

/** MAC address format: XX:XX:XX:XX:XX:XX */
function isMacAddress(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 6) return false;
  return parts.every((part) => /^[0-9A-Fa-f]{2}$/.test(part));
}

let reticulumSidecarManager: ReticulumSidecarManager | null = null;

function ensureReticulumSidecarManager(): ReticulumSidecarManager {
  if (!reticulumSidecarManager) {
    reticulumSidecarManager = new ReticulumSidecarManager();
    wireReticulumSidecarBridge(reticulumSidecarManager, () => mainWindow);
  }
  return reticulumSidecarManager;
}

gattSidecarProxy.setEnsureSidecar(async () => {
  if (isQuitting) {
    throw new Error('gatt sidecar ensure blocked: app is quitting');
  }
  const mgr = ensureReticulumSidecarManager();
  const port = await mgr.ensureForBle();
  gattSidecarProxy.setPort(port, mgr.getAuthTokenForLocalProxy());
  return port;
});
bleCoexistenceCoordinator.setGattProxy(gattSidecarProxy);

// When the shared sidecar process exits (Stop / Quit / crash), clear GATT's
// cached port so LoRa reconnect does not hammer a dead HTTP port.
{
  const mgr = ensureReticulumSidecarManager();
  mgr.on('status', (status: { running: boolean; processRunning?: boolean; port: number }) => {
    if (!(status.processRunning ?? status.running)) {
      gattSidecarProxy.invalidateAfterSidecarExit();
    } else if (status.port > 0) {
      gattSidecarProxy.setPort(status.port, mgr.getAuthTokenForLocalProxy());
    }
  });
}

/** Max bytes per BLE write IPC (DoS guard). */
const GATT_TO_RADIO_MAX_BYTES = 512;

function isAnyMqttConnected(): boolean {
  return mqttManager.getStatus() === 'connected' || meshcoreMqttAdapter.getStatus() === 'connected';
}

let mainWindow: BrowserWindow | null = null;
const rendererHeartbeatWatchdog = createRendererHeartbeatWatchdog();
let offlineTileCache: TileCache | null = null;
/** Win32 About: native About panel can hard-crash; use a small HTML BrowserWindow instead (#406). */
let windowsAboutWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Retain tray context menu so macOS menu bridge does not see a freed model (avoids console warning / crashes). */
let trayContextMenu: Menu | null = null;
/** Retain application menu on macOS so the menu bridge has a stable model. */
let appMenu: Menu | null = null;
let isConnected = false;
let isQuitting = false;
let shutdownDone = false;
/** Shared quit/relaunch single-flight (app:quit, app:relaunch). */
let quitMainInFlight = false;
/** Last tray unread count for Dock/taskbar badge. */
let lastTrayUnreadCount = 0;

/**
 * Graceful main-process exit used by app:quit / app:relaunch.
 * Mirrors historical app:quit cleanup; optional relaunch schedules a new instance before exit.
 */
async function quitMainProcess(opts: { relaunch?: boolean } = {}): Promise<void> {
  if (quitMainInFlight) return;
  quitMainInFlight = true;
  isQuitting = true;
  isConnected = false;
  gattSidecarProxy.setQuitting();
  // Drop exclusive hold locally without HTTP so quit never ensurePort()-respawns sidecar.
  gattSidecarProxy.setRnodeBondRecoveryExclusive(false);
  try {
    try {
      await gattSidecarProxy.disconnectAll();
    } catch (err) {
      console.error(
        '[main] quitMainProcess GATT disconnectAll failed:',
        sanitizeLogMessage(errorMessageText(err)),
      );
    }

    await shutdownAppResources();

    destroyRegisteredTcpBridgeSockets('quitMainProcess TCP socket destroy (ignored)');
    meshtasticDesktopBackend?.dispose();
    stopPowerSaveBlocker();

    tray?.destroy();
    tray = null;
    if (opts.relaunch) {
      app.relaunch();
    }
    app.exit(0);
  } catch (err) {
    console.error('[main] quitMainProcess failed:', sanitizeLogMessage(errorMessageText(err)));
    if (opts.relaunch) {
      try {
        app.relaunch();
      } catch {
        // catch-no-log-ok relaunch already best-effort in failure path before quit
      }
    }
    app.quit();
  }
}

/** Stop network services, flush logs, and close SQLite before process exit. */
async function shutdownAppResources(): Promise<void> {
  if (shutdownDone) return;
  isQuitting = true;
  try {
    takServerHost.get()?.stop();
    takServerHost.get()?.stopRemote();
  } catch (err) {
    console.debug(
      '[main] TAK server stop during shutdown (ignored):',
      err instanceof Error ? err.message : err,
    ); // log-injection-ok internal cleanup
  }
  try {
    await reticulumSidecarManager?.stop({ forQuit: true });
  } catch (err) {
    console.debug(
      '[main] Reticulum sidecar stop during shutdown (ignored):',
      err instanceof Error ? err.message : err,
    ); // log-injection-ok internal cleanup
  }
  try {
    mqttManager.disconnect();
    meshcoreMqttAdapter.disconnect();
  } catch (err) {
    console.debug(
      '[main] MQTT disconnect during shutdown (ignored):',
      err instanceof Error ? err.message : err,
    ); // log-injection-ok internal library error during cleanup
  }
  await flushLogBeforeQuit();
  closeDatabase();
  shutdownDone = true;
}

/** powerSaveBlocker ID while a device is connected; null when not active. */
let powerSaveBlockerId: number | null = null;

// ─── Windows taskbar overlay badge icon ────────────────────────────
/** Build a minimal 16×16 RGBA PNG buffer for use as the Windows taskbar overlay icon. */
function buildBadgePng(): Buffer {
  const W = 16,
    H = 16;
  // CRC32 (used by PNG chunk format)
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c;
  }
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
  }
  // IHDR: 16×16, 8-bit RGBA
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Raw scanlines: filter byte (0) + RGBA per pixel — red with circular alpha mask
  const rows: Buffer[] = [];
  const cx = (W - 1) / 2,
    cy = (H - 1) / 2,
    r2 = (W / 2) * (W / 2);
  for (let y = 0; y < H; y++) {
    const row = Buffer.allocUnsafe(1 + W * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const off = 1 + x * 4;
      const inside = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2;
      row[off] = 220; // R
      row[off + 1] = 53; // G
      row[off + 2] = 69; // B
      row[off + 3] = inside ? 255 : 0; // A
    }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pending Serial callback
let pendingSerialCallback: ((portId: string) => void) | null = null;
let pendingSerialSelectionTimer: ReturnType<typeof setTimeout> | null = null;
const SERIAL_PORT_SELECTION_TIMEOUT_MS = 120_000;

function clearPendingSerialSelectionTimer(): void {
  if (pendingSerialSelectionTimer) {
    clearTimeout(pendingSerialSelectionTimer);
    pendingSerialSelectionTimer = null;
  }
}
// Last serial port discovery set: only allow selection IPC to resolve with ids from this set
// (empty string always allowed = cancel). Prevents arbitrary id injection from a compromised renderer.
let lastSerialPortIds = new Set<string>();

// Bluetooth pairing state (Linux only — setBluetoothPairingHandler)
// Electron's Response type requires confirmed: boolean, pin is optional
interface BluetoothPairingResponse {
  confirmed: boolean;
  pin?: string;
}
let pendingPairingCallback: ((response: BluetoothPairingResponse) => void) | null = null;
let pendingPairingRetryCount = 0;
/** Which BLE stack is connecting; MeshCore must not auto-use Meshtastic default PIN on first pairing. */
let blePairingSessionKind: MeshProtocol = 'meshtastic';

// Noble BLE pairing state (Win32 — no Chromium pairing handler available)

let hasInstalledOsmReferrerHook = false;
const OSM_HTTP_REFERRER = 'https://meshtastic-client.app/';

// ─── Global error handlers (prevent silent crashes in packaged app) ──
process.on('uncaughtException', (error) => {
  if (isHarmlessSocketOptionError(error)) {
    console.warn(
      '[main] Ignoring best-effort socket QoS failure:',
      sanitizeLogMessage(error.message),
    );
    return;
  }
  console.error(
    '[main] Uncaught exception:',
    sanitizeLogMessage(error?.stack ?? error?.message ?? String(error)),
  );
  void flushLogBeforeQuit();
  // Offer a consent-gated crash report. The dialog throttles itself (60s) and
  // fails silently if a native dialog is unavailable (early startup / after quit).
  showCrashReportDialog({ source: 'uncaughtException', error });
});

process.on('unhandledRejection', (reason) => {
  if (isHarmlessSocketOptionError(reason)) {
    console.warn(
      '[main] Ignoring best-effort socket QoS failure:',
      sanitizeLogMessage(errorMessageText(reason)),
    );
    return;
  }
  console.error(
    '[main] Unhandled rejection:',
    sanitizeLogMessage(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)),
  );
  void flushLogBeforeQuit();
  // Normalize to an Error so the report includes a stack trace where possible.
  const error = reason instanceof Error ? reason : new Error(String(reason));
  showCrashReportDialog({ source: 'unhandledRejection', error });
});

// ─── Bluetooth pairing handler (Linux only) ──────────────────────────
// Note: Bluetooth pairing for Web Bluetooth is handled via session.setBluetoothPairingHandler()
// which is set up after mainWindow creation. See the setup below near select-bluetooth-device.

// ─── IPC validation helpers (main process boundary) ───────────────────
// db:* validators live in ipc/db-ipc-validation.ts.

// Enable Web Serial at the process level (LoRa BLE uses sidecar btleplug, not Web Bluetooth).
app.commandLine.appendSwitch('enable-blink-features', 'Serial');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-experimental-web-platform-features');
}

// ─── Icon Path Helper ──────────────────────────────────────────────
/**
 * Resolves the correct icon file based on the platform and package status.
 */
function getAppIconPath() {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'colorado-mesh.ico')
      : path.join(__dirname, '../../resources/icons/win/colorado-mesh.ico');
  }
  if (process.platform === 'darwin') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'icon.icns')
      : path.join(__dirname, '../../resources/icons/mac/icon.icns');
  }
  // Linux
  return app.isPackaged
    ? path.join(process.resourcesPath, '256x256.png')
    : path.join(__dirname, '../../resources/icons/linux/256x256.png');
}

function buildTrayIcon(hasUnread: boolean): Electron.NativeImage {
  let base = nativeImage.createEmpty();
  try {
    if (process.platform === 'darwin') {
      const trayIconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'macos-menubar-icon-Template.png')
        : path.join(
            __dirname,
            '../../resources/icons/mac/macos-menubar-icon-Template/macos-menubar-icon-Template.png',
          );
      base = nativeImage.createFromPath(trayIconPath);
      base.setTemplateImage(true);
    } else {
      const trayIconPath = app.isPackaged
        ? path.join(process.resourcesPath, '256x256.png')
        : path.join(__dirname, '../../resources/icons/linux/256x256.png');
      base = nativeImage.createFromPath(trayIconPath).resize({ width: 22, height: 22 });
    }
  } catch (e) {
    console.error('[main] tray icon load failed:', sanitizeLogMessage(errorMessageText(e)));
  }

  if (!hasUnread) return base;

  try {
    // Overlay the red dot for unread messages
    // Use getSize() after resize so the dot scales correctly with retina/2x template images.
    // toBitmap() on macOS template images may return a buffer that is not exactly
    // width*height*4 bytes, so we allocate the expected size and copy what we have.
    const { width: actualW, height: actualH } = base.getSize();
    const expectedSize = actualW * actualH * 4;
    const rawBitmap = base.toBitmap();
    const bitmap = Buffer.alloc(expectedSize, 0);
    rawBitmap.copy(bitmap, 0, 0, Math.min(rawBitmap.length, expectedSize));

    const dotR = Math.max(2, Math.round(actualW / 8));
    const dotCx = actualW - dotR - 1;
    const dotCy = dotR + 1;

    for (let py = 0; py < actualH; py++) {
      for (let px = 0; px < actualW; px++) {
        const dx = px - dotCx;
        const dy = py - dotCy;
        if (dx * dx + dy * dy <= dotR * dotR) {
          const idx = (py * actualW + px) * 4;
          bitmap[idx] = 239; // R
          bitmap[idx + 1] = 68; // G
          bitmap[idx + 2] = 68; // B
          bitmap[idx + 3] = 255; // A
        }
      }
    }

    return nativeImage.createFromBitmap(bitmap, { width: actualW, height: actualH });
  } catch (e) {
    console.error(
      '[main] tray unread icon overlay failed:',
      sanitizeLogMessage(errorMessageText(e)),
    );
    return base;
  }
}

function setupTray(window: BrowserWindow) {
  try {
    tray = new Tray(buildTrayIcon(false));
    tray.setToolTip('Mesh-Client');
    tray.on('click', () => {
      window.show();
      window.focus();
    });
    trayContextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Mesh-Client',
        click: () => {
          window.show();
          window.focus();
        },
      },
      { type: 'separator' },
      {
        label: `About ${app.name}`,
        click: () => {
          showAboutDialog();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          mqttManager.disconnect();
          meshcoreMqttAdapter.disconnect();
          isConnected = false;
          mainWindow?.destroy();
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(trayContextMenu);
  } catch (e) {
    console.error('[main] tray setup failed:', sanitizeLogMessage(errorMessageText(e)));
    tray = null;
    trayContextMenu = null;
  }
}

function applyAboutPanelOptions(): void {
  // GitHub #406: On Windows 11, Electron’s native About path (`setAboutPanelOptions` / `showAboutPanel`)
  // can fault the process with no JS exception (upstream Electron + Win32 shell bug). We skip
  // registering the panel on win32 because `showAboutDialog` uses the HTML fallback instead.
  if (process.platform === 'win32') {
    return;
  }
  const version = app.getVersion();
  const credits = [
    `Version ${version}`,
    '',
    APP_ABOUT_TAGLINE,
    '',
    `Reticulum support uses a bundled AGPL-3.0-or-later sidecar (mesh-client-reticulum). See ${docsSitePageUrl('reticulum')} and ${docsSitePageUrl('license')}.`,
    '',
    'Reticulum stack inspiration: Ratspeak (https://github.com/ratspeak/Ratspeak)',
    '',
    'License: GPL-3.0-or-later (application code). AGPL-3.0-or-later applies to the bundled Reticulum sidecar binary.',
    'Author: Colorado Mesh',
    '',
    `Website:  ${HELP_URL_WEBSITE}`,
    `GitHub:   ${HELP_URL_GITHUB}`,
    `Discord:  ${HELP_URL_DISCORD}`,
  ].join('\n');

  const iconCandidate = path.join(process.resourcesPath, '256x256.png');
  const iconPath = fs.existsSync(iconCandidate) ? iconCandidate : undefined;

  try {
    if (process.platform === 'linux') {
      app.setAboutPanelOptions({
        applicationName: app.name,
        applicationVersion: version,
        copyright: 'Copyright © Colorado Mesh',
        credits,
        authors: ['Colorado Mesh'],
        website: HELP_URL_WEBSITE,
        ...(iconPath ? { iconPath } : {}),
      });
    } else {
      app.setAboutPanelOptions({
        applicationName: app.name,
        applicationVersion: version,
        copyright: 'Copyright © Colorado Mesh',
        credits,
        ...(iconPath ? { iconPath } : {}),
      });
    }
  } catch (e: unknown) {
    console.warn('[main] setAboutPanelOptions failed:', sanitizeLogMessage(errorMessageText(e)));
  }
}

function openHelpExternalLink(rawUrl: string): void {
  const target = parseHttpOrHttpsUrl(rawUrl);
  if (!target) {
    console.warn('[main] help link: invalid url', sanitizeLogMessage(rawUrl.slice(0, 200)));
    return;
  }
  console.debug(`[main] help link: openExternal url=${sanitizeLogMessage(target.toString())}`);
  void shell.openExternal(target.toString() /* parseHttpOrHttpsUrl */).catch((e: unknown) => {
    console.error('[main] help link: openExternal failed', sanitizeLogMessage(errorMessageText(e)));
  });
}

function buildHelpMenuExternalLinkItems(): (
  { type: 'separator' } | { label: string; click: () => void }
)[] {
  return [
    { type: 'separator' as const },
    {
      label: 'Colorado Mesh Website',
      click: () => {
        openHelpExternalLink(HELP_URL_WEBSITE);
      },
    },
    {
      label: 'GitHub Repository',
      click: () => {
        openHelpExternalLink(HELP_URL_GITHUB);
      },
    },
    {
      label: 'Discord',
      click: () => {
        openHelpExternalLink(HELP_URL_DISCORD);
      },
    },
  ];
}

/**
 * GitHub #406: Windows 11 can hard-exit the app inside Electron’s native About APIs (`showAboutPanel`
 * and related Win32 shell UI) before any try/catch — upstream Electron/Win32 bug. This replaces
 * that path with a sandboxed data-URL window; https navigations are routed to `openHelpExternalLink`.
 */
function showWindowsAboutFallbackWindow(): void {
  try {
    if (windowsAboutWindow && !windowsAboutWindow.isDestroyed()) {
      windowsAboutWindow.show();
      windowsAboutWindow.focus();
      return;
    }

    const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
    const html = buildWindowsAboutDocumentHtml(app.name, app.getVersion());
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

    console.debug(
      '[main] about: opening Windows HTML fallback',
      sanitizeLogMessage(`parent=${Boolean(parent)}`),
    );

    const win = new BrowserWindow({
      width: 440,
      height: 480,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      parent: parent ?? undefined,
      modal: Boolean(parent),
      title: `About ${app.name}`,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    windowsAboutWindow = win;

    win.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('data:') || url === 'about:blank') return;
      const t = parseHttpOrHttpsUrl(url);
      if (t) {
        event.preventDefault();
        openHelpExternalLink(t.toString());
        return;
      }
      event.preventDefault();
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      // deny unexpected child windows (check:electron-security scans this block)
      const t = parseHttpOrHttpsUrl(url);
      if (t) {
        openHelpExternalLink(t.toString());
      }
      return { action: 'deny' };
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    win.on('closed', () => {
      if (windowsAboutWindow === win) windowsAboutWindow = null;
    });

    void win.loadURL(dataUrl).catch((e: unknown) => {
      console.error(
        '[main] about: Windows HTML load failed',
        sanitizeLogMessage(errorMessageText(e)),
      );
      if (!win.isDestroyed()) win.destroy();
      if (windowsAboutWindow === win) windowsAboutWindow = null;
    });
  } catch (e: unknown) {
    console.error(
      '[main] about: Windows HTML fallback failed',
      sanitizeLogMessage(errorMessageText(e)),
    );
    try {
      dialog.showErrorBox(
        `About ${app.name}`,
        `${app.name}\nVersion ${app.getVersion()}\n\nCould not open the About window.`,
      );
    } catch {
      // catch-no-log-ok dialog unavailable; error already logged above
    }
  }
}

function showAboutDialog(): void {
  const appName = app.name;
  const version = app.getVersion();

  try {
    console.debug(`[main] about dialog: opening app=${sanitizeLogMessage(appName)}`);
    // GitHub #406: same Electron/Win32 native About bug as above — do not call `showAboutPanel` here.
    if (process.platform === 'win32') {
      showWindowsAboutFallbackWindow();
      return;
    }
    app.showAboutPanel();
  } catch (e) {
    console.error('[main] about dialog failed', sanitizeLogMessage(errorMessageText(e)));

    try {
      dialog.showErrorBox(`About ${appName}`, `${appName}\nVersion ${version}`);
    } catch (fallbackError) {
      console.error(
        '[main] about dialog fallback failed',
        sanitizeLogMessage(errorMessageText(fallbackError)),
      );
    }
  }
}

/**
 * Application menu: macOS uses the app-name menu (About, updates, Hide, Quit), editMenu,
 * and Help (project links). Windows/Linux get File (Quit), Edit, and Help (About, updates, links)
 * so About is reachable from the menu bar and standard edit shortcuts work.
 */
function setupAppMenu() {
  applyAboutPanelOptions();

  if (process.platform === 'darwin') {
    appMenu = Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          {
            label: `About ${app.name}`,
            click: () => {
              showAboutDialog();
            },
          },
          { type: 'separator' as const },
          {
            label: 'Check for Updates\u2026',
            click: () => getCheckNowFromMenu()?.(),
          },
          { type: 'separator' as const },
          {
            label: 'Hide',
            accelerator: 'Command+H',
            click: () => {
              app.hide();
            },
          },
          { type: 'separator' as const },
          {
            label: 'Quit',
            accelerator: 'Command+Q',
            click: () => {
              isQuitting = true;
              mqttManager.disconnect();
              meshcoreMqttAdapter.disconnect();
              app.quit();
            },
          },
        ],
      },
      { role: 'editMenu' as const },
      {
        label: 'Help',
        submenu: buildHelpMenuExternalLinkItems().filter(
          (item): item is { label: string; click: () => void } => !('type' in item),
        ),
      },
    ]);
  } else {
    appMenu = Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          {
            label: 'Quit',
            accelerator: 'Ctrl+Q',
            click: () => {
              isQuitting = true;
              mqttManager.disconnect();
              meshcoreMqttAdapter.disconnect();
              app.quit();
            },
          },
        ],
      },
      { role: 'editMenu' as const },
      {
        label: 'Help',
        submenu: [
          {
            label: `About ${app.name}`,
            click: () => {
              showAboutDialog();
            },
          },
          { type: 'separator' as const },
          {
            label: 'Check for Updates\u2026',
            click: () => getCheckNowFromMenu()?.(),
          },
          ...buildHelpMenuExternalLinkItems(),
        ],
      },
    ]);
  }
  Menu.setApplicationMenu(appMenu);
}

/**
 * Win/Linux: Hunspell only runs after languages are set (see Electron spellchecker tutorial).
 * macOS: native checker; still ensure the session flag is on. Re-run after load in case
 * dictionary lists populate asynchronously.
 */
function configureRendererSpellcheck(sess: Session): void {
  try {
    sess.setSpellCheckerEnabled(true);

    const available = sess.availableSpellCheckerLanguages;
    if (!Array.isArray(available) || available.length === 0) {
      console.warn('[main] spellcheck: no dictionaries listed yet (retry after load)');
      return;
    }
    // Normalize codes for matching (both sides to hyphens) but pass original
    // codes to setSpellCheckerLanguages.
    const normAvailable = available.map((c) => c.replace(/_/g, '-'));
    const loc = app.getLocale().replace(/_/g, '-');
    const picked: string[] = [];

    const exactIdx = normAvailable.indexOf(loc);
    if (exactIdx !== -1) {
      picked.push(available[exactIdx]);
    }
    const region = loc.split(/[-_]/)[0];
    if (region) {
      for (let i = 0; i < available.length; i++) {
        const normCode = normAvailable[i];
        if (
          (normCode === region || normCode.startsWith(`${region}-`)) &&
          !picked.includes(available[i])
        ) {
          picked.push(available[i]);
        }
      }
    }
    if (picked.length === 0) {
      const enIdx = normAvailable.indexOf('en-US');
      if (enIdx !== -1) {
        picked.push(available[enIdx]);
      }
    }
    if (picked.length === 0) {
      picked.push(available[0]);
    }

    sess.setSpellCheckerLanguages(picked.slice(0, 3));
  } catch (e) {
    console.warn('[main] configureRendererSpellcheck', sanitizeLogMessage(errorMessageText(e)));
  }
}

function retryRendererSpellcheck(sess: Session): void {
  configureRendererSpellcheck(sess);
  for (const delayMs of [250, 1000, 5000]) {
    setTimeout(() => {
      configureRendererSpellcheck(sess);
    }, delayMs);
  }
}

interface SpellcheckReplacePayload {
  suggestion: string;
  misspelledWord: string;
  selectionStartOffset?: number;
}

/** Chromium replaceMisspelling does not update React-controlled fields; renderer syncs via IPC. */
function applySpellcheckSuggestion(
  win: BrowserWindow,
  suggestion: string,
  misspelledWord: string,
  selectionStartOffset?: number,
): void {
  const wc = win.webContents;
  wc.replaceMisspelling(suggestion);
  if (!misspelledWord) return;
  const payload: SpellcheckReplacePayload = {
    suggestion,
    misspelledWord,
    ...(selectionStartOffset != null ? { selectionStartOffset } : {}),
  };
  wc.send('spellcheck:replace', payload);
}

function parseHttpOrHttpsUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed;
  } catch {
    // catch-no-log-ok — invalid URL strings should be ignored safely
  }
  return null;
}

function openExternalHttpOrHttpsIfExternal(currentUrl: string, targetUrl: string): boolean {
  const target = parseHttpOrHttpsUrl(targetUrl);
  if (!target) return false;

  // Keep same-origin navigations inside Electron; only external websites are routed to the system browser.
  const current = parseHttpOrHttpsUrl(currentUrl);
  if (current?.origin === target.origin) return false;

  shell.openExternal(target.toString()).catch((e: unknown) => {
    console.error('[main] external link open failed', sanitizeLogMessage(errorMessageText(e)));
  });
  return true;
}

function createWindow() {
  rendererHeartbeatWatchdog.expectVisibleHeartbeat();
  const savedState = loadWindowState();
  const bounds = isWindowStateOnScreen(savedState) ? savedState : DEFAULT_WINDOW_STATE;
  const center = bounds === DEFAULT_WINDOW_STATE;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: center ? undefined : bounds.x,
    y: center ? undefined : bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Mesh Client',
    // Use the helper to select .ico, .icns, or .png automatically
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      webviewTag: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Inline misspelling marks and context-menu suggestions (all platforms). macOS app menu
      // stays minimal (no role-based Edit menu) to reduce WeakPtr menu-bridge noise.
      spellcheck: true,
      // Security note: experimentalFeatures enables the Web Bluetooth and Web Serial APIs
      // required for direct device communication. These APIs are permission-gated via
      // setPermissionCheckHandler/setPermissionRequestHandler (serial, geolocation, media, notifications).
      experimentalFeatures: true,
    },
  });
  mainWindow = win;

  let windowStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveWindowState = () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(() => {
      if (!win.isMinimized() && !win.isMaximized()) {
        saveWindowState(win.getBounds());
      }
    }, 300);
  };
  win.on('move', scheduleSaveWindowState);
  win.on('resize', scheduleSaveWindowState);

  // External link handling: route http/https websites to the system browser.
  // Failure point: malicious URL schemes attempting protocol-handler abuse.
  // Guardrail: only pass validated http:/https: URLs to `shell.openExternal()`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url !== 'string') return { action: 'deny' };
    const currentUrl = win.webContents.getURL();
    const openedExternal = openExternalHttpOrHttpsIfExternal(currentUrl, url);
    return openedExternal ? { action: 'deny' } : { action: 'allow' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    const openedExternal = openExternalHttpOrHttpsIfExternal(currentUrl, url);
    if (openedExternal) event.preventDefault();
  });

  configureRendererSpellcheck(win.webContents.session);
  win.webContents.once('did-finish-load', () => {
    retryRendererSpellcheck(win.webContents.session);
    flushPendingOpenUrl();
  });

  // Electron does not show any context menu by default — we must call menu.popup().
  // Spell suggestions only exist on this event (see spellchecker tutorial); always show
  // cut/copy/paste for text fields so right-click works even with no misspelling.
  win.webContents.on('context-menu', (event, params) => {
    const isTextField =
      params.isEditable ||
      params.formControlType === 'text-area' ||
      params.formControlType === 'input-text' ||
      params.formControlType === 'input-search';
    if (!isTextField) return;

    event.preventDefault();
    const ef = params.editFlags;
    const suggestions = params.dictionarySuggestions ?? [];
    const misspelledWord = params.misspelledWord ?? '';

    const menu = new Menu();
    if (suggestions.length > 0) {
      for (const suggestion of suggestions) {
        menu.append(
          new MenuItem({
            label: suggestion,
            click: () => {
              applySpellcheckSuggestion(
                win,
                suggestion,
                misspelledWord,
                params.selectionStartOffset,
              );
            },
          }),
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (misspelledWord) {
      menu.append(
        new MenuItem({
          label: 'Add to dictionary',
          click: () => {
            void win.webContents.session.addWordToSpellCheckerDictionary(misspelledWord);
          },
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }
    menu.append(new MenuItem({ role: 'cut', enabled: ef.canCut }));
    menu.append(new MenuItem({ role: 'copy', enabled: ef.canCopy }));
    menu.append(new MenuItem({ role: 'paste', enabled: ef.canPaste }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ role: 'selectAll', enabled: ef.canSelectAll }));

    menu.popup({
      window: win,
      x: params.x,
      y: params.y,
      ...(params.frame ? { frame: params.frame } : {}),
    });
  });

  // ─── Web Serial: Port Selection ────────────────────────────────────
  // Electron requires this handler for navigator.serial.requestPort()
  // to work. Without it, the Web Serial API throws.
  mainWindow.webContents.session.on(
    'select-serial-port',
    (event, portList, _webContents, callback) => {
      event.preventDefault();

      // Warn if a previous callback is being replaced (renderer re-triggered before resolving)
      if (pendingSerialCallback) {
        console.warn('[IPC] select-serial-port: replacing stale pendingSerialCallback');
      }

      // Store callback so we can resolve it when the user picks a port
      pendingSerialCallback = callback;
      clearPendingSerialSelectionTimer();

      console.debug(`[IPC] select-serial-port: discovered ${portList.length} port(s)`);

      // Auto-cancel if the picker is left open too long (flashing can take longer than 60s)
      pendingSerialSelectionTimer = setTimeout(() => {
        if (pendingSerialCallback === callback) {
          console.warn(
            '[IPC] Serial port selection callback stale after timeout — auto-cancelling',
          );
          pendingSerialCallback('');
          pendingSerialCallback = null;
          lastSerialPortIds.clear();
        }
        pendingSerialSelectionTimer = null;
      }, SERIAL_PORT_SELECTION_TIMEOUT_MS);

      lastSerialPortIds = new Set(portList.map((p) => p.portId));
      // Send port list to renderer for selection
      mainWindow?.webContents.send(
        'serial-ports-discovered',
        portList.map((p) => ({
          portId: p.portId,
          displayName: p.displayName || p.portName || `Port ${p.portId}`,
          portName: p.portName || '',
          vendorId: p.vendorId,
          productId: p.productId,
        })),
      );
    },
  );

  // ─── Web Bluetooth: Device Selection (Linux) ───────────────────────
  // LoRa BLE uses sidecar GATT on all platforms. Cancel Chromium's chooser so a
  // stray requestDevice() cannot hang the session.
  mainWindow.webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    console.debug(
      `[IPC] select-bluetooth-device: cancelling (${deviceList.length} device(s); Web BT LoRa removed)`,
    );
    callback('');
  });

  // ─── Web Bluetooth: Pairing Handler (Linux) ───────────────────────────
  // Required for devices that require PIN/confirmation during pairing.
  // This is called by Chromium when a device requires pairing during GATT connect.
  mainWindow.webContents.session.setBluetoothPairingHandler((details, callback) => {
    console.debug('[main] bluetooth-pairing-request:', details.pairingKind, details.deviceId);

    if (details.pairingKind === 'providePin') {
      // Meshtastic devices use fixed PIN 123456. MeshCore uses a random PIN shown on the device.
      // Only auto-submit 123456 for Meshtastic; MeshCore must prompt on first PIN request.
      if (blePairingSessionKind === 'meshtastic' && pendingPairingRetryCount === 0) {
        console.debug(
          '[main] bluetooth-pairing: auto-providing default PIN (Meshtastic attempt 1)',
        );
        pendingPairingRetryCount++;
        callback({ pin: '123456', confirmed: true });
        return;
      }

      console.debug(
        '[main] bluetooth-pairing: prompting user for PIN',
        blePairingSessionKind === 'meshcore'
          ? '(MeshCore or Meshtastic retry)'
          : '(Meshtastic retry)',
      );

      if (!mainWindow || mainWindow.isDestroyed()) {
        console.warn('[main] bluetooth-pairing: mainWindow unavailable — aborting pairing');
        callback({ confirmed: false });
        return;
      }

      const pairingTimeoutId = setTimeout(() => {
        if (pendingPairingCallback) {
          console.warn('[main] bluetooth-pairing: PIN prompt timed out after 120s — aborting');
          pendingPairingCallback({ pin: '', confirmed: false });
          pendingPairingCallback = null;
          pendingPairingRetryCount = 0;
        }
      }, 120_000);

      pendingPairingCallback = (response: BluetoothPairingResponse) => {
        clearTimeout(pairingTimeoutId);
        callback(response);
        pendingPairingCallback = null;
      };
      mainWindow.webContents.send('bluetooth-pin-required', {
        deviceId: details.deviceId,
      });
    } else if (details.pairingKind === 'confirmPin') {
      // Device shows a PIN, user must confirm it matches
      console.debug('[main] bluetooth-pairing: confirming PIN match');
      callback({ confirmed: true });
    } else if (details.pairingKind === 'confirm') {
      // Just confirm without PIN
      console.debug('[main] bluetooth-pairing: confirming pairing');
      callback({ confirmed: true });
    } else {
      // Unknown pairing kind - log and confirm
      console.debug('[main] bluetooth-pairing: unknown kind, confirming', details.pairingKind);
      callback({ confirmed: true });
    }
  });

  const permissionLog = new PermissionDecisionLogger();
  // Allow serial, geolocation, and media (camera / future live audio). Deny web-app-installation etc.
  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    const granted =
      permission === 'serial' ||
      permission === 'geolocation' ||
      permission === 'media' ||
      permission === 'notifications';
    permissionLog.log('checkHandler', permission, granted);
    return granted;
  });

  // Grant geolocation (browser GPS fallback), media (camera QR; microphone reserved for future LXST)
  // and notifications (renderer `new Notification` for chat / node / ops / MECP alerts).
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const grant =
        permission === 'geolocation' || permission === 'media' || permission === 'notifications';
      permissionLog.log('requestHandler', permission, grant);
      callback(grant);
    },
  );

  // ─── Device permission (serial / HID / USB only) ───────────────────
  // setDevicePermissionHandler covers navigator.serial / hid / usb — not Bluetooth.
  // Bluetooth uses select-bluetooth-device above. Without a handler, Chromium can
  // show a blank overlay for device permission prompts.
  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial';
  });

  if (!hasInstalledOsmReferrerHook) {
    hasInstalledOsmReferrerHook = true;
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://*.tile.openstreetmap.org/*'] },
      (details, callback) => {
        const nextHeaders = details.requestHeaders;
        nextHeaders.Referer = OSM_HTTP_REFERRER;
        callback({ requestHeaders: nextHeaders });
      },
    );
  }

  // ─── Renderer crash / load failure detection ──────────────────────
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      '[main] Renderer process gone:',
      sanitizeLogMessage(details.reason),
      details.exitCode,
    );
    try {
      dialog.showErrorBox(
        'Mesh-Client — Renderer Stopped',
        `The renderer process ended unexpectedly (${details.reason}, exit ${details.exitCode ?? 'n/a'}).\n\nRestart the application. If this keeps happening, export the log from the app (if still usable) or check the log file in your userData folder.`,
      );
    } catch {
      // catch-no-log-ok dialog unavailable; renderer-process-gone already logged
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    rendererHeartbeatWatchdog.markRendererUnresponsive();
  });
  mainWindow.webContents.on('responsive', () => {
    rendererHeartbeatWatchdog.markRendererResponsive();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDesc, validatedURL) => {
    console.error(
      '[main] Failed to load:',
      errorCode,
      sanitizeLogMessage(errorDesc),
      sanitizeLogMessage(validatedURL),
    );
    // ERR_ABORTED (-3) often means navigation was cancelled; avoid noisy dialog
    if (errorCode === -3) return;
    try {
      const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
      const hint = isDev
        ? 'Ensure the dev server is running (pnpm run dev) and the URL is reachable.'
        : 'The app bundle may be missing or damaged. Try reinstalling or run from source with pnpm run build && pnpm start.';
      dialog.showErrorBox(
        'Mesh-Client — Failed to Load',
        `Could not load the application UI (code ${errorCode}: ${errorDesc}).\n\n${hint}\n\nURL: ${validatedURL}`,
      );
    } catch {
      // catch-no-log-ok dialog unavailable; did-fail-load already logged above
    }
  });

  setMainWindow(mainWindow);
  mainWindow.webContents.on('console-message', (details) => {
    forwardRendererConsoleMessage(details);
  });

  // Load the app
  void (async () => {
    const distIndexPath = path.join(__dirname, '../../dist/renderer/index.html');
    const resolved = await resolveRendererLoadUrl({
      packaged: app.isPackaged,
      devServerUrl: process.env.VITE_DEV_SERVER_URL,
      distIndexPath,
    });
    console.debug('[Startup] renderer load source:', resolved.source);
    console.debug('[Startup] renderer URL:', sanitizeLogMessage(resolved.url));
    console.debug('[Startup] app.isPackaged:', app.isPackaged);
    console.debug('[Startup] userData:', sanitizeLogMessage(app.getPath('userData')));
    if (resolved.openDevTools) {
      mainWindow.webContents.openDevTools();
    }
    if (resolved.source === 'dist') {
      await mainWindow.loadURL(resolved.url, {
        httpReferrer: OSM_HTTP_REFERRER,
      });
      return;
    }
    await mainWindow.loadURL(resolved.url);
  })().catch((e: unknown) => {
    console.error('[main] Failed to load renderer:', sanitizeLogMessage(errorMessageText(e)));
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });
  meshtasticDesktopBackend?.watchWindow(mainWindow);
  win.on('close', () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    if (!win.isMinimized() && !win.isMaximized()) {
      saveWindowState(win.getBounds());
    }
  });

  // Handle window close event (prevent-close when device connected)
  win.on('close', (event) => {
    if (!isQuitting && (isConnected || isAnyMqttConnected())) {
      event.preventDefault();
      if (process.platform === 'darwin') {
        console.debug('[main] window close event: hiding (macOS, device connected)');
        win.hide();
      } else {
        console.debug('[main] window close event: minimizing (device connected)');
        win.minimize();
      }
    }
  });

  win.on('focus', () => {
    rendererHeartbeatWatchdog.expectVisibleHeartbeat();
    refreshUnreadAppBadge();
  });

  setupTray(mainWindow);

  initUpdater(mainWindow);

  if (!offlineTileCache) {
    offlineTileCache = createTileCache(app.getPath('userData'));
    protocol.handle(
      'mesh-tiles',
      createMeshTilesProtocolHandler({
        cache: offlineTileCache,
        getAppVersion: () => app.getVersion(),
      }),
    );
    registerOfflineMapsIpcHandlers(
      () => mainWindow,
      () => offlineTileCache,
    );
  }
}

// ─── Tray unread badge ──────────────────────────────────────────────
let _cachedBadgeIcon: ReturnType<typeof nativeImage.createFromBuffer> | null = null;
let _cachedTrayIconUnread: Electron.NativeImage | null = null;
let _cachedTrayIconRead: Electron.NativeImage | null = null;
let _lastTrayUnreadVariant: boolean | null = null;
function refreshUnreadAppBadge(): void {
  try {
    updateUnreadAppBadge(lastTrayUnreadCount, {
      platform: process.platform,
      initializeNotifications: () => {
        // OS-specific: Electron 44 initializes UNUserNotificationCenter and requests
        // badge authorization here. setBadge alone does not request permission.
        // https://github.com/electron/electron/blob/v44.1.1/shell/browser/notifications/mac/notification_presenter_mac.mm
        Notification.isSupported();
      },
      suppressDockBadge: () => false,
      setDockBadge: (text) => {
        app.dock?.setBadge(text);
      },
      setLauncherBadge: (count) => {
        app.setBadgeCount(count);
      },
      setTaskbarBadge: (count) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (count > 0) {
          _cachedBadgeIcon ??= nativeImage.createFromBuffer(buildBadgePng());
          mainWindow.setOverlayIcon(_cachedBadgeIcon, `${count} unread messages`);
        } else {
          mainWindow.setOverlayIcon(null, '');
        }
      },
    });
  } catch (e) {
    console.error(
      '[main] app unread badge update failed:',
      sanitizeLogMessage(errorMessageText(e)),
    );
  }
}

ipcMain.on('set-tray-unread', (event, count: unknown) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] set-tray-unread: unauthorized sender');
    return;
  }
  try {
    const n = Math.max(0, Math.min(Math.floor(Number(count)) || 0, 99999));
    lastTrayUnreadCount = n;
    refreshUnreadAppBadge();
    const hasUnread = n > 0;
    if (_lastTrayUnreadVariant !== hasUnread) {
      _lastTrayUnreadVariant = hasUnread;
      let img: NativeImage;
      if (hasUnread) {
        _cachedTrayIconUnread ??= buildTrayIcon(true);
        img = _cachedTrayIconUnread;
      } else {
        _cachedTrayIconRead ??= buildTrayIcon(false);
        img = _cachedTrayIconRead;
      }
      tray?.setImage(img);
    }
    tray?.setToolTip(hasUnread ? `Mesh-Client (${n} unread)` : 'Mesh-Client');
  } catch (e) {
    console.error('[main] tray unread update failed:', sanitizeLogMessage(errorMessageText(e)));
  }
});

function startPowerSaveBlocker(): void {
  if (powerSaveBlockerId !== null) return;
  try {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.debug('[main] powerSaveBlocker started, id =', powerSaveBlockerId);
  } catch (e) {
    console.error('[main] powerSaveBlocker start failed:', sanitizeLogMessage(errorMessageText(e)));
    powerSaveBlockerId = null;
  }
}

function stopPowerSaveBlocker(): void {
  if (powerSaveBlockerId === null) return;
  try {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlocker.stop(powerSaveBlockerId);
      console.debug('[main] powerSaveBlocker stopped, id =', powerSaveBlockerId);
    }
  } catch (e) {
    console.error('[main] powerSaveBlocker stop failed:', sanitizeLogMessage(errorMessageText(e)));
  } finally {
    powerSaveBlockerId = null;
  }
}

// ─── IPC: Serial port selected by user ──────────────────────────────
ipcMain.on('serial-port-selected', (event, portId: unknown) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] serial-port-selected: unauthorized sender');
    return;
  }
  if (!pendingSerialCallback) return;
  const id = typeof portId === 'string' ? portId : '';
  if (id !== '' && !lastSerialPortIds.has(id)) {
    console.warn('[IPC] serial-port-selected: ignoring unknown portId');
    return;
  }
  console.debug('[IPC] serial-port-selected:', sanitizeLogMessage(id || '(cancelled)'));
  clearPendingSerialSelectionTimer();
  pendingSerialCallback(id);
  pendingSerialCallback = null;
  lastSerialPortIds.clear();
});

// ─── IPC: Cancel Serial selection ───────────────────────────────────
ipcMain.on('serial-port-cancelled', (event) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] serial-port-cancelled: unauthorized sender');
    return;
  }
  clearPendingSerialSelectionTimer();
  if (pendingSerialCallback) {
    pendingSerialCallback(''); // Empty string cancels the request
    pendingSerialCallback = null;
  }
  lastSerialPortIds.clear();
});

// ─── IPC: Unpair Bluetooth device (Linux only — bluetoothctl remove) ──
// Not used on routine disconnect; only ConnectionPanel manual re-pair flow.
ipcMain.handle('bluetooth-unpair', async (event, macAddress: unknown) => {
  assertIpcSender(event, 'bluetooth-unpair');
  if (typeof macAddress !== 'string') {
    throw new Error('bluetooth-unpair: macAddress must be a string');
  }
  // Validate MAC format (XX:XX:XX:XX:XX:XX)
  if (!isMacAddress(macAddress)) {
    throw new Error('bluetooth-unpair: invalid MAC address format');
  }

  console.debug('[IPC] bluetooth-unpair:', macAddress);

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('bluetoothctl', ['remove', macAddress]);
    let settled = false;
    let stderr = '';
    let stdout = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('bluetooth-unpair: timed out after 5 s'));
      }
    }, 5_000);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        console.error('[IPC] bluetooth-unpair failed:', sanitizeLogMessage(stderr));
        reject(new Error(sanitizeLogMessage(stderr) || 'Failed to unpair device'));
        return;
      }
      console.debug('[IPC] bluetooth-unpair success:', sanitizeLogMessage(stdout.trim()));
      resolve();
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = formatBluetoothctlSpawnError(err);
      console.error('[IPC] bluetooth-unpair error:', sanitizeLogMessage(msg));
      reject(new Error(msg));
    });
  });
});

// ─── IPC: Start BLE scan (Linux) ─────────────────────────────────────
const BLUETOOTH_START_SCAN_TIMEOUT_MS = 15_000;
const BLUETOOTH_STOP_SCAN_TIMEOUT_MS = 5_000;
const BLUETOOTH_GET_INFO_TIMEOUT_MS = 5_000;

ipcMain.handle('bluetooth-start-scan', async (event) => {
  assertIpcSender(event, 'bluetooth-start-scan');
  console.debug('[IPC] bluetooth-start-scan');
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('bluetoothctl', ['scan', 'on']);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('bluetooth-start-scan: timed out after 15 s'));
      }
    }, BLUETOOTH_START_SCAN_TIMEOUT_MS);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        console.debug('[IPC] bluetooth-start-scan success');
        resolve();
      } else {
        console.warn('[IPC] bluetooth-start-scan failed with code', code);
        reject(new Error(`scan on failed with code ${code}`));
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = formatBluetoothctlSpawnError(err);
      console.warn('[IPC] bluetooth-start-scan error:', sanitizeLogMessage(msg));
      reject(new Error(msg));
    });
  });
});

// ─── IPC: Stop BLE scan (Linux) ──────────────────────────────────────
ipcMain.handle('bluetooth-stop-scan', async (event) => {
  assertIpcSender(event, 'bluetooth-stop-scan');
  console.debug('[IPC] bluetooth-stop-scan');
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[IPC] bluetooth-stop-scan: timed out after 5 s, killing process');
      proc.kill();
      finish(); // Don't reject - stop scan failure is not critical
    }, BLUETOOTH_STOP_SCAN_TIMEOUT_MS);
    const proc = spawn('bluetoothctl', ['scan', 'off']);
    proc.on('close', () => {
      console.debug('[IPC] bluetooth-stop-scan done');
      finish();
    });
    proc.on('error', (err) => {
      console.warn(
        '[IPC] bluetooth-stop-scan error:',
        sanitizeLogMessage(err?.message ?? String(err)),
      );
      finish(); // Don't reject - stop scan failure is not critical
    });
  });
});

// ─── IPC: Pair Bluetooth device (Linux) ───────────────────────────────
ipcMain.handle('bluetooth-pair', async (event, macAddress: unknown, pin: unknown) => {
  assertIpcSender(event, 'bluetooth-pair');
  if (typeof macAddress !== 'string') {
    throw new Error('bluetooth-pair: macAddress must be a string');
  }
  if (!isMacAddress(macAddress)) {
    throw new Error('bluetooth-pair: invalid MAC address format');
  }
  let normalizedPin: string | undefined;
  if (typeof pin === 'number' && Number.isInteger(pin) && pin >= 0 && pin <= 999999) {
    normalizedPin = formatMeshtasticBluetoothPin(pin);
  } else if (typeof pin === 'string' && pin.trim().length > 0) {
    const parsed = parseMeshtasticBluetoothPin(pin.trim());
    if (parsed === null) throw new Error('bluetooth-pair: pin must be exactly 6 digits');
    normalizedPin = formatMeshtasticBluetoothPin(parsed);
  } else if (typeof pin !== 'undefined' && pin !== null) {
    throw new Error('bluetooth-pair: pin must be a 6-digit number');
  }
  console.debug('[IPC] bluetooth-pair:', macAddress);
  return new Promise<void>((resolve, reject) => {
    const pairTimeoutMs = 45000;
    let settled = false;
    const trustDeviceBestEffort = (): Promise<void> =>
      new Promise((resolveTrust) => {
        const trustProc = spawn('bluetoothctl', ['trust', macAddress]);
        trustProc.stdout.on('data', () => {
          // drain
        });
        trustProc.stderr.on('data', () => {
          // drain
        });
        trustProc.on('close', () => {
          resolveTrust();
        });
        trustProc.on('error', () => {
          resolveTrust();
        });
      });

    const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let pinSubmitted = false;
    let confirmSubmitted = false;
    let pairRequested = false;
    let agentReady = false;
    let targetDiscovered = false;
    const finishReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(pairTimeout);
      reject(err);
    };
    const finishResolve = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(pairTimeout);
      resolve();
    };
    const pairTimeout = setTimeout(() => {
      try {
        proc.stdin.write('scan off\n');
      } catch {
        // catch-no-log-ok -- best-effort cleanup during timeout
      }
      try {
        proc.stdin.write('quit\n');
      } catch {
        // catch-no-log-ok -- best-effort cleanup during timeout
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        // catch-no-log-ok -- best-effort cleanup during timeout
      }
      finishReject(new Error('Bluetooth pairing timed out; please retry'));
    }, pairTimeoutMs);
    const requestPair = (): void => {
      if (pairRequested) return;
      if (!agentReady || !targetDiscovered) return;
      pairRequested = true;
      proc.stdin.write(`pair ${macAddress}\n`);
    };
    const processPairingChunk = (chunk: string): void => {
      const chunkLower = chunk.toLowerCase();
      if (
        normalizedPin &&
        !pinSubmitted &&
        (chunkLower.includes('pin code') ||
          chunkLower.includes('request pin') ||
          chunkLower.includes('enter passkey') ||
          chunkLower.includes('passkey (number in 0-999999)') ||
          chunkLower.includes('enter pass key'))
      ) {
        pinSubmitted = true;
        proc.stdin.write(`${normalizedPin}\n`);
      }
      if (
        !confirmSubmitted &&
        (chunkLower.includes('confirm passkey') ||
          chunkLower.includes('[agent] confirm') ||
          chunkLower.includes('authorize service'))
      ) {
        confirmSubmitted = true;
        proc.stdin.write('yes\n');
      }
      if (chunkLower.includes('pairing successful') || chunkLower.includes('failed to pair')) {
        proc.stdin.write('scan off\n');
        proc.stdin.write('quit\n');
      }
    };
    proc.stdin.write('agent KeyboardOnly\n');
    proc.stdin.write('default-agent\n');
    proc.stdin.write('scan on\n');
    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      const chunkLower = chunk.toLowerCase();
      if (
        !agentReady &&
        (chunkLower.includes('default agent request successful') ||
          chunkLower.includes('agent is already registered'))
      ) {
        agentReady = true;
        requestPair();
      }
      if (!pairRequested) {
        const discoveredTarget =
          chunk.includes(macAddress) &&
          (chunk.includes('Device') || chunk.includes('[NEW]') || chunk.includes('[CHG]'));
        if (discoveredTarget) {
          targetDiscovered = true;
          requestPair();
        }
      }
      if (chunk.includes('not available')) {
        if (!pairRequested) {
          requestPair();
          return;
        }
        finishReject(new Error('Pairing failed: device not available. Re-scan and retry.'));
        return;
      }
      processPairingChunk(chunk);
    });
    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      processPairingChunk(chunk);
    });
    proc.on('close', (code) => {
      if (settled) return;
      const pairingFailedByOutput =
        stdout.includes('Failed to pair') ||
        stdout.includes('AuthenticationCanceled') ||
        stderr.includes('Failed to pair') ||
        stderr.includes('AuthenticationCanceled');
      const pairingSucceededByOutput = stdout.includes('Pairing successful');
      if (!pairingFailedByOutput && (pairingSucceededByOutput || code === 0)) {
        void trustDeviceBestEffort()
          .then(() => {
            if (settled) return;
            console.debug('[IPC] bluetooth-pair success');
            finishResolve();
          })
          .catch((e: unknown) => {
            // trustDeviceBestEffort is best-effort and should not reject; finish pairing anyway.
            console.debug(
              '[IPC] bluetooth-pair trust settle:',
              sanitizeLogMessage(errorMessageText(e)),
            );
            if (settled) return;
            finishResolve();
          });
      } else {
        console.warn(
          '[IPC] bluetooth-pair failed:',
          sanitizeLogMessage(stderr.trim() || `code ${code}`),
        );
        finishReject(
          new Error(
            sanitizeLogMessage(
              stderr.trim() ||
                (pairingFailedByOutput ? 'pair failed (bluetoothctl reported failure)' : '') ||
                `pair failed with code ${code}`,
            ),
          ),
        );
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      console.warn(
        '[IPC] bluetooth-pair error:',
        sanitizeLogMessage(formatBluetoothctlSpawnError(err)),
      );
      finishReject(new Error(formatBluetoothctlSpawnError(err)));
    });
  });
});

// ─── IPC: Connect Bluetooth device (Linux) ────────────────────────────
ipcMain.handle('bluetooth-connect', async (event, macAddress: unknown) => {
  assertIpcSender(event, 'bluetooth-connect');
  if (typeof macAddress !== 'string') {
    throw new Error('bluetooth-connect: macAddress must be a string');
  }
  if (!isMacAddress(macAddress)) {
    throw new Error('bluetooth-connect: invalid MAC address format');
  }
  console.debug('[IPC] bluetooth-connect:', macAddress);
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('bluetoothctl', ['connect', macAddress]);
    let stderr = '';
    proc.stdout.on('data', () => {
      // drain
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        console.debug('[IPC] bluetooth-connect success');
        resolve();
      } else {
        console.warn(
          '[IPC] bluetooth-connect failed:',
          sanitizeLogMessage(stderr.trim() || `code ${code}`),
        );
        reject(new Error(sanitizeLogMessage(stderr.trim() || `connect failed with code ${code}`)));
      }
    });
    proc.on('error', (err) => {
      const msg = formatBluetoothctlSpawnError(err);
      console.warn('[IPC] bluetooth-connect error:', sanitizeLogMessage(msg));
      reject(new Error(msg));
    });
  });
});

// ─── IPC: Untrust Bluetooth device (Linux) ────────────────────────────
// This is best-effort - failures are ignored
ipcMain.handle('bluetooth-untrust', async (event, macAddress: unknown) => {
  assertIpcSender(event, 'bluetooth-untrust');
  if (typeof macAddress !== 'string') {
    throw new Error('bluetooth-untrust: macAddress must be a string');
  }
  if (!isMacAddress(macAddress)) {
    throw new Error('bluetooth-untrust: invalid MAC address format');
  }
  console.debug('[IPC] bluetooth-untrust:', macAddress);
  return new Promise<void>((resolve) => {
    const proc = spawn('bluetoothctl', ['untrust', macAddress]);
    let stderr = '';
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      // Ignore failure - untrust is best-effort, but log for debugging
      if (code !== 0) {
        console.debug(
          '[IPC] bluetooth-untrust exited with code',
          code,
          'stderr:',
          stderr.trim() || '(none)',
        );
      } else {
        console.debug('[IPC] bluetooth-untrust done');
      }
      resolve();
    });
    proc.on('error', (err) => {
      // Ignore error - untrust is best-effort, but log for debugging
      console.debug(
        '[IPC] bluetooth-untrust error:',
        sanitizeLogMessage(err?.message ?? String(err)),
      );
      resolve();
    });
  });
});

ipcMain.handle('bluetooth-get-info', async (event, macAddress: unknown) => {
  assertIpcSender(event, 'bluetooth-get-info');
  if (typeof macAddress !== 'string') {
    throw new Error('bluetooth-get-info: macAddress must be a string');
  }
  if (!isMacAddress(macAddress)) {
    throw new Error('bluetooth-get-info: invalid MAC address format');
  }
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.warn('[IPC] bluetooth-get-info: timed out after 5 s, killing process');
      proc.kill();
      finish('bluetooth-get-info: timed out after 5 s');
    }, BLUETOOTH_GET_INFO_TIMEOUT_MS);
    const proc = spawn('bluetoothctl', ['info', macAddress]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      const output = (stdout.trim() || stderr.trim() || `code ${code}`).slice(-2000);
      finish(output);
    });
    proc.on('error', (err) => {
      const msg = formatBluetoothctlSpawnError(err);
      finish(msg);
    });
  });
});

// ─── IPC: Provide Bluetooth PIN (Linux) ───────────────────────────────
ipcMain.on('bluetooth-provide-pin', (event, pin: unknown) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] bluetooth-provide-pin: unauthorized sender');
    return;
  }
  if (!pendingPairingCallback) {
    console.warn('[IPC] bluetooth-provide-pin: no pending pairing callback');
    return;
  }
  const pinStr = typeof pin === 'string' ? pin : '';
  console.debug('[IPC] bluetooth-provide-pin:', pinStr.length > 0 ? '****' : '(empty)');
  pendingPairingCallback({ pin: pinStr, confirmed: pinStr.length > 0 });
  pendingPairingCallback = null;
  // Reset retry count so next pairing starts fresh
  pendingPairingRetryCount = 0;
});

// ─── IPC: Cancel Bluetooth pairing (Linux) ────────────────────────────
ipcMain.on('bluetooth-cancel-pairing', (event) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] bluetooth-cancel-pairing: unauthorized sender');
    return;
  }
  if (pendingPairingCallback) {
    console.debug('[IPC] bluetooth-cancel-pairing: cancelling');
    pendingPairingCallback({ pin: '', confirmed: false }); // confirmed: false cancels
    pendingPairingCallback = null;
  }
  // Reset retry count so next pairing starts fresh
  pendingPairingRetryCount = 0;
});

// ─── IPC: Reset BLE pairing retry count (Linux) ───────────────────────────
// Called when starting a new BLE connection so the first pairing attempt uses the default PIN
ipcMain.on('ble-reset-pairing-retry-count', (event, sessionKind?: unknown) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] ble-reset-pairing-retry-count: unauthorized sender');
    return;
  }
  pendingPairingRetryCount = 0;
  blePairingSessionKind = sessionKind === 'meshcore' ? 'meshcore' : 'meshtastic';
});

// ─── IPC: Connection status tracking (module-scope, not per-window) ─
ipcMain.on('device-connected', (event) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] device-connected: unauthorized sender');
    return;
  }
  console.debug('[main] device-connected: isConnected = true');
  isConnected = true;
  startPowerSaveBlocker();
});
ipcMain.on('device-disconnected', (event) => {
  if (!validateIpcSender(event)) {
    console.warn('[IPC] device-disconnected: unauthorized sender');
    return;
  }
  console.debug('[main] device-disconnected: isConnected = false');
  isConnected = false;
  stopPowerSaveBlocker();
});

// ─── GATT BLE: Forward proxy events to renderer ─────────────────────
gattSidecarProxy.on('adapterState', (state: string) => {
  mainWindow?.webContents.send('gatt-adapter-state', state);
});
gattSidecarProxy.on('deviceDiscovered', (device: GattDiscoveredDevice) => {
  mainWindow?.webContents.send('gatt-device-discovered', device);
});
gattSidecarProxy.on(
  'linkRssi',
  ({ sessionId, rssi }: { sessionId: GattSessionProfile; rssi: number | null }) => {
    mainWindow?.webContents.send('gatt-link-rssi', { sessionId, rssi });
  },
);
// ─── Meshtastic background ingest (opt-in) ─────────────────────────
// Stores Meshtastic TCP chat, nodes, positions and telemetry in a utilityProcess while the
// window's renderer is not decoding.
const meshtasticDesktopBackend = loadDesktopMeshtasticHost()?.startDesktopMeshtasticBackend({
  getDb: () => getDbForIpc('meshtastic-backend'),
  insertMessage: insertMeshtasticMessageRow,
  upsertNode: upsertMeshtasticNodeRow,
  insertPosition: insertPositionHistoryRow,
  connectTcp: connectMeshtasticTcpFromMain,
  connectHttp: connectMeshtasticHttpFromMain,
  getMainWindow: () => mainWindow,
  // Its Meshtastic BLE session feeds the ingest too (desktop only).
  gatt: gattSidecarProxy,
});

gattSidecarProxy.on('connected', ({ sessionId }: { sessionId: GattSessionProfile }) => {
  mainWindow?.webContents.send('gatt-connected', { sessionId });
});
gattSidecarProxy.on('disconnected', ({ sessionId }: { sessionId: GattSessionProfile }) => {
  mainWindow?.webContents.send('gatt-disconnected', { sessionId });
});
gattSidecarProxy.on(
  'connect-aborted',
  ({ sessionId, message }: { sessionId: GattSessionProfile; message: string }) => {
    mainWindow?.webContents.send('gatt-connect-aborted', { sessionId, message });
  },
);
gattSidecarProxy.on(
  'fromRadio',
  ({ sessionId, bytes }: { sessionId: GattSessionProfile; bytes: Uint8Array }) => {
    mainWindow?.webContents.send('gatt-from-radio', { sessionId, bytes });
  },
);
gattSidecarProxy.on(
  'issue',
  (payload: { sessionId?: GattSessionProfile; code: string; message: string }) => {
    mainWindow?.webContents.send('gatt:issue', payload);
  },
);

// ─── GATT BLE: IPC command handlers ─────────────────────────────────
const BLE_PERIPHERAL_OWNERS = new Set<BlePeripheralOwner>([
  'gatt:meshtastic',
  'gatt:meshcore',
  'reticulum',
]);
const BLE_SCAN_OWNERS = new Set<BleScanOwner>(['gatt', 'reticulum']);

ipcMain.handle('bleCoexistence:register', (event, mac: unknown, owner: unknown) => {
  assertIpcSender(event, 'bleCoexistence:register');
  if (
    typeof mac !== 'string' ||
    typeof owner !== 'string' ||
    !BLE_PERIPHERAL_OWNERS.has(owner as BlePeripheralOwner)
  ) {
    throw new Error('bleCoexistence:register: invalid mac or owner');
  }
  bleCoexistenceCoordinator.register(mac, owner as BlePeripheralOwner);
  return bleCoexistenceCoordinator.getState();
});
ipcMain.handle('bleCoexistence:unregister', (event, mac: unknown, owner: unknown) => {
  assertIpcSender(event, 'bleCoexistence:unregister');
  if (
    typeof mac !== 'string' ||
    typeof owner !== 'string' ||
    !BLE_PERIPHERAL_OWNERS.has(owner as BlePeripheralOwner)
  ) {
    throw new Error('bleCoexistence:unregister: invalid mac or owner');
  }
  bleCoexistenceCoordinator.unregister(mac, owner as BlePeripheralOwner);
  return bleCoexistenceCoordinator.getState();
});
ipcMain.handle('bleCoexistence:assertCanConnect', (event, owner: unknown, mac: unknown) => {
  assertIpcSender(event, 'bleCoexistence:assertCanConnect');
  if (
    typeof mac !== 'string' ||
    typeof owner !== 'string' ||
    !BLE_PERIPHERAL_OWNERS.has(owner as BlePeripheralOwner)
  ) {
    throw new Error('bleCoexistence:assertCanConnect: invalid mac or owner');
  }
  bleCoexistenceCoordinator.assertCanConnect(owner as BlePeripheralOwner, mac);
  return bleCoexistenceCoordinator.getState();
});
ipcMain.handle('bleCoexistence:getState', (event) => {
  assertIpcSender(event, 'bleCoexistence:getState');
  return bleCoexistenceCoordinator.getState();
});
ipcMain.handle('bleCoexistence:acquireScan', async (event, owner: unknown) => {
  assertIpcSender(event, 'bleCoexistence:acquireScan');
  if (typeof owner !== 'string' || !BLE_SCAN_OWNERS.has(owner as BleScanOwner)) {
    throw new Error('bleCoexistence:acquireScan: owner must be gatt or reticulum');
  }
  try {
    await bleCoexistenceCoordinator.acquireScan(owner as BleScanOwner);
    return { ok: true as const, ...bleCoexistenceCoordinator.getState() };
  } catch (err) {
    if (err instanceof BleScanBusyError) {
      console.debug('[main] bleCoexistence:acquireScan busy:', sanitizeLogMessage(err.message));
      return {
        ok: false as const,
        code: 'scan_busy' as const,
        owner: err.scanOwner,
        ...bleCoexistenceCoordinator.getState(),
      };
    }
    console.error(
      '[main] bleCoexistence:acquireScan failed:',
      sanitizeLogMessage(errorMessageText(err)),
    );
    throw err;
  }
});
ipcMain.handle('bleCoexistence:releaseScan', (event, owner: unknown) => {
  assertIpcSender(event, 'bleCoexistence:releaseScan');
  if (typeof owner !== 'string' || !BLE_SCAN_OWNERS.has(owner as BleScanOwner)) {
    throw new Error('bleCoexistence:releaseScan: owner must be gatt or reticulum');
  }
  bleCoexistenceCoordinator.releaseScan(owner as BleScanOwner);
  return bleCoexistenceCoordinator.getState();
});
ipcMain.handle('bleCoexistence:suspendForReticulumBleConnect', async (event) => {
  assertIpcSender(event, 'bleCoexistence:suspendForReticulumBleConnect');
  await bleCoexistenceCoordinator.suspendForReticulumBleConnect();
  return bleCoexistenceCoordinator.getState();
});

ipcMain.handle('gatt:start-scan', async (event, sessionId: unknown) => {
  assertIpcSender(event, 'gatt:start-scan');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:start-scan: sessionId must be meshtastic or meshcore');
  }
  if (isQuitting) {
    console.debug('[main] gatt:start-scan: ignoring (app is quitting)');
    return { ok: true as const };
  }
  try {
    return await bleCoexistenceCoordinator.withScan('gatt', () =>
      gattSidecarProxy.startScan(sessionId),
    );
  } catch (err) {
    if (err instanceof BleScanBusyError) {
      return { ok: false as const, code: 'scan_busy' as const, owner: err.scanOwner };
    }
    throw err;
  }
});
ipcMain.handle('gatt:stop-scan', async (event, sessionId: unknown) => {
  assertIpcSender(event, 'gatt:stop-scan');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:stop-scan: sessionId must be meshtastic or meshcore');
  }
  try {
    await gattSidecarProxy.stopScan(sessionId);
  } catch (err) {
    console.error(
      `[main] gatt:stop-scan failed: session=${sessionId} message=${sanitizeLogMessage(errorMessageText(err))}`,
    );
    throw err;
  }
});
ipcMain.handle('gatt:connect', async (event, sessionId: unknown, peripheralId: unknown) => {
  assertIpcSender(event, 'gatt:connect');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:connect: sessionId must be meshtastic or meshcore');
  }
  if (typeof peripheralId !== 'string')
    throw new Error('gatt:connect: peripheralId must be a string');
  if (isQuitting) {
    console.debug(`[main] gatt:connect: ignoring session=${sessionId} (app is quitting)`);
    return { ok: false as const, error: 'App is quitting' };
  }
  try {
    if (gattSidecarProxy.isRnodeBondRecoveryExclusive()) {
      return {
        ok: false as const,
        error: 'RNode bond recovery holds the Bluetooth adapter',
        code: 'rnode_bond_recovery' as const,
      };
    }
    return await bleCoexistenceCoordinator.withScan('gatt', () =>
      gattSidecarProxy.connect(sessionId, peripheralId),
    );
  } catch (err) {
    const message = errorMessageText(err);
    console.debug(
      `[main] gatt:connect failed: session=${sessionId} peripheral=${peripheralId} message=${sanitizeLogMessage(message)}`,
    );
    return {
      ok: false as const,
      error: sanitizeLogMessage(message),
      ...(err instanceof BleScanBusyError ? { code: 'scan_busy' } : {}),
      ...(err instanceof BlePeripheralConflictError ? { code: 'mac_conflict' } : {}),
    };
  }
});
ipcMain.handle('gatt:disconnect', async (event, sessionId: unknown) => {
  assertIpcSender(event, 'gatt:disconnect');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:disconnect: sessionId must be meshtastic or meshcore');
  }
  try {
    await gattSidecarProxy.disconnect(sessionId);
  } catch (err) {
    console.error(
      `[main] gatt:disconnect failed: session=${sessionId} message=${sanitizeLogMessage(errorMessageText(err))}`,
    );
    throw err;
  }
});
ipcMain.handle('gatt:release-ble-central', async (event) => {
  assertIpcSender(event, 'gatt:release-ble-central');
  if (isQuitting) {
    console.debug('[main] gatt:release-ble-central: ignoring (app is quitting)');
    return;
  }
  try {
    await gattSidecarProxy.releaseBleCentral();
  } catch (err) {
    console.error(
      `[main] gatt:release-ble-central failed: message=${sanitizeLogMessage(errorMessageText(err))}`,
    );
    throw err;
  }
});
ipcMain.handle('gatt:clear-bond-recovery-exclusive', (event) => {
  assertIpcSender(event, 'gatt:clear-bond-recovery-exclusive');
  if (isQuitting) {
    console.debug('[main] gatt:clear-bond-recovery-exclusive: ignoring (app is quitting)');
    return;
  }
  gattSidecarProxy.setRnodeBondRecoveryExclusive(false);
});
ipcMain.handle('gatt:is-connected', async (event, sessionId: unknown) => {
  assertIpcSender(event, 'gatt:is-connected');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:is-connected: sessionId must be meshtastic or meshcore');
  }
  return gattSidecarProxy.isConnected(sessionId);
});
ipcMain.handle('gatt:to-radio', async (event, sessionId: unknown, bytes: unknown) => {
  assertIpcSender(event, 'gatt:to-radio');
  if (sessionId !== 'meshtastic' && sessionId !== 'meshcore') {
    throw new Error('gatt:to-radio: sessionId must be meshtastic or meshcore');
  }
  if (isQuitting) {
    console.debug(`[main] gatt:to-radio: ignoring session=${sessionId} (app is quitting)`);
    return;
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
  if (buf.length > GATT_TO_RADIO_MAX_BYTES) {
    throw new Error(
      `gatt:to-radio: payload exceeds ${GATT_TO_RADIO_MAX_BYTES} bytes (${buf.length})`,
    );
  }
  await writeGattToRadio(gattSidecarProxy, sessionId, buf);
});
registerGattPairingIpcHandlers({
  proxy: gattSidecarProxy,
  withGattScan: (operation) => bleCoexistenceCoordinator.withScan('gatt', operation),
  isQuitting: () => isQuitting,
});

// ─── MQTT: event forwarding + IPC (ipc/mqtt-handlers.ts) ─────────────
registerMqttIpcHandlers({
  mqttManager,
  meshcoreMqttAdapter,
  getMainWindow: () => mainWindow,
  getTakServerManager: () => takServerHost.get(),
});

registerGeoIpcHandlers();
registerBeaconIpcHandlers();
registerGpsIpcHandlers();
registerNotificationSoundHandlers();
const disposeTranslation = registerTranslationHandlers({
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
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('translation:packProgress', progress);
  },
});
app.on('before-quit', disposeTranslation);
registerFlasherHandlers();
registerServiceAnnouncementIpcHandlers({ ipcMain });

// ─── IPC: Force quit (disconnect all, then quit) ────────────────────
// ─── IPC: Native OS notification ───────────────────────────────────
ipcMain.handle('notify:message', (event, title: unknown, body: unknown) => {
  assertIpcSender(event, 'notify:message');
  if (typeof title !== 'string' || title.length > 128) return;
  if (typeof body !== 'string' || body.length > 512) return;
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch (e) {
    console.warn('[IPC] notify:message failed:', sanitizeLogMessage(errorMessageText(e)));
  }
});

// ─── IPC: Main-owned secure secret storage ─────────────────────────
registerSecureSecretsIpcHandlers({ getDatabase });

// ─── IPC: Login item (launch at startup) ───────────────────────────
ipcMain.handle('app:getProcessUptimeSec', (event) => {
  assertIpcSender(event, 'app:getProcessUptimeSec');
  return Math.floor(process.uptime());
});

ipcMain.handle('app:getRendererLiveness', (event) => {
  if (!validateIpcSender(event)) {
    throw new Error('IPC sender validation failed');
  }
  const mem = process.memoryUsage();
  const hb = rendererHeartbeatWatchdog.getLivenessSnapshot();
  return {
    mainUptimeSec: Math.floor(process.uptime()),
    lastRendererHeartbeatAgeMs: hb.lastRendererHeartbeatAgeMs,
    rendererUnresponsiveSeen: hb.rendererUnresponsiveSeen,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
  };
});

ipcMain.handle('app:getLoginItem', (event) => {
  assertIpcSender(event, 'app:getLoginItem');
  try {
    const settings = app.getLoginItemSettings();
    return { openAtLogin: settings.openAtLogin };
  } catch (e) {
    console.error('[IPC] app:getLoginItem failed:', sanitizeLogMessage(errorMessageText(e)));
    throw e;
  }
});

ipcMain.handle('app:setLoginItem', (event, openAtLogin: unknown) => {
  assertIpcSender(event, 'app:setLoginItem');
  if (typeof openAtLogin !== 'boolean')
    throw new Error('app:setLoginItem: openAtLogin must be a boolean');
  try {
    app.setLoginItemSettings({ openAtLogin });
  } catch (e) {
    console.error('[IPC] app:setLoginItem failed:', sanitizeLogMessage(errorMessageText(e)));
    throw e;
  }
});

ipcMain.handle('app:rendererHeartbeat', (event, payload?: { ts?: number; hidden?: boolean }) => {
  if (!validateIpcSender(event)) return;
  if (event.sender !== mainWindow?.webContents) return;
  rendererHeartbeatWatchdog.recordHeartbeat(payload?.ts, payload?.hidden === true);
});

// ─── IPC: Persistent app settings (SQLite-backed key/value) ────────
registerAppSettingsIpcHandlers({ getDatabase });

/** Notification click → bring the sender's window forward (restores from minimize / tray). */
ipcMain.handle('app:focusWindow', (event) => {
  assertIpcSender(event, 'app:focusWindow');
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

const windowsRequestingAttention = new WeakSet<BrowserWindow>();

/**
 * Unseen MAYDAY/URGENT: flash the taskbar entry / bounce the dock without stealing focus.
 * Electron maps `flashFrame` per OS, so there is no platform branch; cleared on next focus.
 */
ipcMain.handle('app:requestAttention', (event) => {
  assertIpcSender(event, 'app:requestAttention');
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || window.isFocused()) return;
  window.flashFrame(true);
  if (windowsRequestingAttention.has(window)) return;
  windowsRequestingAttention.add(window);
  window.once('focus', () => {
    windowsRequestingAttention.delete(window);
    if (!window.isDestroyed()) window.flashFrame(false);
  });
});

ipcMain.handle('app:showEmojiPanel', (event) => {
  if (!validateIpcSender(event)) {
    throw new Error('IPC sender validation failed');
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      app.showEmojiPanel();
    } catch (e) {
      console.error('[IPC] app:showEmojiPanel failed:', sanitizeLogMessage(errorMessageText(e)));
      throw e;
    }
  }
});

const CLIPBOARD_WRITE_TEXT_MAX_CHARS = 256 * 1024;

ipcMain.handle('clipboard:writeText', async (event, text: unknown) => {
  if (!validateIpcSender(event)) {
    throw new Error('IPC sender validation failed');
  }
  if (typeof text !== 'string') {
    throw new Error('clipboard:writeText: text must be a string');
  }
  if (text.length > CLIPBOARD_WRITE_TEXT_MAX_CHARS) {
    throw new Error('clipboard:writeText: text too long');
  }
  try {
    await clipboard.writeText(text);
  } catch (e) {
    console.warn('[IPC] clipboard:writeText failed:', sanitizeLogMessage(errorMessageText(e)));
    throw e;
  }
});

ipcMain.handle('media:ensureMicrophoneAccess', async (event) => {
  assertIpcSender(event, 'media:ensureMicrophoneAccess');
  try {
    return await ensureMicrophoneAccess({
      platform: process.platform,
      getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
      askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
      openExternal: (url) => {
        const validateUrl = isAllowedMicrophonePrivacySettingsUrl;
        if (!validateUrl(url)) {
          return Promise.reject(new Error('Blocked unexpected microphone privacy settings URL'));
        }
        return shell.openExternal(url);
      },
    });
  } catch (e) {
    console.warn(
      '[IPC] media:ensureMicrophoneAccess failed:',
      sanitizeLogMessage(errorMessageText(e)),
    );
    return { granted: false, status: 'denied' };
  }
});

ipcMain.handle('media:ensureCameraAccess', async (event) => {
  assertIpcSender(event, 'media:ensureCameraAccess');
  try {
    return await ensureCameraAccess({
      platform: process.platform,
      getMediaAccessStatus: (mediaType) => systemPreferences.getMediaAccessStatus(mediaType),
      askForMediaAccess: (mediaType) => systemPreferences.askForMediaAccess(mediaType),
      openExternal: (url) => {
        const validateUrl = isAllowedCameraPrivacySettingsUrl;
        if (!validateUrl(url)) {
          return Promise.reject(new Error('Blocked unexpected camera privacy settings URL'));
        }
        return shell.openExternal(url);
      },
    });
  } catch (e) {
    console.warn('[IPC] media:ensureCameraAccess failed:', sanitizeLogMessage(errorMessageText(e)));
    return { granted: false, status: 'denied' };
  }
});

ipcMain.handle('app:quit', async (event) => {
  if (!validateIpcSender(event)) {
    throw new Error('IPC sender validation failed');
  }
  await quitMainProcess({ relaunch: false });
});

ipcMain.handle('app:relaunch', async (event) => {
  assertIpcSender(event, 'app:relaunch');
  await quitMainProcess({ relaunch: true });
});

// ─── IPC: SQLite db:* (shared with the headless server) ─────────────
registerMeshtasticDbIpcHandlers();
registerMeshcoreDbIpcHandlers();

// ─── IPC: file-dialog handlers (export / import; ipc/file-dialog-handlers.ts) ─
registerFileDialogIpcHandlers({ getMainWindow: () => mainWindow });

// ─── IPC: Clear Chromium session data (BLE cache, cookies, etc.) ──
ipcMain.handle('session:clearData', async (event) => {
  if (!validateIpcSender(event)) {
    throw new Error('IPC sender validation failed');
  }
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    await win.webContents.session.clearStorageData({
      storages: ['cookies', 'localstorage', 'cachestorage', 'shadercache', 'serviceworkers'],
    });
    await win.webContents.session.clearCache();
  } catch (err) {
    console.error('[IPC] session:clearData failed:', sanitizeLogMessage(errorMessageText(err)));
    throw err;
  }
});

// ─── IPC: Log panel ─────────────────────────────────────────────────
registerLogIpcHandlers();
ipcMain.handle('chat:showItemInFolder', (event, filePath: unknown) => {
  if (!validateIpcSender(event)) throw new Error('IPC sender validation failed');
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('filePath must be a non-empty string');
  }
  try {
    shell.showItemInFolder(assertReticulumAttachmentPathJailed(filePath));
    return { ok: true };
  } catch (err) {
    console.error('[IPC] chat:showItemInFolder failed:', sanitizeLogMessage(errorMessageText(err)));
    throw err;
  }
});

// ─── IPC: Chat content (MECP log, attachments, link preview) ─────────
registerChatContentIpcHandlers();

// ─── IPC: Chat outbox ─────────────────────────────────────────────────
registerChatOutboxIpcHandlers();

// ─── IPC: Contact groups ──────────────────────────────────────────────────────

// ─── MeshCore Path History ───────────────────────────────────────────────

// ─── MeshCore / Meshtastic TCP bridges ─────────────────────────────
// Independent sockets (two createTcpBridge instances). writeMissing is the
// only protocol fork: MeshCore rejects; Meshtastic returns 'no-socket'.
registerTcpBridgeIpcHandlers({
  getMainWindow: () => mainWindow,
  validateHost: validateHttpHost,
  meshtasticTap: meshtasticDesktopBackend?.taps.tcp,
});

// ─── Meshtastic HTTP bridge ─────────────────────────────────────────
registerHttpBridgeIpcHandlers({
  getMainWindow: () => mainWindow,
  meshtasticTap: meshtasticDesktopBackend?.taps.http,
});

registerTakIpcHandlers({
  idleTakStatus: IDLE_TAK_STATUS,
  ensureTakServerManager,
  getTakServerManager: () => takServerHost.get(),
  validateTakSettings,
});

registerReticulumIpcHandlers({
  idleStatus: IDLE_RETICULUM_STATUS,
  ensureManager: ensureReticulumSidecarManager,
  getManager: () => reticulumSidecarManager,
  getMainWindow: () => mainWindow,
});
registerReticulumDbIpcHandlers({ ipcMain });
registerRrcDbIpcHandlers({ ipcMain });
registerEnvironmentTelemetryIpcHandlers({ ipcMain });
registerReticulumIdentityIpcHandlers({ ipcMain });

// ─── App lifecycle ─────────────────────────────────────────────────
/** Pending lxm:// URL until mainWindow is ready (cold start / race). */
let pendingOpenUrl: string | null = null;

function forwardOpenUrlToRenderer(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  if (!isForwardableMeshClientOpenUrl(trimmed)) {
    console.debug('[main] ignoring non-mesh open URL:', sanitizeLogMessage(trimmed.slice(0, 120)));
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mesh-client:openUrl', trimmed);
    return;
  }
  pendingOpenUrl = trimmed;
}

function flushPendingOpenUrl(): void {
  if (!pendingOpenUrl || !mainWindow || mainWindow.isDestroyed()) return;
  const url = pendingOpenUrl;
  pendingOpenUrl = null;
  mainWindow.webContents.send('mesh-client:openUrl', url);
}

// macOS: custom protocol open-url (must register before ready).
app.on('open-url', (event, url) => {
  event.preventDefault();
  forwardOpenUrlToRenderer(url);
});

// ─── Second-instance handler ────────────────────────────────────────
// Registered here (before whenReady) so it's ready before any second
// instance can send its data.
app.on('second-instance', (_event, argv) => {
  const url = findLxmUrlInArgv(argv);
  if (url) forwardOpenUrlToRenderer(url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error(
    '[main] child-process-gone:',
    sanitizeLogMessage(
      `${details.type} ${details.reason ?? ''} exit=${String(details.exitCode ?? 'n/a')}`,
    ),
  );
});

void app
  .whenReady()
  .then(() => {
    try {
      initLogFile();
      console.debug(`[Startup] runtime ${formatRuntimeLogTag()}`);
      try {
        console.debug('[main] crashDumps path:', sanitizeLogMessage(app.getPath('crashDumps')));
      } catch (e: unknown) {
        console.warn(
          '[main] crashDumps path unavailable:',
          sanitizeLogMessage(errorMessageText(e)),
        );
      }

      // Register lxm:// deep links (dev + packaged). OS-specific: argv in defaultApp.
      if (process.defaultApp) {
        if (process.argv.length >= 2) {
          app.setAsDefaultProtocolClient('lxm', process.execPath, [path.resolve(process.argv[1])]);
        }
      } else {
        app.setAsDefaultProtocolClient('lxm');
      }
      const coldStartUrl = findLxmUrlInArgv(process.argv);
      if (coldStartUrl) pendingOpenUrl = coldStartUrl;

      initDatabase();

      takServerHost.autoStartFromSavedSettings();

      // Force the dock icon in development on macOS
      if (!app.isPackaged && process.platform === 'darwin') {
        const iconPath = path.join(
          __dirname,
          '../../resources/icons/mac/iconset/icon_256x256@1x.png',
        );
        app.dock?.setIcon(iconPath);
      }
      meshtasticDesktopBackend?.start();
      createWindow();

      rendererHeartbeatWatchdog.startStallWatchdog(() => {
        const win = mainWindow;
        if (!win || win.isDestroyed()) return false;
        return win.isVisible() && !win.isMinimized();
      });

      const MAIN_PROCESS_HEALTH_LOG_INTERVAL_MS = 60 * 60 * 1000;
      const MAIN_PROCESS_HEALTH_UPTIME_THRESHOLD_SEC = 24 * 60 * 60;
      setInterval(() => {
        if (process.uptime() < MAIN_PROCESS_HEALTH_UPTIME_THRESHOLD_SEC) return;
        const uptimeSec = Math.floor(process.uptime());
        const mem = process.memoryUsage();
        console.debug(
          `[main] long-session health uptimeSec=${uptimeSec} rss=${mem.rss} heapUsed=${mem.heapUsed}`,
        );
      }, MAIN_PROCESS_HEALTH_LOG_INTERVAL_MS).unref();

      setupAppMenu();

      // ─── Power monitor: notify renderer on suspend/resume ──────────
      powerMonitor.on('suspend', () => {
        console.debug('[main] System suspending');
        rendererHeartbeatWatchdog.clearResumeWatchdog();
        mqttManager.handlePowerSuspend();
        meshcoreMqttAdapter.handlePowerSuspend();
        mainWindow?.webContents.send('power:suspend');
      });
      powerMonitor.on('resume', () => {
        console.debug('[main] System resumed');
        rendererHeartbeatWatchdog.startResumeWatchdog(() => {
          const win = mainWindow;
          if (!win || win.isDestroyed()) return false;
          return win.isVisible() && !win.isMinimized();
        });
        mainWindow?.webContents.send('power:resume');
      });
    } catch (error) {
      if (isDatabaseSchemaUpgradeDeclinedError(error)) {
        console.debug(
          '[main] Schema upgrade declined; quitting without changing database:',
          sanitizeLogMessage(error.message),
        );
        app.quit();
        return;
      }
      console.error(
        '[main] Fatal startup error:',
        sanitizeLogMessage(error instanceof Error ? (error.stack ?? error.message) : String(error)),
      );
      const isNativeModuleError =
        error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED';
      const message = isDatabaseSchemaTooNewError(error)
        ? formatDatabaseSchemaTooNewMessage(error)
        : isNativeModuleError
          ? `A native module failed to load. This usually means the app needs to be rebuilt for this version of Electron.\n\nFix: run "pnpm install" in the project directory, then restart.\n\nDetails: ${error.message}`
          : `The application failed to start:\n\n${errorMessageText(error)}\n\nPlease report this issue.`;
      showFatalStartupError('Mesh-Client — Startup Error', message);
      app.quit();
      return;
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        try {
          createWindow();
        } catch (error) {
          console.error(
            '[main] Window creation error:',
            sanitizeLogMessage(errorMessageText(error)),
          );
        }
      } else {
        mainWindow?.show(); // Restore hidden window on dock click
      }
    });
  })
  .catch((error: unknown) => {
    console.error(
      '[main] app.whenReady failed:',
      sanitizeLogMessage(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
    showFatalStartupError(
      'Mesh-Client — Startup Error',
      `The application failed to start:\n\n${errorMessageText(error)}\n\nPlease report this issue.`,
    );
    app.quit();
  });

app.on('before-quit', (event) => {
  rendererHeartbeatWatchdog.stopStallWatchdog();
  rendererHeartbeatWatchdog.clearResumeWatchdog();

  if (shutdownDone) {
    return;
  }

  // Latch before async teardown so late gatt:to-radio / MQTT IPC ignore dead-sidecar races.
  isQuitting = true;
  gattSidecarProxy.setQuitting();
  event.preventDefault();
  void (async () => {
    try {
      await gattSidecarProxy.disconnectAll();
    } catch (err) {
      console.error('[main] GATT shutdown failed:', sanitizeLogMessage(errorMessageText(err)));
    } finally {
      // quit() must run even if shutdown throws: before-quit was prevented, so an
      // escaping rejection here would leave the app running with no path to exit.
      try {
        await shutdownAppResources();
      } catch (err) {
        console.error(
          '[main] shutdownAppResources failed before quit:',
          sanitizeLogMessage(errorMessageText(err)),
        );
      }
      app.quit();
    }
  })();
});

app.on('will-quit', (event) => {
  event.preventDefault();
  void (async () => {
    console.debug(
      `[main] will-quit userInitiated=${isQuitting} shutdownDone=${shutdownDone} uptimeSec=${Math.floor(process.uptime())}`,
    );
    await Promise.race([
      flushLogBeforeQuit(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
    ]);
    try {
      takServerHost.get()?.stop();
      takServerHost.get()?.stopRemote();
    } catch (err) {
      console.debug(
        '[main] TAK server stop during will-quit (ignored):',
        err instanceof Error ? err.message : err,
      ); // log-injection-ok internal cleanup
    }
    try {
      await reticulumSidecarManager?.stop({ forQuit: true });
    } catch (err) {
      console.debug(
        '[main] Reticulum sidecar stop during will-quit (ignored):',
        err instanceof Error ? err.message : err,
      ); // log-injection-ok internal cleanup
    }
    try {
      mqttManager.disconnect();
      meshcoreMqttAdapter.disconnect();
    } catch (err) {
      console.debug(
        '[main] MQTT disconnect during will-quit (ignored):',
        err instanceof Error ? err.message : err,
      ); // log-injection-ok internal library error during cleanup
    }
    destroyRegisteredTcpBridgeSockets('TCP socket destroy during will-quit (ignored)');
    meshtasticDesktopBackend?.dispose();
    stopPowerSaveBlocker();
    tray?.destroy();
    tray = null;
    app.exit(0);
  })();
});

app.on('window-all-closed', () => {
  const hasConnection = isConnected || isAnyMqttConnected();
  // On macOS: quit when user chose Quit, or when there's no connection (window closed with nothing to keep running for)
  if (process.platform !== 'darwin' || isQuitting || !hasConnection) {
    app.quit();
  }
});
