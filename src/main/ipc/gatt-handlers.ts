/**
 * LoRa BLE through the sidecar GATT proxy (`gatt:*`) and multi-protocol BLE coexistence
 * (`bleCoexistence:*`). Shared by the Electron main process and the headless server (where BLE
 * needs the host's BlueZ over D-Bus; see docs/development/headless-webui.md). Moved verbatim out
 * of `index.ts`; channel name literals keep check:ipc-contract aligned.
 */
import { ipcMain } from 'electron';

import {
  bleCoexistenceCoordinator,
  BlePeripheralConflictError,
  type BlePeripheralOwner,
  BleScanBusyError,
  type BleScanOwner,
} from '../ble-coexistence-coordinator';
import { gattSidecarProxy } from '../gatt-sidecar-proxy';
import { writeGattToRadio } from '../gattIpcWrite';
import type { RendererPushTarget } from '../rendererPushTarget';
import type { ReticulumSidecarManager } from '../reticulum-sidecar-manager';
import { errorMessageText, sanitizeLogMessage } from '../sanitize-log-message';
import { assertIpcSender } from '../validate-ipc-sender';
import { registerGattPairingIpcHandlers } from './gatt-pairing-handlers';

/** Max bytes per BLE write IPC (DoS guard). */
export const GATT_TO_RADIO_MAX_BYTES = 512;

/** Proxy event → renderer channel; every payload is forwarded as the proxy emits it. */
const GATT_FORWARDS: readonly (readonly [string, string])[] = [
  ['adapterState', 'gatt-adapter-state'],
  ['deviceDiscovered', 'gatt-device-discovered'],
  ['linkRssi', 'gatt-link-rssi'],
  ['connected', 'gatt-connected'],
  ['disconnected', 'gatt-disconnected'],
  ['connect-aborted', 'gatt-connect-aborted'],
  ['fromRadio', 'gatt-from-radio'],
  ['issue', 'gatt:issue'],
];

export interface GattIpcDeps {
  getMainWindow: () => RendererPushTarget | null;
  isQuitting: () => boolean;
  /** The Reticulum sidecar manager; its process hosts the GATT central. */
  ensureSidecar: () => Pick<
    ReticulumSidecarManager,
    'ensureForBle' | 'getAuthTokenForLocalProxy' | 'on'
  >;
}

export function registerGattIpcHandlers({
  getMainWindow,
  isQuitting,
  ensureSidecar,
}: GattIpcDeps): void {
  gattSidecarProxy.setEnsureSidecar(async () => {
    if (isQuitting()) {
      throw new Error('gatt sidecar ensure blocked: app is quitting');
    }
    const mgr = ensureSidecar();
    const port = await mgr.ensureForBle();
    gattSidecarProxy.setPort(port, mgr.getAuthTokenForLocalProxy());
    return port;
  });
  bleCoexistenceCoordinator.setGattProxy(gattSidecarProxy);

  // When the shared sidecar process exits (Stop / Quit / crash), clear GATT's
  // cached port so LoRa reconnect does not hammer a dead HTTP port.
  {
    const mgr = ensureSidecar();
    mgr.on('status', (status: { running: boolean; processRunning?: boolean; port: number }) => {
      if (!(status.processRunning ?? status.running)) {
        gattSidecarProxy.invalidateAfterSidecarExit();
      } else if (status.port > 0) {
        gattSidecarProxy.setPort(status.port, mgr.getAuthTokenForLocalProxy());
      }
    });
  }

  // ─── GATT BLE: Forward proxy events to renderer ─────────────────────
  for (const [event, channel] of GATT_FORWARDS) {
    gattSidecarProxy.on(event, (payload: unknown) => {
      getMainWindow()?.webContents.send(channel, payload);
    });
  }

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
    if (isQuitting()) {
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
    if (isQuitting()) {
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
    if (isQuitting()) {
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
    if (isQuitting()) {
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
    if (isQuitting()) {
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
    isQuitting,
  });
}
