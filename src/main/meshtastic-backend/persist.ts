/**
 * Main-process sink for Meshtastic background-ingest records. Each kind goes through the same
 * validation and SQL as the renderer's IPC write (`db:saveMessage`, `db:saveNode`,
 * `db:savePositionHistory`, `db:saveEnvironmentTelemetry`) plus the renderer-side rules those
 * writes rely on. Skips quietly while the database is closed.
 *
 * The database handle and the shared SQL row helpers are injected
 * ({@link MeshtasticBackendPersistDb}, built by `mainPersist.ts`): this module also ships in the
 * lazily loaded desktop host bundle, which must not carry its own copy of the database module.
 *
 * A copy of a stored message from the other transport (RF vs MQTT, same sender and packet id) is
 * marked `received_via = 'both'`, and MQTT never demotes a node the radio heard from `rf`.
 *
 * Replies get the same stored preview (parent text and sender) the renderer adds on receive
 * (`enrichMeshtasticReplyPreviews`), looked up in SQLite instead of the in-memory thread, so a
 * reply to a message older than what a tab keeps loaded still shows its quote.
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
import { insertEnvironmentTelemetryOn } from '../environment-telemetry-db';
import { validateSaveMessage, validateSaveNode } from '../ipc/db-ipc-validation';
import type {
  insertMeshtasticMessageRow,
  insertPositionHistoryRow,
  upsertMeshtasticNodeRow,
} from '../ipc/db-meshtastic-handlers';
import type { MeshtasticBackendRecord } from './meshtasticBackendRecords';

/** Main-process database access, injected (see the module comment). */
export interface MeshtasticBackendPersistDb {
  /** The open database, or `null` while it is closed (records are then skipped). */
  getDb: () => NodeSqliteDB | null;
  insertMessage: typeof insertMeshtasticMessageRow;
  upsertNode: typeof upsertMeshtasticNodeRow;
  insertPosition: typeof insertPositionHistoryRow;
}

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

/** Same as the renderer's `REPLY_PREVIEW_MAX_LEN` (`replyPreview.ts`). */
export const MESHTASTIC_REPLY_PREVIEW_MAX_LEN = 50;
/** Packet ids are per-sender counters; a handful of collisions is the realistic worst case. */
const REPLY_PARENT_CANDIDATES = 32;

interface ReplyParentRow {
  sender_id: number;
  sender_name: string | null;
  payload: string;
  channel: number;
  to_node: number | null;
  timestamp: number;
}

export interface MeshtasticReplyLookup {
  replyId: number;
  senderId: number;
  channel: number;
  to?: number;
  timestamp: number;
}

/**
 * The stored parent of a reply, by the renderer's rules (`findMeshtasticParentMessageForReply`):
 * same packet id; prefer the same thread (channel broadcast, or the DM pair) and someone other
 * than the reply's author; never newer than the reply; the latest of what is left.
 */
export function findMeshtasticReplyParent(
  db: NodeSqliteDB,
  reply: MeshtasticReplyLookup,
): { text: string; sender: string } | null {
  const candidates = db
    .prepareOnce(
      'SELECT sender_id, sender_name, payload, channel, to_node, timestamp FROM messages ' +
        'WHERE packet_id = ? ORDER BY timestamp ASC, id ASC LIMIT ?',
    )
    .all(reply.replyId >>> 0, REPLY_PARENT_CANDIDATES) as unknown as ReplyParentRow[];
  const inThread = candidates.filter((m) => {
    if (m.channel !== reply.channel) return false;
    if (reply.to != null) return m.to_node === reply.to || m.sender_id === reply.to;
    return m.to_node == null;
  });
  let matches = inThread.length > 0 ? inThread : candidates;
  if (matches.length > 1) {
    const others = matches.filter((m) => m.sender_id !== reply.senderId);
    if (others.length > 0) matches = others;
  }
  const parent = matches.filter((m) => m.timestamp <= reply.timestamp).at(-1);
  if (!parent) return null;
  const text =
    parent.payload.length > MESHTASTIC_REPLY_PREVIEW_MAX_LEN
      ? `${parent.payload.slice(0, MESHTASTIC_REPLY_PREVIEW_MAX_LEN)}…`
      : parent.payload;
  const sender = parent.sender_name?.trim() ?? '';
  return { text, sender: sender !== '' ? sender : `!${(parent.sender_id >>> 0).toString(16)}` };
}

function persistMessage(sql: MeshtasticBackendPersistDb, db: NodeSqliteDB, row: unknown): boolean {
  validateSaveMessage(row);
  if (isMeshtasticSenderBlocked(db, row.sender_id)) return false;
  // Tapbacks carry a reply id too, but show no quote (the renderer skips them as well).
  if (row.replyId != null && row.emoji == null && row.replyPreviewText == null) {
    const parent = findMeshtasticReplyParent(db, {
      replyId: row.replyId,
      senderId: row.sender_id,
      channel: row.channel,
      ...(row.to != null ? { to: row.to } : {}),
      timestamp: row.timestamp,
    });
    if (parent) {
      row.replyPreviewText = parent.text;
      row.replyPreviewSender = parent.sender;
    }
  }
  if (sql.insertMessage(db, row).changes > 0) return true;
  // Same sender + packet id already stored: the other transport's copy. Renderer parity
  // (`db:updateMessageReceivedVia`): mark it heard both ways instead of storing it twice.
  if (row.packetId == null || (row.receivedVia !== 'rf' && row.receivedVia !== 'mqtt')) {
    return false;
  }
  return (
    db
      .prepareOnce(
        "UPDATE messages SET received_via = 'both' WHERE sender_id = ? AND packet_id = ? " +
          "AND received_via IN ('rf', 'mqtt') AND received_via != ?",
      )
      .run(row.sender_id >>> 0, row.packetId >>> 0, row.receivedVia).changes > 0
  );
}

/** Renderer parity: last-heard only moves forward (`mergeMeshtasticLivePacketLastHeard`). */
function persistNode(sql: MeshtasticBackendPersistDb, db: NodeSqliteDB, node: unknown): boolean {
  validateSaveNode(node);
  const stored = db
    .prepareOnce('SELECT last_heard, source FROM nodes WHERE node_id = ?')
    .get(node.node_id) as { last_heard: number | null; source: string | null } | undefined;
  if (
    typeof node.last_heard === 'number' &&
    (stored?.last_heard ?? 0) >= normalizeLastHeardToUnixSec(node.last_heard)
  ) {
    delete node.last_heard;
  }
  // Renderer parity: a node the radio has heard stays an RF node when MQTT also reports it.
  if (node.source === 'mqtt' && stored?.source === 'rf') node.source = 'rf';
  return sql.upsertNode(db, node).changes > 0;
}

/** A point is kept only when the node moved at least 10 m from its last stored point. */
function persistPosition(
  sql: MeshtasticBackendPersistDb,
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
  sql.insertPosition(db, nodeId >>> 0, latitude, longitude, recordedAt, record.source ?? 'rf');
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
    record.source ?? 'rf',
  );
  return true;
}

/**
 * The sink: stores one record and returns true when the database changed. Throws on invalid
 * input (the ingest logs it and keeps going).
 */
export function createMeshtasticBackendPersist(
  sql: MeshtasticBackendPersistDb,
): (record: MeshtasticBackendRecord) => boolean {
  return (record) => {
    const db = sql.getDb();
    if (!db) return false;
    switch (record.kind) {
      case 'message':
        return persistMessage(sql, db, record.row);
      case 'node':
        return persistNode(sql, db, { ...record.node });
      case 'position':
        return persistPosition(sql, db, record);
      case 'environment':
        return persistEnvironment(db, record);
      default:
        throw new Error('meshtastic-backend: unknown record kind');
    }
  };
}
