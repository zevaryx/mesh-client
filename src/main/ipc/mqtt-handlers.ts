/**
 * MQTT IPC (`mqtt:*`) and manager → renderer event forwarding, for both the Meshtastic
 * `MQTTManager` and the `MeshcoreMqttAdapter`.
 *
 * Moved from `src/main/index.ts`; registered by the Electron main process and the headless
 * server. The client instances stay owned by the caller (Electron's quit / power handlers use
 * them too); this module only wires IPC and events to them.
 */
import { ipcMain } from 'electron';

import { type MQTTSettings } from '../../renderer/lib/types';
import { type MeshProtocol } from '../../shared/meshProtocol';
import { isValidHttpHostname } from '../httpHostValidation';
import { sanitizeLogMessage } from '../log-service';
import { MeshcoreMqttAdapter } from '../meshcore-mqtt-adapter';
import { resolveMqttBrokerClientId } from '../mqtt-broker-client-id';
import { type CachedNode, type MQTTManager, parsePsk } from '../mqtt-manager';
import type { RendererPushTarget } from '../rendererPushTarget';
import type { TakServerManager } from '../tak-server-manager';
import { assertIpcSender } from '../validate-ipc-sender';
import { MAX_PAYLOAD_LENGTH } from './db-ipc-validation';

function validateMqttSettings(settings: unknown): void {
  if (!settings || typeof settings !== 'object')
    throw new Error('mqtt:connect: settings must be an object');
  const s = settings as Record<string, unknown>;
  if (typeof s.server !== 'string' || !s.server.trim())
    throw new Error('mqtt:connect: server must be a non-empty string');
  if (!isValidHttpHostname(s.server.trim()))
    throw new Error('mqtt:connect: server hostname invalid');
  const port = Number(s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('mqtt:connect: port must be 1–65535');
  if (s.topicPrefix != null && typeof s.topicPrefix !== 'string')
    throw new Error('mqtt:connect: topicPrefix must be a string');
  if (s.username != null && typeof s.username !== 'string')
    throw new Error('mqtt:connect: username must be a string');
  if (s.password != null && typeof s.password !== 'string')
    throw new Error('mqtt:connect: password must be a string');
  if (s.tlsInsecure != null && typeof s.tlsInsecure !== 'boolean')
    throw new Error('mqtt:connect: tlsInsecure must be a boolean');
  if (s.tlsEnabled != null && typeof s.tlsEnabled !== 'boolean')
    throw new Error('mqtt:connect: tlsEnabled must be a boolean');
  if (s.useWebSocket != null && typeof s.useWebSocket !== 'boolean')
    throw new Error('mqtt:connect: useWebSocket must be a boolean');
  if (s.meshcorePacketLoggerEnabled != null && typeof s.meshcorePacketLoggerEnabled !== 'boolean') {
    throw new Error('mqtt:connect: meshcorePacketLoggerEnabled must be a boolean');
  }
  if (s.mqttTransportProtocol != null) {
    if (s.mqttTransportProtocol !== 'meshtastic' && s.mqttTransportProtocol !== 'meshcore') {
      throw new Error('mqtt:connect: mqttTransportProtocol must be meshtastic or meshcore');
    }
  }
}

const MAX_MESHCORE_MQTT_TEXT = 16000;

function validateMqttPublishMeshcoreArgs(args: unknown): void {
  if (!args || typeof args !== 'object')
    throw new Error('mqtt:publishMeshcore: args must be an object');
  const a = args as Record<string, unknown>;
  if (typeof a.text !== 'string') throw new Error('mqtt:publishMeshcore: text must be a string');
  if (a.text.length > MAX_MESHCORE_MQTT_TEXT)
    throw new Error('mqtt:publishMeshcore: text too long');
  const ch = Number(a.channelIdx);
  if (!Number.isFinite(ch) || ch < 0 || ch > 255)
    throw new Error('mqtt:publishMeshcore: channelIdx must be 0–255');
  if (a.senderName != null && (typeof a.senderName !== 'string' || a.senderName.length > 200)) {
    throw new Error('mqtt:publishMeshcore: senderName invalid');
  }
  if (a.senderNodeId != null) {
    const id = Number(a.senderNodeId);
    if (!Number.isFinite(id) || id < 0)
      throw new Error('mqtt:publishMeshcore: senderNodeId invalid');
  }
  if (a.timestamp != null && !Number.isFinite(Number(a.timestamp))) {
    throw new Error('mqtt:publishMeshcore: timestamp invalid');
  }
}

const MAX_MESHCORE_PACKET_LOG_ORIGIN = 200;
const MAX_MESHCORE_PACKET_LOG_RAW_HEX = 2048;

function validateMqttPublishMeshcorePacketLogArgs(args: unknown): void {
  if (!args || typeof args !== 'object')
    throw new Error('mqtt:publishMeshcorePacketLog: args must be an object');
  const a = args as Record<string, unknown>;
  if (typeof a.origin !== 'string' || a.origin.length === 0)
    throw new Error('mqtt:publishMeshcorePacketLog: origin must be a non-empty string');
  if (a.origin.length > MAX_MESHCORE_PACKET_LOG_ORIGIN)
    throw new Error('mqtt:publishMeshcorePacketLog: origin too long');
  const snr = Number(a.snr);
  const rssi = Number(a.rssi);
  if (!Number.isFinite(snr)) throw new Error('mqtt:publishMeshcorePacketLog: snr must be finite');
  if (!Number.isFinite(rssi)) throw new Error('mqtt:publishMeshcorePacketLog: rssi must be finite');
  if (a.rawHex != null) {
    if (typeof a.rawHex !== 'string')
      throw new Error('mqtt:publishMeshcorePacketLog: rawHex invalid');
    if (a.rawHex.length > MAX_MESHCORE_PACKET_LOG_RAW_HEX)
      throw new Error('mqtt:publishMeshcorePacketLog: rawHex too long');
    if (!/^[0-9a-fA-F]*$/.test(a.rawHex))
      throw new Error('mqtt:publishMeshcorePacketLog: rawHex must be hex');
  }
}

function validateOptionalPskBase64(value: unknown, channel: string): void {
  if (value == null) return;
  if (typeof value !== 'string') throw new Error(`${channel}: pskBase64 must be a string`);
  if (!parsePsk(value)) throw new Error(`${channel}: pskBase64 must decode to 16 or 32 bytes`);
}

function validateMqttUpdateChannelKeysArgs(args: unknown): void {
  if (!args || typeof args !== 'object')
    throw new Error('mqtt:updateChannelKeys: args must be an object');
  const a = args as Record<string, unknown>;
  if (!Array.isArray(a.entries))
    throw new Error('mqtt:updateChannelKeys: entries must be an array');
  if (a.entries.length > 32) throw new Error('mqtt:updateChannelKeys: too many entries');
  for (const entry of a.entries) {
    if (!entry || typeof entry !== 'object')
      throw new Error('mqtt:updateChannelKeys: each entry must be an object');
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name.trim())
      throw new Error('mqtt:updateChannelKeys: name must be a non-empty string');
    if (e.name.length > 64) throw new Error('mqtt:updateChannelKeys: name too long');
    validateOptionalPskBase64(e.pskBase64, 'mqtt:updateChannelKeys');
    if (e.index !== undefined) {
      if (typeof e.index !== 'number' || !Number.isInteger(e.index) || e.index < 0 || e.index > 7) {
        throw new Error('mqtt:updateChannelKeys: index must be an integer 0–7');
      }
    }
  }
  if (a.radioSessionId !== undefined) {
    if (typeof a.radioSessionId !== 'string')
      throw new Error('mqtt:updateChannelKeys: radioSessionId must be a string');
    if (a.radioSessionId.length > 64)
      throw new Error('mqtt:updateChannelKeys: radioSessionId too long');
  }
}

function validateMqttUpdateTopicPrefixArgs(args: unknown): void {
  if (!args || typeof args !== 'object')
    throw new Error('mqtt:updateTopicPrefix: args must be an object');
  const a = args as Record<string, unknown>;
  if (typeof a.topicPrefix !== 'string')
    throw new Error('mqtt:updateTopicPrefix: topicPrefix must be a string');
  if (a.topicPrefix.length > 128) throw new Error('mqtt:updateTopicPrefix: topicPrefix too long');
}

function validateMqttPublishArgs(args: unknown): void {
  if (!args || typeof args !== 'object') throw new Error('mqtt:publish: args must be an object');
  const a = args as Record<string, unknown>;
  if (typeof a.text !== 'string') throw new Error('mqtt:publish: text must be a string');
  if (a.text.length > MAX_PAYLOAD_LENGTH) throw new Error('mqtt:publish: text too long');
  const from = Number(a.from);
  if (!Number.isFinite(from) || from <= 0)
    throw new Error('mqtt:publish: from must be a positive node id');
  const channel = Number(a.channel);
  if (!Number.isFinite(channel) || channel < 0)
    throw new Error('mqtt:publish: channel must be a non-negative integer');
  if (a.destination != null) {
    const dest = Number(a.destination);
    if (!Number.isFinite(dest) || dest < 0)
      throw new Error('mqtt:publish: destination must be a non-negative integer');
  }
  if (a.channelName != null && typeof a.channelName !== 'string')
    throw new Error('mqtt:publish: channelName must be a string');
  if (a.emoji != null) {
    const emoji = Number(a.emoji);
    if (!Number.isFinite(emoji) || emoji < 0)
      throw new Error('mqtt:publish: emoji must be a non-negative integer');
  }
  if (a.replyId != null) {
    const replyId = Number(a.replyId);
    if (!Number.isFinite(replyId) || replyId < 0)
      throw new Error('mqtt:publish: replyId must be a non-negative integer');
  }
  if (typeof a.publishJsonMirror !== 'boolean') {
    throw new Error('mqtt:publish: publishJsonMirror must be a boolean');
  }
  validateOptionalPskBase64(a.pskBase64, 'mqtt:publish');
}

function validateMqttPublishProxyArgs(args: unknown): void {
  if (!args || typeof args !== 'object') {
    throw new Error('mqtt:publishProxy: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.topic !== 'string' || !a.topic.trim()) {
    throw new Error('mqtt:publishProxy: topic must be a non-empty string');
  }
  if (a.topic.length > 512) {
    throw new Error('mqtt:publishProxy: topic too long');
  }
  const hasData = a.data != null;
  const hasText = typeof a.text === 'string';
  if (!hasData && !hasText) {
    throw new Error('mqtt:publishProxy: data or text required');
  }
  if (hasText && (a.text as string).length > 512 * 1024) {
    throw new Error('mqtt:publishProxy: text too long');
  }
  if (hasData && !(a.data instanceof Uint8Array) && !ArrayBuffer.isView(a.data)) {
    throw new Error('mqtt:publishProxy: data must be Uint8Array');
  }
  if (hasData) {
    const dataBytes = a.data instanceof Uint8Array ? a.data : new Uint8Array(a.data as ArrayBuffer);
    if (dataBytes.byteLength > 512 * 1024) {
      throw new Error('mqtt:publishProxy: data too long');
    }
  }
  if (a.retained != null && typeof a.retained !== 'boolean') {
    throw new Error('mqtt:publishProxy: retained must be a boolean');
  }
}

function validateMqttPublishWaypointArgs(args: unknown): void {
  if (!args || typeof args !== 'object') {
    throw new Error('mqtt:publishWaypoint: args must be an object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.publishJsonMirror !== 'boolean') {
    throw new Error('mqtt:publishWaypoint: publishJsonMirror must be a boolean');
  }
  const from = Number(a.from);
  if (!Number.isFinite(from) || from <= 0) {
    throw new Error('mqtt:publishWaypoint: from must be a positive node id');
  }
  const to = Number(a.to);
  if (!Number.isFinite(to) || to < 0) {
    throw new Error('mqtt:publishWaypoint: to must be a non-negative integer');
  }
  const channel = Number(a.channel);
  if (!Number.isFinite(channel) || channel < 0) {
    throw new Error('mqtt:publishWaypoint: channel must be a non-negative integer');
  }
  if (typeof a.channelName !== 'string' || !a.channelName.trim()) {
    throw new Error('mqtt:publishWaypoint: channelName must be a non-empty string');
  }
  const wp = a.waypoint;
  if (!wp || typeof wp !== 'object') {
    throw new Error('mqtt:publishWaypoint: waypoint must be an object');
  }
  const w = wp as Record<string, unknown>;
  const id = Number(w.id);
  if (!Number.isFinite(id)) throw new Error('mqtt:publishWaypoint: waypoint.id invalid');
  const latitudeI = Number(w.latitudeI);
  const longitudeI = Number(w.longitudeI);
  if (!Number.isFinite(latitudeI) || !Number.isFinite(longitudeI)) {
    throw new Error('mqtt:publishWaypoint: waypoint latitudeI/longitudeI invalid');
  }
  if (typeof w.name !== 'string')
    throw new Error('mqtt:publishWaypoint: waypoint.name must be a string');
  if (w.name.length > 256) throw new Error('mqtt:publishWaypoint: waypoint.name too long');
  if (w.description != null && typeof w.description !== 'string') {
    throw new Error('mqtt:publishWaypoint: waypoint.description invalid');
  }
  if (typeof w.description === 'string' && w.description.length > 1024) {
    throw new Error('mqtt:publishWaypoint: waypoint.description too long');
  }
  if (w.icon != null) {
    const icon = Number(w.icon);
    if (!Number.isFinite(icon) || icon < 0)
      throw new Error('mqtt:publishWaypoint: waypoint.icon invalid');
  }
  if (w.lockedTo != null) {
    const lt = Number(w.lockedTo);
    if (!Number.isFinite(lt) || lt < 0)
      throw new Error('mqtt:publishWaypoint: waypoint.lockedTo invalid');
  }
  if (w.expire != null) {
    const ex = Number(w.expire);
    if (!Number.isFinite(ex) || ex < 0)
      throw new Error('mqtt:publishWaypoint: waypoint.expire invalid');
  }
  validateOptionalPskBase64(a.pskBase64, 'mqtt:publishWaypoint');
}

const MQTT_MESHCORE_TOKEN_MAX_LENGTH = 8192;

export interface MqttIpcDeps {
  mqttManager: MQTTManager;
  meshcoreMqttAdapter: MeshcoreMqttAdapter;
  getMainWindow: () => RendererPushTarget | null;
  /** MQTT node updates also feed the TAK bridge when it is running. */
  getTakServerManager: () => Pick<TakServerManager, 'onNodeUpdate'> | null;
  /**
   * Headless: stores Meshtastic MQTT chat / node updates while no browser tab is attached
   * (`meshtastic-backend/mqttRecords.ts`). Gets every event; it checks presence itself.
   */
  meshtasticBackground?: {
    message: (message: unknown) => void;
    nodeUpdate: (update: unknown) => void;
  };
  /**
   * Headless shared viewing: every browser tab auto-connects MQTT when it opens. With this set, a
   * connect with the same settings as the live (or connecting) connection keeps it and re-sends
   * its status to the tabs, instead of reconnecting the broker for everyone.
   */
  reuseSameConnection?: boolean;
}

/** Forward MQTT client events and register `mqtt:*`. Channel name literals keep check:ipc-contract aligned. */
export function registerMqttIpcHandlers(deps: MqttIpcDeps): void {
  const { mqttManager, meshcoreMqttAdapter } = deps;
  /** Settings of the last connect per protocol (in memory only), for `reuseSameConnection`. */
  const lastConnectKey: Partial<Record<'meshtastic' | 'meshcore', string>> = {};

  mqttManager.on('status', (s: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:status', { status: s, protocol: 'meshtastic' });
    else console.debug('[main] mqtt:status dropped (mainWindow not ready)', sanitizeLogMessage(s));
  });
  mqttManager.on('error', (msg: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:error', { error: msg, protocol: 'meshtastic' });
    else console.debug('[main] mqtt:error dropped (mainWindow not ready)', sanitizeLogMessage(msg));
  });
  mqttManager.on('clientId', (id: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:clientId', { clientId: id, protocol: 'meshtastic' });
    else
      console.debug('[main] mqtt:clientId dropped (mainWindow not ready)', sanitizeLogMessage(id));
  });
  mqttManager.on('nodeUpdate', (n: CachedNode) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:node-update', { ...n, protocol: 'meshtastic' as const });
    else console.debug('[main] mqtt:node-update dropped (mainWindow not ready)');
    deps.meshtasticBackground?.nodeUpdate({ ...n, protocol: 'meshtastic' as const });
    deps.getTakServerManager()?.onNodeUpdate({
      ...n,
      altitude: n.altitude ?? undefined,
      protocol: 'meshtastic',
      source: 'mqtt',
    });
  });
  mqttManager.on(
    'traceRouteReply',
    (p: { meshFrom: number; route: number[]; routeBack: number[] }) => {
      const mainWindow = deps.getMainWindow();
      if (mainWindow)
        mainWindow.webContents.send('mqtt:trace-route-reply', {
          ...p,
          protocol: 'meshtastic' as const,
        });
      else console.debug('[main] mqtt:trace-route-reply dropped (mainWindow not ready)');
    },
  );
  mqttManager.on('message', (m) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) mainWindow.webContents.send('mqtt:message', m);
    else console.debug('[main] mqtt:message dropped (mainWindow not ready)');
    deps.meshtasticBackground?.message(m);
  });
  mqttManager.on('brokerRaw', (payload: { topic: string; payload: Buffer; retained: boolean }) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('mqtt:brokerRaw', {
        topic: payload.topic,
        payload: new Uint8Array(payload.payload),
        retained: payload.retained,
      });
    } else {
      console.debug('[main] mqtt:brokerRaw dropped (mainWindow not ready)');
    }
  });

  meshcoreMqttAdapter.on('status', (s: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) mainWindow.webContents.send('mqtt:status', { status: s, protocol: 'meshcore' });
    else
      console.debug(
        '[main] mqtt:status (meshcore) dropped (mainWindow not ready)',
        sanitizeLogMessage(s),
      );
  });
  meshcoreMqttAdapter.on('error', (msg: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) mainWindow.webContents.send('mqtt:error', { error: msg, protocol: 'meshcore' });
    else
      console.debug(
        '[main] mqtt:error (meshcore) dropped (mainWindow not ready)',
        sanitizeLogMessage(msg),
      );
  });
  meshcoreMqttAdapter.on('clientId', (id: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:clientId', { clientId: id, protocol: 'meshcore' });
    else
      console.debug(
        '[main] mqtt:clientId (meshcore) dropped (mainWindow not ready)',
        sanitizeLogMessage(id),
      );
  });
  meshcoreMqttAdapter.on('subscribeWarning', (msg: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow)
      mainWindow.webContents.send('mqtt:warning', { warning: msg, protocol: 'meshcore' });
    else
      console.debug(
        '[main] mqtt:warning (meshcore) dropped (mainWindow not ready)',
        sanitizeLogMessage(msg),
      );
  });
  meshcoreMqttAdapter.on('chatMessage', (m) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) mainWindow.webContents.send('mqtt:meshcore-chat', m);
    else console.debug('[main] mqtt:meshcore-chat dropped (mainWindow not ready)');
  });

  meshcoreMqttAdapter.on(
    MeshcoreMqttAdapter.EVENT_PROACTIVE_TOKEN_REFRESH,
    (serverHost: string) => {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('mqtt:requestTokenRefresh', serverHost);
      } else {
        console.warn('[main] proactive token refresh: mainWindow not ready');
      }
    },
  );

  meshcoreMqttAdapter.on(MeshcoreMqttAdapter.EVENT_TOKEN_REFRESH_NEEDED, (serverHost: string) => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('mqtt:requestTokenRefresh', serverHost);
    } else {
      console.warn('[main] token refresh needed: mainWindow not ready');
    }
  });

  // ─── IPC: MQTT connect/disconnect ───────────────────────────────────
  ipcMain.handle('mqtt:connect', (event, settings) => {
    assertIpcSender(event, 'mqtt:connect');
    try {
      console.debug('[IPC] mqtt:connect');
      validateMqttSettings(settings);
      const s = settings as { mqttTransportProtocol?: string };
      const mode = s.mqttTransportProtocol === 'meshcore' ? 'meshcore' : 'meshtastic';
      // Dual-mode: only disconnect the target manager before reconnecting it.
      // The other manager stays connected independently.
      const mqttSettings = settings as MQTTSettings;
      const clientId = resolveMqttBrokerClientId(mode, mqttSettings);
      const settingsWithClientId: MQTTSettings = { ...mqttSettings, clientId };
      const client = mode === 'meshcore' ? meshcoreMqttAdapter : mqttManager;
      const key = JSON.stringify(settingsWithClientId);
      const status = client.getStatus();
      if (
        deps.reuseSameConnection &&
        lastConnectKey[mode] === key &&
        (status === 'connected' || status === 'connecting')
      ) {
        console.debug(`[IPC] mqtt:connect: ${mode} already ${status} with these settings; kept`);
        deps.getMainWindow()?.webContents.send('mqtt:status', { status, protocol: mode });
        return;
      }
      lastConnectKey[mode] = key;
      if (mode === 'meshcore') {
        meshcoreMqttAdapter.disconnect();
        meshcoreMqttAdapter.connect(settingsWithClientId);
      } else {
        mqttManager.disconnect();
        mqttManager.connect(settingsWithClientId);
      }
    } catch (err) {
      console.error(
        '[IPC] mqtt:connect failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:disconnect', (event, protocol?: MeshProtocol) => {
    assertIpcSender(event, 'mqtt:disconnect');
    try {
      console.debug('[IPC] mqtt:disconnect', protocol ?? 'both');
      if (!protocol || protocol === 'meshtastic') mqttManager.disconnect();
      if (!protocol || protocol === 'meshcore') meshcoreMqttAdapter.disconnect();
    } catch (err) {
      console.error(
        '[IPC] mqtt:disconnect failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:powerResume', (event) => {
    assertIpcSender(event, 'mqtt:powerResume');
    try {
      console.debug('[IPC] mqtt:powerResume');
      mqttManager.handlePowerResume();
      meshcoreMqttAdapter.handlePowerResume();
    } catch (err) {
      console.error(
        '[IPC] mqtt:powerResume failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:powerSuspend', (event) => {
    assertIpcSender(event, 'mqtt:powerSuspend');
    try {
      console.debug('[IPC] mqtt:powerSuspend');
      mqttManager.handlePowerSuspend();
      meshcoreMqttAdapter.handlePowerSuspend();
    } catch (err) {
      console.error(
        '[IPC] mqtt:powerSuspend failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:getClientId', (event, protocol?: MeshProtocol) => {
    assertIpcSender(event, 'mqtt:getClientId');
    try {
      console.debug('[IPC] mqtt:getClientId', protocol);
      if (protocol === 'meshcore') return meshcoreMqttAdapter.getClientId();
      if (protocol === 'meshtastic') return mqttManager.getClientId();
      // Fallback: return whichever is connected
      if (meshcoreMqttAdapter.getStatus() === 'connected') return meshcoreMqttAdapter.getClientId();
      return mqttManager.getClientId();
    } catch (err) {
      console.error(
        '[IPC] mqtt:getClientId failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:refreshMeshcoreToken', (event, serverHost: string) => {
    assertIpcSender(event, 'mqtt:refreshMeshcoreToken');
    try {
      console.debug('[IPC] mqtt:refreshMeshcoreToken', sanitizeLogMessage(serverHost));
      return meshcoreMqttAdapter.getTokenInfo(serverHost);
    } catch (err) {
      console.error(
        '[IPC] mqtt:refreshMeshcoreToken failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle(
    'mqtt:updateMeshcoreToken',
    (event, { token, expiresAt }: { token: string; expiresAt: number }) => {
      assertIpcSender(event, 'mqtt:updateMeshcoreToken');
      try {
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('mqtt:updateMeshcoreToken: token must be a non-empty string');
        }
        if (token.length > MQTT_MESHCORE_TOKEN_MAX_LENGTH) {
          throw new Error('mqtt:updateMeshcoreToken: token too long');
        }
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
          throw new Error('mqtt:updateMeshcoreToken: expiresAt must be a finite number');
        }
        console.debug('[IPC] mqtt:updateMeshcoreToken', expiresAt);
        meshcoreMqttAdapter.updateToken(token, expiresAt);
      } catch (err) {
        console.error(
          '[IPC] mqtt:updateMeshcoreToken failed:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
        throw err;
      }
    },
  );
  ipcMain.handle('mqtt:updateChannelKeys', (event, args) => {
    assertIpcSender(event, 'mqtt:updateChannelKeys');
    try {
      console.debug('[IPC] mqtt:updateChannelKeys');
      validateMqttUpdateChannelKeysArgs(args);
      const a = args as {
        entries: { name: string; pskBase64: string; index?: number }[];
        radioSessionId?: string;
      };
      mqttManager.updateChannelKeys(a.entries, {
        radioSessionId: a.radioSessionId,
      });
    } catch (err) {
      console.error(
        '[IPC] mqtt:updateChannelKeys failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:updateTopicPrefix', (event, args) => {
    assertIpcSender(event, 'mqtt:updateTopicPrefix');
    try {
      console.debug('[IPC] mqtt:updateTopicPrefix');
      validateMqttUpdateTopicPrefixArgs(args);
      const a = args as { topicPrefix: string };
      mqttManager.updateTopicPrefix(a.topicPrefix);
    } catch (err) {
      console.error(
        '[IPC] mqtt:updateTopicPrefix failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:publish', (event, args) => {
    assertIpcSender(event, 'mqtt:publish');
    try {
      console.debug('[IPC] mqtt:publish');
      validateMqttPublishArgs(args);
      const a = args as {
        text: string;
        from: number;
        channel: number;
        destination?: number;
        channelName?: string;
        pskBase64?: string;
        emoji?: number;
        replyId?: number;
        publishJsonMirror: boolean;
      };
      return mqttManager.publish({
        text: a.text,
        from: a.from,
        channel: a.channel,
        destination: a.destination,
        channelName: a.channelName,
        pskBase64: a.pskBase64,
        emoji: a.emoji,
        replyId: a.replyId,
        publishJsonMirror: a.publishJsonMirror,
      });
    } catch (err) {
      console.error(
        '[IPC] mqtt:publish failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:publishProxy', (event, args) => {
    assertIpcSender(event, 'mqtt:publishProxy');
    try {
      console.debug('[IPC] mqtt:publishProxy');
      validateMqttPublishProxyArgs(args);
      const a = args as {
        topic: string;
        data?: Uint8Array;
        text?: string;
        retained?: boolean;
      };
      mqttManager.publishProxyRaw({
        topic: a.topic,
        data: a.data,
        text: a.text,
        retained: a.retained,
      });
    } catch (err) {
      console.error(
        '[IPC] mqtt:publishProxy failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:publishMeshcore', (event, args) => {
    assertIpcSender(event, 'mqtt:publishMeshcore');
    try {
      console.debug('[IPC] mqtt:publishMeshcore');
      validateMqttPublishMeshcoreArgs(args);
      const a = args as {
        text: string;
        channelIdx: number;
        senderName?: string;
        senderNodeId?: number;
        timestamp?: number;
      };
      meshcoreMqttAdapter.publishChat({
        v: 1,
        text: a.text,
        channelIdx: a.channelIdx,
        senderName: a.senderName,
        senderNodeId: a.senderNodeId,
        timestamp: a.timestamp,
      });
    } catch (err) {
      console.error(
        '[IPC] mqtt:publishMeshcore failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:publishMeshcorePacketLog', (event, args) => {
    assertIpcSender(event, 'mqtt:publishMeshcorePacketLog');
    try {
      validateMqttPublishMeshcorePacketLogArgs(args);
      const a = args as {
        origin: string;
        snr: number;
        rssi: number;
        rawHex?: string;
        len?: number;
        packetType?: number;
        route?: string;
        payloadLen?: number;
        hash?: string;
        direction?: 'rx' | 'tx';
      };
      meshcoreMqttAdapter.publishPacketLog({
        origin: a.origin,
        snr: a.snr,
        rssi: a.rssi,
        rawHex: a.rawHex,
        len: a.len,
        packetType: a.packetType,
        route: a.route,
        payloadLen: a.payloadLen,
        hash: a.hash,
        direction: a.direction,
      });
    } catch (err) {
      console.error(
        '[IPC] mqtt:publishMeshcorePacketLog failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:getCachedNodes', (event) => {
    assertIpcSender(event, 'mqtt:getCachedNodes');
    try {
      return mqttManager.getCachedNodes();
    } catch (err) {
      console.error(
        '[IPC] mqtt:getCachedNodes failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:getChannelNameToIndex', (event) => {
    assertIpcSender(event, 'mqtt:getChannelNameToIndex');
    try {
      return mqttManager.getChannelNameToIndex();
    } catch (err) {
      console.error(
        '[IPC] mqtt:getChannelNameToIndex failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:publishNodeInfo', (event, args) => {
    assertIpcSender(event, 'mqtt:publishNodeInfo');
    try {
      const a = args as {
        from: number;
        longName: string;
        shortName: string;
        channelName?: string;
        hwModel?: number;
        pskBase64?: string;
        publishJsonMirror: boolean;
      };
      if (
        typeof a.from !== 'number' ||
        typeof a.longName !== 'string' ||
        typeof a.shortName !== 'string' ||
        typeof a.publishJsonMirror !== 'boolean'
      ) {
        throw new Error(
          'mqtt:publishNodeInfo requires from (number), longName (string), shortName (string), publishJsonMirror (boolean)',
        );
      }
      validateOptionalPskBase64(a.pskBase64, 'mqtt:publishNodeInfo');
      return mqttManager.publishNodeInfo(
        a.from,
        a.longName,
        a.shortName,
        a.channelName ?? 'LongFast',
        a.hwModel,
        a.publishJsonMirror,
        a.pskBase64,
      );
    } catch (err) {
      // Presence broadcast is fire-and-forget; silently ignore if MQTT just disconnected
      if (err instanceof Error && err.message === 'MQTT not connected') {
        return null;
      }
      console.error(
        '[IPC] mqtt:publishNodeInfo failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
  ipcMain.handle('mqtt:publishPosition', (event, args) => {
    assertIpcSender(event, 'mqtt:publishPosition');
    try {
      const a = args as {
        from: number;
        channel: number;
        channelName: string;
        latitudeI: number;
        longitudeI: number;
        altitude?: number;
        pskBase64?: string;
        publishJsonMirror: boolean;
      };
      if (
        typeof a.from !== 'number' ||
        typeof a.channel !== 'number' ||
        typeof a.channelName !== 'string' ||
        typeof a.latitudeI !== 'number' ||
        typeof a.longitudeI !== 'number' ||
        typeof a.publishJsonMirror !== 'boolean'
      ) {
        throw new Error(
          'mqtt:publishPosition requires from, channel, channelName, latitudeI, longitudeI, publishJsonMirror',
        );
      }
      validateOptionalPskBase64(a.pskBase64, 'mqtt:publishPosition');
      return mqttManager.publishPosition(
        a.from,
        a.channel,
        a.channelName,
        a.latitudeI,
        a.longitudeI,
        a.altitude,
        a.publishJsonMirror,
        a.pskBase64,
      );
    } catch (err) {
      console.error(
        '[IPC] mqtt:publishPosition failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('mqtt:publishWaypoint', (event, args) => {
    assertIpcSender(event, 'mqtt:publishWaypoint');
    try {
      console.debug('[IPC] mqtt:publishWaypoint');
      validateMqttPublishWaypointArgs(args);
      const a = args as {
        from: number;
        to: number;
        channel: number;
        channelName: string;
        pskBase64?: string;
        publishJsonMirror: boolean;
        waypoint: {
          id: number;
          latitudeI: number;
          longitudeI: number;
          name: string;
          description?: string;
          icon?: number;
          lockedTo?: number;
          expire?: number;
        };
      };
      return mqttManager.publishWaypoint(
        a.from,
        a.to,
        a.channel,
        a.channelName,
        a.waypoint,
        a.publishJsonMirror,
        a.pskBase64,
      );
    } catch (err) {
      console.error(
        '[IPC] mqtt:publishWaypoint failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });
}
