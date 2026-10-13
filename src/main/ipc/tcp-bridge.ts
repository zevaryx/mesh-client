/**
 * Shared MeshCore / Meshtastic TCP socket bridge.
 *
 * Two `createTcpBridge` instances keep independent sockets so both stacks can
 * stay connected. The only intentional protocol fork is `writeMissing`:
 * MeshCore rejects a missing socket; Meshtastic resolves `'no-socket'`.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import net from 'net';

import { formatHostForSocket } from '../../shared/connectHost';
import {
  clearLiveSessionMeter,
  noteLiveSessionData,
  noteLiveSessionWrite,
  resetLiveSessionMeter,
} from '../live-session-meter';
import { logDeviceConnection, sanitizeLogMessage } from '../log-service';
import type { MeshtasticLinkInfo, MeshtasticLinkTarget } from '../meshtastic-backend/linkTarget';
import { meshtasticTcpWriteErrorIsNoSocket } from '../meshtasticTcpWriteResult';
import type { RendererPushTarget } from '../rendererPushTarget';
import { errorMessageText } from '../sanitize-log-message';
import { assertIpcSender } from '../validate-ipc-sender';

export type TcpBridgeProtocol = 'meshcore' | 'meshtastic';
export type TcpBridgeWriteMissing = 'reject' | 'no-socket';

/** Max TCP toRadio write payload (DoS guard). */
export const TCP_BRIDGE_WRITE_MAX_BYTES = 256 * 1024;
/** Cap inbound TCP chunks before IPC fan-out (same as write max). */
export const TCP_BRIDGE_DATA_MAX_BYTES = TCP_BRIDGE_WRITE_MAX_BYTES;
export const TCP_BRIDGE_CONNECT_TIMEOUT_MS = 20_000;
/** Initial TCP keepalive probe delay (ms). */
export const TCP_BRIDGE_KEEPALIVE_INITIAL_DELAY_MS = 30_000;

/**
 * Main-process observer of the active socket (Meshtastic background ingest), and the extension
 * point for headless shared viewing. Sees exactly what the renderer sees; `write` targets the
 * socket that was active at open and no-ops once replaced. `onUserDisconnect` marks a renderer's
 * explicit disconnect (the link keeper stops reconnecting).
 *
 * The optional hooks let a tap built outside the desktop main bundle (`ipc/linkSharing.ts`) share
 * one link between browser tabs: join it instead of reconnecting, keep it when a tab that is not on
 * it cleans up, route writes and replies, and announce changes.
 */
export interface TcpBridgeTap {
  onOpen: (write: (bytes: Uint8Array) => void, info?: TcpBridgeOpenInfo) => void;
  /** `true` when the tap delivered the chunk to the renderers itself (no broadcast). */
  onData: (chunk: Uint8Array) => boolean | undefined;
  /** `dropped`: the link failed (not replaced or disconnected by a renderer). */
  onClose: (dropped?: boolean) => void;
  /** `hadLink`: the disconnect closed an open link (false when there was none). */
  onUserDisconnect?: (hadLink?: boolean) => void;
  /** A renderer connects: `true` resolves it without a new socket (it joined the open link). */
  join?: (event: IpcMainInvokeEvent, target: MeshtasticLinkTarget) => boolean;
  /** A renderer disconnects: `true` keeps the link (the caller is not on it). */
  keepOnDisconnect?: (event: IpcMainInvokeEvent) => boolean;
  /** A renderer writes: `true` when the tap sent the bytes itself. */
  takeWrite?: (event: IpcMainInvokeEvent, bytes: Uint8Array) => boolean;
}

export interface TcpBridgeOpenInfo extends MeshtasticLinkInfo {
  /** The renderer that opened the link (absent when the main process opened it). */
  event?: IpcMainInvokeEvent;
}

/**
 * Passed instead of an IPC event when the main process itself opens a link (background-ingest
 * link keeper). A renderer cannot produce this object over IPC, so `assertIpcSender` still
 * guards every renderer call.
 */
export const MAIN_PROCESS_ORIGIN: unique symbol = Symbol('mesh-client.main-process-origin');

export interface TcpBridgeDeps {
  protocol: TcpBridgeProtocol;
  writeMissing: TcpBridgeWriteMissing;
  getMainWindow: () => RendererPushTarget | null;
  validateHost: (host: unknown) => asserts host is string;
  tap?: TcpBridgeTap;
}

export interface TcpBridgeHandlers {
  connect: (
    event: IpcMainInvokeEvent | typeof MAIN_PROCESS_ORIGIN,
    host: string,
    port: number,
  ) => Promise<void>;
  write: (
    event: IpcMainInvokeEvent,
    bytes: number[],
  ) => Promise<'no-socket' | undefined> | 'no-socket';
  disconnect: (event: IpcMainInvokeEvent) => void;
  destroyForQuit: (logLabel: string) => void;
}

export interface TcpBridgeRegisterDeps {
  getMainWindow: () => RendererPushTarget | null;
  validateHost: (host: unknown) => asserts host is string;
  meshtasticTap?: TcpBridgeTap | undefined;
  /** Headless shared viewing (`ipc/linkSharing.ts`); MeshCore has no ingest tap of its own. */
  meshcoreTap?: TcpBridgeTap;
}

export function createTcpBridge(deps: TcpBridgeDeps): TcpBridgeHandlers {
  const { protocol, writeMissing, getMainWindow, tap } = deps;
  const validateHost: (host: unknown) => asserts host is string = deps.validateHost;
  let activeSocket: net.Socket | null = null;

  const connectChannel = `${protocol}:tcp-connect`;
  const writeChannel = `${protocol}:tcp-write`;
  const disconnectChannel = `${protocol}:tcp-disconnect`;
  const dataChannel = `${protocol}:tcp-data`;
  const disconnectedChannel = `${protocol}:tcp-disconnected`;

  /** Shared viewing: a renderer joins the open link instead of replacing it (see the tap). */
  const joinsOpenLink = (
    event: IpcMainInvokeEvent | typeof MAIN_PROCESS_ORIGIN,
    host: string,
    port: number,
  ): boolean =>
    event !== MAIN_PROCESS_ORIGIN && tap?.join?.(event, { kind: 'tcp', host, port }) === true;

  const connect = (
    event: IpcMainInvokeEvent | typeof MAIN_PROCESS_ORIGIN,
    host: string,
    port: number,
  ): Promise<void> => {
    if (event !== MAIN_PROCESS_ORIGIN) assertIpcSender(event, connectChannel);
    const origin = event === MAIN_PROCESS_ORIGIN ? 'backend' : 'renderer';
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const p = port;
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        reject(new Error('Invalid port'));
        return;
      }
      try {
        validateHost(host);
      } catch (err) {
        // catch-no-log-ok validation error forwarded to promise reject
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (joinsOpenLink(event, host, p)) {
        settled = true;
        resolve();
        return;
      }
      if (activeSocket) {
        // Null before destroy so the superseded socket's 'close' does not emit
        // tcp-disconnected (renderer reconnect is driven by that event — #792).
        const prev = activeSocket;
        activeSocket = null;
        clearLiveSessionMeter(protocol);
        prev.destroy();
        tap?.onClose();
      }
      const socketHost = formatHostForSocket(host);
      const socket = new net.Socket();
      // MeshCore Open / official companion TCP clients use TCP_NODELAY; Node defaults can
      // Nagle-batch small companion RPCs and OpenHop peers often FIN mid-init.
      socket.setNoDelay(true);
      socket.setKeepAlive(true, TCP_BRIDGE_KEEPALIVE_INITIAL_DELAY_MS);
      activeSocket = socket;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (activeSocket === socket) {
          activeSocket = null;
          clearLiveSessionMeter(protocol);
        }
        socket.destroy();
        reject(new Error(`${connectChannel}: connection timeout`));
      }, TCP_BRIDGE_CONNECT_TIMEOUT_MS);
      socket.connect(p, socketHost, () => {
        clearTimeout(connectTimeout);
        console.debug(`[IPC] ${connectChannel} connected to`, sanitizeLogMessage(socketHost), p);
        logDeviceConnection(
          `transport=tcp stack=${protocol} host=${sanitizeLogMessage(socketHost)} port=${p}`,
        );
        resetLiveSessionMeter(protocol);
        if (tap && activeSocket === socket) {
          tap.onOpen(
            (bytes) => {
              if (activeSocket === socket && !socket.destroyed && !socket.writableEnded) {
                socket.write(bytes);
              }
            },
            {
              origin,
              target: { kind: 'tcp', host, port: p },
              ...(event === MAIN_PROCESS_ORIGIN ? {} : { event }),
            },
          );
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (chunk.length > TCP_BRIDGE_DATA_MAX_BYTES) {
          console.warn(
            `[IPC] ${dataChannel} oversized chunk (${chunk.length} > ${TCP_BRIDGE_DATA_MAX_BYTES}); dropping socket`,
          );
          try {
            socket.destroy();
          } catch (e) {
            console.debug(
              `[IPC] ${dataChannel} destroy after oversize ` +
                sanitizeLogMessage(errorMessageText(e)),
            );
          }
          return;
        }
        // Superseded sockets must not update the live session meter (#792 connect-replace).
        let delivered: boolean | undefined = false;
        if (activeSocket === socket) {
          noteLiveSessionData(protocol);
          delivered = tap?.onData(new Uint8Array(chunk));
        }
        if (!delivered) getMainWindow()?.webContents.send(dataChannel, new Uint8Array(chunk));
      });
      socket.on('close', (hadError) => {
        clearTimeout(connectTimeout);
        // readableEnded=true after peer FIN; local destroy-before-null tear downs do not hit this
        // branch as active (ref cleared first). Log fields help triage n7eal post-contacts hangs.
        const remote = socket.remoteAddress
          ? `${socket.remoteAddress}:${socket.remotePort ?? '?'}`
          : 'unknown';
        console.debug(
          `[IPC] ${protocol}:tcp socket closed`,
          hadError ? '(hadError)' : '(clean)',
          `remote=${sanitizeLogMessage(remote)}`,
          `readableEnded=${socket.readableEnded}`,
          `writableEnded=${socket.writableEnded}`,
        );
        // Only notify when this socket is still the active bridge. connect/disconnect clear the
        // ref before destroy(), so superseded closes must not look like a live link drop
        // (renderer reconnect is driven by this event — see #792).
        if (activeSocket === socket) {
          activeSocket = null;
          clearLiveSessionMeter(protocol);
          tap?.onClose(true);
          getMainWindow()?.webContents.send(disconnectedChannel);
        }
        // Connect-replace / timeout destroy can close a socket that never connected.
        // Clearing the timeout above would otherwise leave the IPC invoke pending.
        if (!settled) {
          settled = true;
          reject(new Error(`${connectChannel}: closed before connect`));
        }
      });
      socket.on('error', (err) => {
        clearTimeout(connectTimeout);
        console.error(`[IPC] ${connectChannel} error:`, sanitizeLogMessage(err.message));
        if (!settled) {
          settled = true;
          reject(err);
        }
        // Do not null the active socket here. Node fires 'error' before 'close' on ECONNRESET
        // etc.; nulling early makes close's active-socket guard fail and swallows
        // tcp-disconnected (renderer never reconnects). close owns that transition.
      });
    });
  };

  const write = (
    event: IpcMainInvokeEvent,
    bytes: number[],
  ): Promise<'no-socket' | undefined> | 'no-socket' => {
    assertIpcSender(event, writeChannel);
    if (!Array.isArray(bytes) || bytes.length > TCP_BRIDGE_WRITE_MAX_BYTES) {
      return Promise.reject(
        new Error(
          `${writeChannel}: invalid or oversized payload (max ${TCP_BRIDGE_WRITE_MAX_BYTES} bytes)`,
        ),
      );
    }
    // Validate each element is a valid byte value so Uint8Array coercion is not silently lossy.
    if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      return Promise.reject(new Error(`${writeChannel}: byte values must be integers 0-255`));
    }
    if (!activeSocket) {
      if (writeMissing === 'no-socket') {
        // Expected reconnect race — resolve so Electron does not log handler [error].
        console.debug(`[IPC] ${writeChannel}: no active socket`);
        return 'no-socket';
      }
      const msg = `${writeChannel}: no active socket`;
      console.warn(`[IPC] ${msg}`);
      return Promise.reject(new Error(msg));
    }
    const sock = activeSocket;
    if (writeMissing === 'no-socket' && (sock.destroyed || sock.writableEnded)) {
      console.debug(`[IPC] ${writeChannel}: no active socket`);
      return 'no-socket';
    }
    if (tap?.takeWrite?.(event, new Uint8Array(bytes))) return Promise.resolve(undefined);
    return new Promise<'no-socket' | undefined>((resolve, reject) => {
      sock.write(new Uint8Array(bytes), (err) => {
        if (err) {
          if (writeMissing === 'no-socket' && meshtasticTcpWriteErrorIsNoSocket(sock, err)) {
            console.debug(`[IPC] ${writeChannel}: no active socket`);
            resolve('no-socket');
            return;
          }
          console.error(`[IPC] ${writeChannel} error:`, sanitizeLogMessage(err.message));
          reject(err);
        } else {
          // Ignore write completions from a superseded socket.
          if (activeSocket === sock) {
            noteLiveSessionWrite(protocol);
          }
          resolve(undefined);
        }
      });
    });
  };

  const disconnect = (event: IpcMainInvokeEvent): void => {
    assertIpcSender(event, disconnectChannel);
    if (activeSocket && tap?.keepOnDisconnect?.(event)) return;
    const hadLink = activeSocket !== null;
    if (activeSocket) {
      console.debug(`[IPC] ${disconnectChannel}`);
      // Null before destroy so this teardown close is not reported as a live link drop.
      const prev = activeSocket;
      activeSocket = null;
      clearLiveSessionMeter(protocol);
      prev.destroy();
      tap?.onClose();
    }
    // An explicit renderer disconnect, even with no socket: stop any background reconnect.
    tap?.onUserDisconnect?.(hadLink);
  };

  const destroyForQuit = (logLabel: string): void => {
    if (!activeSocket) return;
    const prev = activeSocket;
    activeSocket = null;
    clearLiveSessionMeter(protocol);
    tap?.onClose();
    try {
      prev.destroy();
    } catch (err) {
      console.debug(`[main] ${logLabel}:`, err instanceof Error ? err.message : err); // log-injection-ok internal Node.js socket error during cleanup
    }
  };

  return { connect, write, disconnect, destroyForQuit };
}

const registeredBridges: TcpBridgeHandlers[] = [];
let registeredMeshtasticBridge: TcpBridgeHandlers | null = null;

/** Open the Meshtastic TCP link from the main process (background-ingest link keeper). */
export function connectMeshtasticTcpFromMain(host: string, port: number): Promise<void> {
  if (!registeredMeshtasticBridge) {
    return Promise.reject(new Error('meshtastic:tcp bridge not registered'));
  }
  return registeredMeshtasticBridge.connect(MAIN_PROCESS_ORIGIN, host, port);
}

/** Register both protocol bridges. Channel name literals keep check:ipc-contract aligned. */
export function registerTcpBridgeIpcHandlers(deps: TcpBridgeRegisterDeps): void {
  const meshcore = createTcpBridge({
    protocol: 'meshcore',
    writeMissing: 'reject',
    getMainWindow: deps.getMainWindow,
    validateHost: deps.validateHost,
    tap: deps.meshcoreTap,
  });
  ipcMain.handle('meshcore:tcp-connect', meshcore.connect);
  ipcMain.handle('meshcore:tcp-write', meshcore.write);
  ipcMain.handle('meshcore:tcp-disconnect', meshcore.disconnect);

  const meshtastic = createTcpBridge({
    protocol: 'meshtastic',
    writeMissing: 'no-socket',
    getMainWindow: deps.getMainWindow,
    validateHost: deps.validateHost,
    tap: deps.meshtasticTap,
  });
  ipcMain.handle('meshtastic:tcp-connect', meshtastic.connect);
  ipcMain.handle('meshtastic:tcp-write', meshtastic.write);
  ipcMain.handle('meshtastic:tcp-disconnect', meshtastic.disconnect);

  registeredBridges.push(meshcore, meshtastic);
  registeredMeshtasticBridge = meshtastic;
}

/** Destroy both protocol sockets on quit / will-quit. */
export function destroyRegisteredTcpBridgeSockets(logLabel: string): void {
  for (const bridge of registeredBridges) {
    bridge.destroyForQuit(logLabel);
  }
}
