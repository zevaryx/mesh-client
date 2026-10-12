/**
 * Meshtastic MQTT traffic stored while no renderer is attached (headless server).
 *
 * The MQTT client lives in the main process and keeps running after the last tab closes; its
 * chat and node events normally go to the renderer, which stores them. With no renderer this
 * maps them onto the same background-ingest records, mirroring `useMeshtasticRuntime`'s
 * `mqtt.onMessage` / `mqtt.onNodeUpdate` handlers:
 *
 * - chat: normalized like the renderer (`normalizeMeshtasticMqttChatMessage`), stored with
 *   `receivedVia: 'mqtt'`, plus a last-heard bump for the sender. A copy the radio already stored
 *   (same sender + packet id) is upgraded to `both` by the sink instead of inserted twice.
 * - nodes: names, hardware, role, hops, position, battery and radio stats as a patch with
 *   `via_mqtt`; the sink keeps `source = 'rf'` for nodes the radio has heard. MQTT SNR / RSSI
 *   are not stored (they describe the uplinking gateway's radio, not ours).
 *
 * Not mirrored: the renderer's in-memory cross-transport and Store & Forward content dedup
 * (they need the loaded thread; the packet-id rule covers the copies that share an id), and
 * diagnostics / neighbor info, which have no table.
 */
import { validateCoords } from '../../renderer/lib/coordUtils';
import { normalizeMeshtasticMqttChatMessage } from '../../renderer/lib/meshtastic/meshtasticMqttChatNormalize';
import {
  environmentReadingFromNodePatch,
  takeEnvironmentNodeUpdateMarker,
} from '../../shared/environmentTelemetry';
import {
  meshtasticShortNameAfterClearingDefault,
  preferNonEmptyTrimmedString,
} from '../../shared/nodeNameUtils';
import type { MeshtasticBackendMessageRow } from './meshtasticBackendIngest';
import type {
  MeshtasticBackendNodePatch,
  MeshtasticBackendRecord,
} from './meshtasticBackendRecords';

export interface MeshtasticChannelIdentity {
  channelKey?: string;
  radioNodeId?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mqttNodePatch(nodeId: number, fields: Partial<MeshtasticBackendNodePatch>) {
  const node: MeshtasticBackendNodePatch = { node_id: nodeId, source: 'mqtt', via_mqtt: true };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = value;
  }
  return { kind: 'node' as const, node };
}

/** One `mqtt:message` chat payload. `identity` maps its channel index onto the radio's channel. */
export function recordsForMqttMessage(
  raw: unknown,
  identity: (channelIndex: number) => MeshtasticChannelIdentity,
): MeshtasticBackendRecord[] {
  const msg = normalizeMeshtasticMqttChatMessage(raw);
  if (!msg) return [];
  const packetId = finiteNumber(msg.packetId);
  const isChannel = msg.to == null;
  const { channelKey, radioNodeId } = identity(msg.channel);
  const row: MeshtasticBackendMessageRow = {
    sender_id: msg.sender_id,
    sender_name: msg.sender_name,
    payload: msg.payload,
    channel: msg.channel,
    timestamp: msg.timestamp,
    ...(packetId != null && packetId >>> 0 !== 0 ? { packetId: packetId >>> 0 } : {}),
    ...(msg.to != null ? { to: msg.to } : {}),
    ...(msg.emoji != null ? { emoji: msg.emoji } : {}),
    ...(msg.replyId != null ? { replyId: msg.replyId } : {}),
    ...(msg.rxHops != null ? { rxHops: msg.rxHops } : {}),
    receivedVia: 'mqtt',
    ...(msg.viaStoreForward ? { viaStoreForward: true } : {}),
    ...(radioNodeId != null ? { radioNodeId } : {}),
    ...(isChannel && channelKey ? { channelKey } : {}),
  };
  return [mqttNodePatch(msg.sender_id, { last_heard: msg.timestamp }), { kind: 'message', row }];
}

/** One `mqtt:node-update` patch (Meshtastic only; MeshCore patches are skipped). */
export function recordsForMqttNodeUpdate(
  raw: unknown,
  now = Date.now(),
): MeshtasticBackendRecord[] {
  if (typeof raw !== 'object' || raw === null) return [];
  // Copy: the marker is removed from the patch, and the caller's object may still be sent on.
  const update = { ...(raw as Record<string, unknown>) };
  const recordedAt = takeEnvironmentNodeUpdateMarker(update);
  if (update.protocol != null && update.protocol !== 'meshtastic') return [];
  const nodeId = finiteNumber(update.node_id);
  if (nodeId == null || nodeId <= 0) return [];
  const lastHeard = finiteNumber(update.last_heard) ?? now;
  const longName = preferNonEmptyTrimmedString(
    typeof update.long_name === 'string' ? update.long_name : undefined,
    '',
    { nodeId },
  );
  const shortName = meshtasticShortNameAfterClearingDefault(
    longName,
    preferNonEmptyTrimmedString(
      typeof update.short_name === 'string' ? update.short_name : undefined,
      '',
    ),
    nodeId,
  );
  const latitude = finiteNumber(update.latitude);
  const longitude = finiteNumber(update.longitude);
  const hasFix = latitude != null && longitude != null && validateCoords(latitude, longitude).valid;
  const records: MeshtasticBackendRecord[] = [
    mqttNodePatch(nodeId, {
      long_name: longName || undefined,
      short_name: shortName || undefined,
      hw_model: typeof update.hw_model === 'string' ? update.hw_model : undefined,
      role: finiteNumber(update.role),
      hops_away: finiteNumber(update.hops) ?? finiteNumber(update.hops_away),
      last_heard: lastHeard,
      battery: finiteNumber(update.battery),
      voltage: finiteNumber(update.voltage),
      channel_utilization: finiteNumber(update.channel_utilization),
      air_util_tx: finiteNumber(update.air_util_tx),
      ...(hasFix ? { latitude, longitude, altitude: finiteNumber(update.altitude) } : {}),
    }),
  ];
  if (hasFix) {
    records.push({
      kind: 'position',
      nodeId,
      latitude,
      longitude,
      recordedAt: lastHeard,
      source: 'mqtt',
    });
  }
  if (recordedAt != null) {
    const reading = environmentReadingFromNodePatch(update);
    if (reading) records.push({ kind: 'environment', nodeId, recordedAt, reading, source: 'mqtt' });
  }
  return records;
}

export interface MeshtasticMqttBackgroundDeps {
  /** True while a renderer is attached (it stores MQTT traffic itself). */
  isRendererPresent: () => boolean;
  persist: (record: MeshtasticBackendRecord) => void;
  /** The connected radio's channel identity, when a radio link is up. */
  channelIdentity?: (channelIndex: number) => MeshtasticChannelIdentity;
}

/**
 * Event sink for `registerMqttIpcHandlers`. Failure behavior: a record that fails to store is
 * logged and skipped; the MQTT client keeps running.
 */
export function createMeshtasticMqttBackground(deps: MeshtasticMqttBackgroundDeps): {
  message: (message: unknown) => void;
  nodeUpdate: (update: unknown) => void;
} {
  const store = (records: MeshtasticBackendRecord[]): void => {
    for (const record of records) {
      try {
        deps.persist(record);
      } catch (err) {
        console.warn(`[meshtastic-backend] persist MQTT ${record.kind} failed`, err);
      }
    }
  };
  return {
    message: (message) => {
      if (deps.isRendererPresent()) return;
      store(recordsForMqttMessage(message, (index) => deps.channelIdentity?.(index) ?? {}));
    },
    nodeUpdate: (update) => {
      if (deps.isRendererPresent()) return;
      store(recordsForMqttNodeUpdate(update));
    },
  };
}
