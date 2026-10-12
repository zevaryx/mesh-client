/**
 * Headless stand-in for the `electron` module.
 *
 * `scripts/build-headless.mjs` aliases `electron` to this file when bundling the headless
 * server, so existing main-process modules (`ipc/tcp-bridge.ts`, `log-service.ts`, …) run
 * unchanged under plain Node. Only the surface those modules use is implemented; a module that
 * imports anything else fails the headless build ("No matching export"), which is the signal
 * to port it deliberately rather than inherit a silent no-op.
 */
import os from 'node:os';
import path from 'node:path';

import { createHeadlessSafeStorage, type HeadlessSafeStorage } from './headlessSafeStorage';
import { type HeadlessIpcEvent, headlessIpcRegistry } from './ipcRegistry';

export type IpcMainInvokeEvent = HeadlessIpcEvent;
export type IpcMainEvent = HeadlessIpcEvent;

interface HeadlessAppConfig {
  dataDir: string;
  version: string;
}

let appConfig: HeadlessAppConfig = {
  dataDir: path.resolve('mesh-client-data'),
  version: '0.0.0',
};

/** Set by the headless entry point before any handler module touches `app.getPath`. */
export function configureHeadlessApp(config: HeadlessAppConfig): void {
  appConfig = { ...config };
}

type HeadlessPathName =
  'userData' | 'appData' | 'logs' | 'temp' | 'home' | 'downloads' | 'documents' | 'sessionData';

function getPath(name: HeadlessPathName): string {
  switch (name) {
    case 'userData':
    case 'appData':
    case 'sessionData':
      return appConfig.dataDir;
    case 'logs':
      return path.join(appConfig.dataDir, 'logs');
    case 'downloads':
    case 'documents':
      return path.join(appConfig.dataDir, 'exports');
    case 'temp':
      return os.tmpdir();
    case 'home':
      return os.homedir();
  }
}

interface HeadlessApp {
  isPackaged: boolean;
  getVersion: () => string;
  getName: () => string;
  getLocale: () => string;
  getPath: (name: HeadlessPathName) => string;
  on: () => HeadlessApp;
  whenReady: () => Promise<void>;
  quit: () => void;
}

export const app: HeadlessApp = {
  /** Headless builds are production builds: `validateIpcSender` applies its packaged rules. */
  isPackaged: true,
  getVersion: (): string => appConfig.version,
  getName: (): string => 'Mesh Client',
  getLocale: (): string => 'en-US',
  getPath,
  /** Lifecycle events (`ready`, `before-quit`, …) never fire headless; the entry owns shutdown. */
  on: () => app,
  whenReady: (): Promise<void> => Promise.resolve(),
  quit: (): void => {
    process.exitCode = 0;
    process.kill(process.pid, 'SIGTERM');
  },
};

export const ipcMain = {
  handle: headlessIpcRegistry.handle.bind(headlessIpcRegistry),
  removeHandler: headlessIpcRegistry.removeHandler.bind(headlessIpcRegistry),
  on: headlessIpcRegistry.on.bind(headlessIpcRegistry),
  removeListener: headlessIpcRegistry.removeListener.bind(headlessIpcRegistry),
  removeAllListeners: headlessIpcRegistry.removeAllListeners.bind(headlessIpcRegistry),
};

type HeadlessBroadcast = (channel: string, args: unknown[]) => void;

/**
 * The one "window" of a headless server. `webContents.send` fans out to every authenticated
 * bridge session (see `webServer.ts`), so all open browser tabs see the same push events.
 */
export class BrowserWindow {
  private static readonly windows: BrowserWindow[] = [];
  private destroyed = false;

  readonly webContents: {
    id: number;
    send: (channel: string, ...args: unknown[]) => void;
    isDestroyed: () => boolean;
  };

  constructor(broadcast: HeadlessBroadcast) {
    this.webContents = {
      id: 1,
      send: (channel, ...args) => {
        if (!this.destroyed) broadcast(channel, args);
      },
      isDestroyed: () => this.destroyed,
    };
    BrowserWindow.windows.push(this);
  }

  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.windows.filter((w) => !w.destroyed);
  }

  /** Every bridge session belongs to the one headless window. */
  static fromWebContents(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isVisible(): boolean {
    return !this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let safeStorageImpl: HeadlessSafeStorage = createHeadlessSafeStorage(null);

/** Set by the headless entry point from `MESH_CLIENT_SECRET_KEY(_FILE)`; `null` = no key. */
export function configureHeadlessSafeStorage(keyMaterial: string | null): void {
  safeStorageImpl = createHeadlessSafeStorage(keyMaterial);
}

/** Stable object (modules hold the import) delegating to the configured implementation. */
export const safeStorage: HeadlessSafeStorage = {
  isEncryptionAvailable: () => safeStorageImpl.isEncryptionAvailable(),
  getSelectedStorageBackend: () => safeStorageImpl.getSelectedStorageBackend(),
  encryptString: (plainText) => safeStorageImpl.encryptString(plainText),
  decryptString: (encrypted) => safeStorageImpl.decryptString(encrypted),
};

/**
 * No native dialogs headless. Prompts throw, and callers already treat a dialog failure as
 * "declined" (e.g. `confirmDatabaseSchemaUpgrade` refuses the upgrade unless
 * `MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE=1`), so nothing irreversible happens without the operator.
 * Error boxes go to the server log.
 */
const NO_FILE_DIALOGS = 'native file dialogs are not available in headless mode';

export const dialog = {
  showMessageBoxSync: (): never => {
    throw new Error('native dialogs are not available in headless mode');
  },
  /** Rejects (never resolves "canceled"), so the renderer shows an error instead of nothing. */
  showOpenDialog: (): Promise<never> => Promise.reject(new Error(NO_FILE_DIALOGS)),
  showSaveDialog: (): Promise<never> => Promise.reject(new Error(NO_FILE_DIALOGS)),
  showErrorBox: (title: string, content: string): void => {
    console.error(`[headless] ${title}: ${content}`); // log-injection-ok fixed app-authored startup error text
  },
};

/**
 * Electron reports OS network state. Headless always says online; a real outage surfaces as the
 * fetch failure callers already handle (e.g. the updater classifies it as offline).
 */
export const net = {
  isOnline: (): boolean => true,
};

/** The server cannot open a browser for the viewer; callers surface this as an error. */
export const shell = {
  openExternal: (): Promise<never> =>
    Promise.reject(new Error('opening external links is not available in headless mode')),
};
