/**
 * Main-process sink for Meshtastic background-ingest records. Each kind goes through the same
 * validation and SQL as the renderer's IPC write (`db:saveMessage`, `db:saveNode`,
 * `db:savePositionHistory`, `db:saveEnvironmentTelemetry`) plus the renderer-side rules those
 * writes rely on. Skips quietly while the database is closed.
 *
 * Blocked senders are dropped here, matching `PacketRouter` (a fully blocked LoRa sender is
 * never stored). The check reads `blocked_contacts` per row, so a block made in any tab applies
 * immediately, also in the desktop utilityProcess host, which has no database of its own.
 */
import { haversineDistanceKm } from '../../renderer/lib/nodeStatus';
import { LORA_BLOCKLIST_SCOPE_ID, normalizeBlockedHash } from '../../shared/blockedContactHash';
import { sanitizeEnvironmentReading } from '../../shared/environmentTelemetry';
import { normalizeLastHeardToUnixSec } from '../../shared/lastHeardUnits';
import type { NodeSqliteDB } from '../db-compat';
import { getDbForIpc } from '../db-ipc-lifecycle';
import { insertEnvironmentTelemetryOn } from '../environment-telemetry-db';
import { validateSaveMessage, validateSaveNode } from '../ipc/db-ipc-validation';
import {
  insertMeshtasticMessageRow,
  insertPositionHistoryRow,
  upsertMeshtasticNodeRow,
} from '../ipc/db-meshtastic-handlers';
import type { MeshtasticBackendRecord } from './meshtasticBackendRecords';

/** Same jitter filter as the renderer's position history (`positionHistoryStore.ts`). */
export const POSITION_HISTORY_MIN_MOVE_KM = 0.01;

export function isMeshtasticSenderBlocked(db: NodeSqliteDB, nodeNum: number): boolean {
  const row = db
    .prepareOnce(
      'SELECT 1 FROM blocked_contacts WHERE protocol = ? AND identity_id = ? AND blocked_hash = ? LIMIT 1',
    )
    .get('meshtastic', LORA_BLOCKLIST_SCOPE_ID, normalizeBlockedHash(String(nodeNum >>> 0)));
  return row !== undefined;
}

function persistMessage(db: NodeSqliteDB, row: unknown): boolean {
  validateSaveMessage(row);
  if (isMeshtasticSenderBlocked(db, row.sender_id)) return false;
  return insertMeshtasticMessageRow(db, row).changes > 0;
}

/** Renderer parity: last-heard only moves forward (`mergeMeshtasticLivePacketLastHeard`). */
function persistNode(db: NodeSqliteDB, node: unknown): boolean {
  validateSaveNode(node);
  if (typeof node.last_heard === 'number') {
    const stored = db
      .prepareOnce('SELECT last_heard FROM nodes WHERE node_id = ?')
      .get(node.node_id) as { last_heard: number | null } | undefined;
    if ((stored?.last_heard ?? 0) >= normalizeLastHeardToUnixSec(node.last_heard)) {
      delete node.last_heard;
    }
  }
  return upsertMeshtasticNodeRow(db, node).changes > 0;
}

/** A point is kept only when the node moved at least 10 m from its last stored point. */
function persistPosition(
  db: NodeSqliteDB,
  record: Extract<MeshtasticBackendRecord, { kind: 'position' }>,
): boolean {
  const { nodeId, latitude, longitude, recordedAt } = record;
  if (![nodeId, latitude, longitude, recordedAt].every(Number.isFinite)) return false;
  const last = db
    .prepareOnce(
      'SELECT latitude, longitude FROM position_history WHERE node_id = ? ORDER BY recorded_at DESC LIMIT 1',
    )
    .get(nodeId >>> 0) as { latitude: number; longitude: number } | undefined;
  if (
    last &&
    haversineDistanceKm(last.latitude, last.longitude, latitude, longitude) <
      POSITION_HISTORY_MIN_MOVE_KM
  ) {
    return false;
  }
  insertPositionHistoryRow(db, nodeId >>> 0, latitude, longitude, recordedAt, 'rf');
  return true;
}

function persistEnvironment(
  db: NodeSqliteDB,
  record: Extract<MeshtasticBackendRecord, { kind: 'environment' }>,
): boolean {
  const reading = sanitizeEnvironmentReading(record.reading);
  const nodeId = record.nodeId >>> 0;
  if (!reading || nodeId === 0 || !Number.isFinite(record.recordedAt)) return false;
  insertEnvironmentTelemetryOn(
    db,
    'meshtastic',
    nodeId,
    Math.floor(record.recordedAt),
    reading,
    'rf',
  );
  return true;
}

/** Store one record. Returns true when the database changed. Throws on invalid input. */
export function persistMeshtasticBackendRecord(record: MeshtasticBackendRecord): boolean {
  const db = getDbForIpc('meshtastic-backend:persist');
  if (!db) return false;
  switch (record.kind) {
    case 'message':
      return persistMessage(db, record.row);
    case 'node':
      return persistNode(db, { ...record.node });
    case 'position':
      return persistPosition(db, record);
    case 'environment':
      return persistEnvironment(db, record);
    default:
      throw new Error('meshtastic-backend: unknown record kind');
  }
}
