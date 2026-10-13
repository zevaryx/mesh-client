/**
 * Meshtastic HTTP bridge IPC (`http:*`) and host-link probes (`hostLink:*`).
 *
 * Polls a Wi-Fi radio's `/api/v1/fromradio` and pushes frames as `http:data`. Moved from
 * `src/main/index.ts`; registered by the Electron main process and the headless server, which
 * differ only in the push target passed as `getMainWindow`.
 */
import { ipcMain } from 'electron';

import { probeHttpRttMs, probeTcpRttMs } from '../host-link-rtt';
import { validateHttpHost } from '../httpHostValidation';
import { snapshotLiveSessionMeter } from '../live-session-meter';
import { logDeviceConnection, sanitizeLogMessage } from '../log-service';
import type { MeshtasticLinkOrigin } from '../meshtastic-backend/linkTarget';
import type { RendererPushTarget } from '../rendererPushTarget';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';
import { type LinkSharing, SharedLinkMembers } from './linkSharing';
import type { TcpBridgeTap } from './tcp-bridge';

let httpDevice: {
  host: string;
  tls: boolean;
  intervalId: NodeJS.Timeout;
  fetchInFlight: boolean;
} | null = null;

const HTTP_FETCH_INTERVAL_MS = 3000;
const HTTP_FETCH_TIMEOUT_MS = 10_000;
/** Meshtastic protobuf frames over HTTP are small (<= a few KB); a well-behaved
 * radio never approaches this. Caps main-process memory against a misbehaving
 * or malicious HTTP peer streaming an unbounded fromradio response body. */
const HTTP_FROMRADIO_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

/** Reads a fetch Response body up to `maxBytes`; throws if the stream exceeds
 * the cap instead of silently truncating (a truncated protobuf frame would
 * corrupt downstream parsing). Falls back to `arrayBuffer()` when the
 * environment lacks a streamable body (defense-in-depth, not expected in Electron/Node). */
class ResponseSizeCapExceededError extends Error {}

async function readBoundedArrayBuffer(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new ResponseSizeCapExceededError(`response body exceeded ${maxBytes} byte cap`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.length;
      if (total > maxBytes) {
        throw new ResponseSizeCapExceededError(`response body exceeded ${maxBytes} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // catch-no-log-ok: stream may already be closed/aborted by this point
    }
  }
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    merged.set(chunk, pos);
    pos += chunk.length;
  }
  return merged.buffer;
}
/** Max Meshtastic HTTP toRadio payload (aligned with meshcore:tcp-write cap). */
const HTTP_WRITE_TO_RADIO_MAX_BYTES = 256 * 1024;

async function httpPreflight(host: string, tls: boolean): Promise<void> {
  const protocol = tls ? 'https' : 'http';
  const url = `${protocol}://${host}/json/report`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

async function httpWriteToRadio(host: string, tls: boolean, data: Uint8Array): Promise<void> {
  const protocol = tls ? 'https' : 'http';
  await fetch(`${protocol}://${host}/api/v1/toradio`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/x-protobuf',
    },
    body: Buffer.from(data),
    signal: AbortSignal.timeout(10_000),
  });
}

export interface HttpBridgeIpcDeps {
  getMainWindow: () => RendererPushTarget | null;
  /** Meshtastic background ingest: sees each polled FromRadio (same shape as `TcpBridgeTap`). */
  meshtasticTap?: TcpBridgeTap;
  /**
   * Headless only: share the polled link between browser tabs, like the TCP bridge
   * (`TcpBridgeSharing`): a tab connecting to the polled host joins it, link starts and user
   * disconnects are announced, and a disconnect from a tab not on the link is ignored.
   */
  sharing?: LinkSharing;
}

/** Background-ingest tap of the registered bridge (one per process, like `httpDevice`). */
let httpTap: TcpBridgeTap | undefined;
let startMeshtasticHttpFromMain: ((host: string, tls: boolean) => Promise<void>) | null = null;

/** Start the Meshtastic HTTP link from the main process (background-ingest link keeper). */
export function connectMeshtasticHttpFromMain(host: string, tls: boolean): Promise<void> {
  if (!startMeshtasticHttpFromMain) {
    return Promise.reject(new Error('http bridge not registered'));
  }
  return startMeshtasticHttpFromMain(host, tls);
}

/** End the current poll loop, telling the tap the link is gone. */
function stopHttpDevice(): void {
  if (!httpDevice) return;
  clearInterval(httpDevice.intervalId);
  httpDevice = null;
  httpTap?.onClose();
}

/** Stop polling the radio (headless shutdown). Electron relies on process exit, as before. */
export function stopHttpBridgePolling(): void {
  stopHttpDevice();
}

/** Register `http:*` and `hostLink:*`. Channel name literals keep check:ipc-contract aligned. */
export function registerHttpBridgeIpcHandlers(deps: HttpBridgeIpcDeps): void {
  httpTap = deps.meshtasticTap;
  ipcMain.handle('http:preflight', async (event, host: unknown, tls: unknown) => {
    if (!validateIpcSender(event)) throw new Error('http:preflight: unauthorized sender');
    validateHttpHost(host);
    if (typeof tls !== 'boolean') {
      throw new Error('Invalid tls');
    }
    await httpPreflight(host, tls);
  });

  ipcMain.handle('hostLink:probeHttpRtt', async (event, host: unknown, tls: unknown) => {
    assertIpcSender(event, 'hostLink:probeHttpRtt');
    validateHttpHost(host);
    if (typeof tls !== 'boolean') {
      throw new Error('Invalid tls');
    }
    return probeHttpRttMs(host, tls);
  });

  ipcMain.handle('hostLink:probeTcpRtt', async (event, host: unknown, port: unknown) => {
    assertIpcSender(event, 'hostLink:probeTcpRtt');
    validateHttpHost(host);
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw new Error('Invalid port');
    }
    return probeTcpRttMs(host, port as number);
  });

  ipcMain.handle('hostLink:getSessionMeter', (event, protocol: unknown) => {
    assertIpcSender(event, 'hostLink:getSessionMeter');
    if (protocol !== 'meshtastic' && protocol !== 'meshcore') {
      throw new Error('Invalid protocol');
    }
    return snapshotLiveSessionMeter(protocol);
  });

  const members = deps.sharing ? new SharedLinkMembers(deps.sharing) : null;

  /** Preflight, then poll `fromradio` until replaced or disconnected. */
  const startHttpLink = async (
    host: string,
    tls: boolean,
    origin: MeshtasticLinkOrigin,
  ): Promise<void> => {
    stopHttpDevice();
    await httpPreflight(host, tls);
    const intervalId = setInterval(() => {
      if (httpDevice?.fetchInFlight) return;
      void (async () => {
        if (httpDevice) httpDevice.fetchInFlight = true;
        try {
          const protocol = tls ? 'https' : 'http';
          let readBuffer = new ArrayBuffer(1);
          while (readBuffer.byteLength > 0) {
            const response = await fetch(`${protocol}://${host}/api/v1/fromradio?all=false`, {
              method: 'GET',
              headers: {
                Accept: 'application/x-protobuf',
              },
              signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
            });
            readBuffer = await readBoundedArrayBuffer(response, HTTP_FROMRADIO_MAX_RESPONSE_BYTES);
            if (readBuffer.byteLength > 0) {
              const data = new Uint8Array(readBuffer);
              // A poll still in flight from a replaced connection must not feed the new link.
              if (httpDevice?.intervalId === intervalId) httpTap?.onData(data);
              deps.getMainWindow()?.webContents.send('http:data', data);
            }
          }
        } catch (err) {
          console.debug(
            '[IPC] http:connect read error:',
            sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
          );
          // Fail closed only for an oversized/garbled fromradio body — the peer is
          // misbehaving and a truncated protobuf frame would corrupt downstream
          // parsing. Transient network/timeout errors keep retrying as before.
          if (err instanceof ResponseSizeCapExceededError) {
            console.error(
              '[IPC] http:connect: fromradio response exceeded size cap, disconnecting',
            );
            if (httpDevice) {
              clearInterval(httpDevice.intervalId);
              httpDevice = null;
              httpTap?.onClose();
            }
          }
        } finally {
          if (httpDevice) httpDevice.fetchInFlight = false;
        }
      })();
    }, HTTP_FETCH_INTERVAL_MS);
    httpDevice = { host, tls, intervalId, fetchInFlight: false };
    httpTap?.onOpen(
      (bytes) => {
        if (httpDevice?.intervalId !== intervalId) return;
        httpWriteToRadio(host, tls, bytes).catch((err: unknown) => {
          console.debug(
            '[IPC] http background-ingest write failed:',
            sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
          );
        });
      },
      { origin, target: { kind: 'http', host, tls } },
    );
    logDeviceConnection(
      `transport=http stack=meshtastic host=${sanitizeLogMessage(host)} tls=${tls}`,
    );
    members?.clear();
    deps.sharing?.announce('meshtastic', { state: 'connected', transport: 'http', host, tls });
  };
  startMeshtasticHttpFromMain = (host, tls) => startHttpLink(host, tls, 'backend');

  ipcMain.handle('http:connect', async (event, host: unknown, tls: unknown) => {
    if (!validateIpcSender(event)) throw new Error('http:connect: unauthorized sender');
    validateHttpHost(host);
    if (typeof tls !== 'boolean') {
      throw new Error('Invalid tls');
    }
    // Shared viewing: join the link another tab is polling instead of restarting it.
    if (members?.isOutsider(event) && httpDevice?.host === host && httpDevice.tls === tls) {
      members.join(event);
      return;
    }
    await startHttpLink(host, tls, 'renderer');
    members?.join(event);
  });

  ipcMain.handle('http:write', async (event, data: number[]) => {
    assertIpcSender(event, 'http:write');
    if (!httpDevice) {
      throw new Error('http:write: no active connection');
    }
    if (!Array.isArray(data) || data.length > HTTP_WRITE_TO_RADIO_MAX_BYTES) {
      throw new Error(
        `http:write: invalid or oversized payload (max ${HTTP_WRITE_TO_RADIO_MAX_BYTES} bytes)`,
      );
    }
    if (!data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new Error('http:write: byte values must be integers 0-255');
    }
    await httpWriteToRadio(httpDevice.host, httpDevice.tls, new Uint8Array(data));
  });

  ipcMain.handle('http:disconnect', (event) => {
    assertIpcSender(event, 'http:disconnect');
    // Shared viewing: a tab not on the link is cleaning up before its own connect.
    if (httpDevice && members?.isOutsider(event)) return;
    if (httpDevice) {
      console.debug('[IPC] http:disconnect');
      stopHttpDevice();
      members?.clear();
      deps.sharing?.announce('meshtastic', { state: 'disconnected', transport: 'http' });
    }
    // An explicit renderer disconnect: stop any background reconnect.
    httpTap?.onUserDisconnect?.();
  });
}
