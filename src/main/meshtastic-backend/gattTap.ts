/**
 * Feed the Meshtastic BLE session (sidecar GATT) into the background ingest. The sidecar does
 * the GATT reads itself and the main process forwards each FromRadio, so this sees the same
 * packets the renderer does. Desktop only: the headless server does not run BLE.
 */
import type { TcpBridgeTap } from '../ipc/tcp-bridge';

type GattSession = 'meshtastic' | 'meshcore';

/** The part of `GattSidecarProxy` this needs (lets tests use an EventEmitter). */
export interface GattProxyLike {
  on(
    event: 'connected' | 'disconnected',
    listener: (e: { sessionId: GattSession }) => void,
  ): unknown;
  on(
    event: 'fromRadio',
    listener: (e: { sessionId: GattSession; bytes: Uint8Array }) => void,
  ): unknown;
  toRadio: (sessionId: GattSession, bytes: Uint8Array) => Promise<void>;
}

export function attachMeshtasticGattTap(proxy: GattProxyLike, tap: TcpBridgeTap): void {
  proxy.on('connected', ({ sessionId }) => {
    if (sessionId !== 'meshtastic') return;
    tap.onOpen((bytes) => {
      proxy.toRadio('meshtastic', bytes).catch((err: unknown) => {
        console.debug('[meshtastic-backend] BLE keep-alive write failed', err);
      });
    });
  });
  proxy.on('fromRadio', ({ sessionId, bytes }) => {
    if (sessionId === 'meshtastic') tap.onData(bytes);
  });
  proxy.on('disconnected', ({ sessionId }) => {
    if (sessionId === 'meshtastic') tap.onClose();
  });
}
