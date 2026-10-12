/**
 * What the Meshtastic background ingest stores, and how live node events map onto it.
 *
 * Mirrors the renderer's live-packet paths in `meshtasticNodeSideEffects.ts` (UserPacket,
 * Position, Telemetry) and the chat-sender bump in `meshtasticIngest.ts`. NodeDB replay is not
 * mirrored: the radio only sends it during config, and config only runs when a renderer connects,
 * so the renderer handles it. Node rows are partial patches; `upsertMeshtasticNodeRow` keeps the
 * stored value for every field a patch leaves out.
 */
import { validateCoords } from '../../renderer/lib/coordUtils';
import type {
  NodeInfoEvent,
  PositionEvent,
  TelemetryEvent,
} from '../../renderer/lib/protocols/Protocol';
import {
  type EnvironmentReading,
  sanitizeEnvironmentReading,
} from '../../shared/environmentTelemetry';
import {
  meshtasticShortNameAfterClearingDefault,
  preferNonEmptyTrimmedString,
} from '../../shared/nodeNameUtils';
import type { MeshtasticBackendMessageRow } from './meshtasticBackendIngest';

/** `db:saveNode` patch. `last_heard` is ms; the sink keeps the newer of stored and patch. */
export interface MeshtasticBackendNodePatch {
  node_id: number;
  long_name?: string;
  short_name?: string;
  hw_model?: string;
  role?: number;
  public_key_hex?: string;
  last_heard?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  battery?: number;
  channel_utilization?: number;
  air_util_tx?: number;
  num_packets_rx_bad?: number;
  num_rx_dupe?: number;
  num_packets_rx?: number;
  num_packets_tx?: number;
  source: 'rf';
  via_mqtt: false;
}

export type MeshtasticBackendRecord =
  | { kind: 'message'; row: MeshtasticBackendMessageRow }
  | { kind: 'node'; node: MeshtasticBackendNodePatch }
  /** Position-history point; the sink applies the renderer's 10 m movement threshold. */
  | { kind: 'position'; nodeId: number; latitude: number; longitude: number; recordedAt: number }
  | { kind: 'environment'; nodeId: number; recordedAt: number; reading: EnvironmentReading };

function nodePatch(nodeId: number, fields: Partial<MeshtasticBackendNodePatch>) {
  const node: MeshtasticBackendNodePatch = { node_id: nodeId, source: 'rf', via_mqtt: false };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (node as unknown as Record<string, unknown>)[key] = value;
  }
  return { kind: 'node' as const, node };
}

function publicKeyHex(bytes: Uint8Array | undefined): string | undefined {
  if (bytes?.length !== 32) return undefined;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Live UserPacket (NODEINFO_APP): names, hardware, role, public key. */
export function recordsForUserPacket(info: NodeInfoEvent): MeshtasticBackendRecord[] {
  const nodeId = info.nodeId;
  const longName = preferNonEmptyTrimmedString(info.longName, '', { nodeId });
  const shortName = meshtasticShortNameAfterClearingDefault(
    longName,
    preferNonEmptyTrimmedString(info.shortName, ''),
    nodeId,
  );
  return [
    nodePatch(nodeId, {
      long_name: longName || undefined,
      short_name: shortName || undefined,
      hw_model: info.hwModel,
      role: info.role,
      public_key_hex: publicKeyHex(info.publicKey),
      last_heard: info.lastHeardAt != null && info.lastHeardAt > 0 ? info.lastHeardAt : undefined,
    }),
  ];
}

/**
 * Live position. Invalid fixes only bump last-heard. The connected radio's own position is left
 * to the renderer, which may pin a static GPS location over it.
 */
export function recordsForPosition(
  position: PositionEvent,
  myNodeNum: number,
): MeshtasticBackendRecord[] {
  const nodeId = position.nodeId;
  const isSelf = myNodeNum !== 0 && nodeId === myNodeNum;
  if (!validateCoords(position.latitude, position.longitude).valid) {
    return isSelf ? [] : [nodePatch(nodeId, { last_heard: position.timestamp })];
  }
  if (isSelf) return [];
  return [
    nodePatch(nodeId, {
      latitude: position.latitude,
      longitude: position.longitude,
      altitude: position.altitude,
      last_heard: position.timestamp,
    }),
    {
      kind: 'position',
      nodeId,
      latitude: position.latitude,
      longitude: position.longitude,
      recordedAt: position.timestamp,
    },
  ];
}

/** Live telemetry: environment readings, the radio's own stats, or device battery. */
export function recordsForTelemetry(
  telemetry: TelemetryEvent,
  myNodeNum: number,
): MeshtasticBackendRecord[] {
  const nodeId = telemetry.nodeId;
  switch (telemetry.variantCase) {
    case undefined:
      return [];
    case 'environmentMetrics':
    case 'airQualityMetrics': {
      const reading = sanitizeEnvironmentReading(telemetry);
      return [
        nodePatch(nodeId, { last_heard: telemetry.timestamp }),
        ...(reading
          ? [{ kind: 'environment' as const, nodeId, recordedAt: telemetry.timestamp, reading }]
          : []),
      ];
    }
    case 'localStats':
      if (nodeId !== myNodeNum) break;
      return [
        nodePatch(nodeId, {
          channel_utilization: telemetry.channelUtilization,
          air_util_tx: telemetry.airUtilTx,
          num_packets_rx_bad: telemetry.numPacketsRxBad,
          num_rx_dupe: telemetry.numRxDupe,
          num_packets_rx: telemetry.numPacketsRx,
          num_packets_tx: telemetry.numPacketsTx,
        }),
      ];
    default:
      break;
  }
  if (telemetry.batteryLevel == null || !nodeId) return [];
  return [nodePatch(nodeId, { battery: telemetry.batteryLevel, last_heard: telemetry.timestamp })];
}

/** A chat sender is heard: make sure its node row exists and bump last-heard. */
export function recordsForChatSender(from: number, timestamp: number): MeshtasticBackendRecord[] {
  return from > 0 ? [nodePatch(from, { last_heard: timestamp })] : [];
}
