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

import { currentHeadlessCall } from './callContext';
import { filtersToAccept } from './fileTransfer';
import { createHeadlessSafeStorage, type HeadlessSafeStorage } from './headlessSafeStorage';
import { type HeadlessIpcEvent, headlessIpcRegistry } from './ipcRegistry';

export type IpcMainInvokeEvent = HeadlessIpcEvent;
export type IpcMainEvent = HeadlessIpcEvent;

interface HeadlessAppConfig {
  dataDir: string;
  version: string;
  /** Install root (`dist-headless/..`); `resources/reticulum-sidecar/` lives under it. */
  appPath?: string;
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
  getAppPath: () => string;
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
  getAppPath: (): string => appConfig.appPath ?? process.cwd(),
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

  static getFocusedWindow(): BrowserWindow | null {
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

interface HeadlessDialogOptions {
  title?: string;
  defaultPath?: string;
  properties?: string[];
  filters?: unknown;
}

/** Electron dialogs accept `(options)` or `(window, options)`. */
function dialogOptions(args: unknown[]): HeadlessDialogOptions {
  const opts = args.length > 1 ? args[1] : args[0];
  return opts && typeof opts === 'object' ? opts : {};
}

const NO_BROWSER_SESSION =
  'file dialogs need a browser session (not available outside an IPC call)';

/**
 * Message prompts throw, and callers already treat a dialog failure as "declined" (e.g.
 * `confirmDatabaseSchemaUpgrade` refuses the upgrade unless `MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE=1`),
 * so nothing irreversible happens without the operator. Error boxes go to the server log.
 *
 * File dialogs are served by the browser that made the IPC call (`fileTransfer.ts`): open dialogs
 * upload the picked files to a staging dir, save dialogs return a staging path that is downloaded
 * to the browser when the call succeeds. Folder pickers choose persistent server locations, which a
 * browser cannot do, so they reject with a clear error rather than resolving "canceled".
 */
export const dialog = {
  showMessageBoxSync: (): never => {
    throw new Error('native dialogs are not available in headless mode');
  },
  showOpenDialog: async (
    ...args: unknown[]
  ): Promise<{ canceled: boolean; filePaths: string[] }> => {
    const opts = dialogOptions(args);
    if (opts.properties?.includes('openDirectory')) {
      throw new Error('folder pickers are not available in headless mode');
    }
    const call = currentHeadlessCall();
    if (!call) throw new Error(NO_BROWSER_SESSION);
    const paths = await call.requestFiles({
      ...(opts.title ? { title: opts.title } : {}),
      multiple: opts.properties?.includes('multiSelections') === true,
      accept: filtersToAccept(opts.filters),
    });
    return paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] };
  },
  showSaveDialog: (...args: unknown[]): Promise<{ canceled: boolean; filePath: string }> => {
    const opts = dialogOptions(args);
    const call = currentHeadlessCall();
    if (!call) return Promise.reject(new Error(NO_BROWSER_SESSION));
    const name = path.basename(opts.defaultPath ?? '') || 'download';
    return Promise.resolve({ canceled: false, filePath: call.stageDownload(name) });
  },
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
  /** Electron's Chromium-stack fetch; the server uses Node's (same Request / Response API). */
  fetch: (input: string | Request, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, init),
};

/** The server cannot open a browser for the viewer; callers surface this as an error. */
export const shell = {
  openExternal: (): Promise<never> =>
    Promise.reject(new Error('opening external links is not available in headless mode')),
  /** Revealing a file on the server's desktop means nothing to a remote viewer. */
  showItemInFolder: (): never => {
    throw new Error('showing files in a folder is not available in headless mode');
  },
};
