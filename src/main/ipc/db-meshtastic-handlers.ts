/**
 * Meshtastic SQLite IPC (`db:*`: messages, nodes, notes, positions, retention/pruning).
 *
 * Moved verbatim from `src/main/index.ts`; registered by the Electron main process and the
 * headless server. Writes go through `getDbForIpc` / `finishDbIpcHandler` (db-ipc-lifecycle).
 */
import { app, ipcMain } from 'electron';

import { isChannelIdentityKey } from '../../shared/channelIdentityKey';
import { clampQueryLimit } from '../../shared/clampQueryLimit';
import { NODES_LAST_HEARD_SEC_SQL, normalizeLastHeardToUnixSec } from '../../shared/lastHeardUnits';
import { sanitizeUnicodeReactionScalar } from '../../shared/reactionEmoji';
import {
  backfillChannelKeys,
  type ChannelKeyBackfillEntry,
  clearMeshtasticMessagesByChannel,
} from '../channelIdentityDb';
import {
  deleteNodesBySource,
  deleteNodesWithoutLongname,
  migrateRfStubNodes,
  prunePositionHistory,
  prunePositionHistoryPerNode,
  sanitizeExemptNodeIdsArg,
  searchMessages,
  upsertNodePath,
} from '../database';
import type { NodeSqliteDB } from '../db-compat';
import { finishDbIpcHandler, finishDbIpcReadHandler, getDbForIpc } from '../db-ipc-lifecycle';
import { listMeshtasticDmPeersFromDb } from '../listDmPeers';
import { sanitizeLogMessage } from '../log-service';
import { decodePathPayload, isPathPacket } from '../meshcore-path-decoder';
import {
  meshtasticNodePublicKeyHexOrNull,
  migrateMeshtasticNodeNumInDb,
} from '../meshtasticNodeRenumber';
import {
  insertRendererMemorySample,
  summarizeRendererMemorySamples,
} from '../renderer-memory-samples';
import { errorMessageText } from '../sanitize-log-message';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';
import {
  capStatusString,
  DB_SAVE_NODE_PATH_MAX_BYTES,
  safeMeshcoreRadioNodeId,
  safeNonNegativeInt,
  safeNonNegativeSafeInteger,
  type SaveMessageInput,
  validateSaveMessage,
  validateSaveNode,
} from './db-ipc-validation';

/**
 * `INSERT OR IGNORE` one Meshtastic chat row (dedup: `idx_msg_packet_dedup` on sender + packet id).
 * Shared by `db:saveMessage` and the main-process background ingest; callers validate first.
 */
export function insertMeshtasticMessageRow(db: NodeSqliteDB, message: SaveMessageInput) {
  const stmt = db.prepareOnce(`
      INSERT OR IGNORE INTO messages (sender_id, sender_name, payload, channel, timestamp, packet_id, status, error, emoji, reply_id, to_node, mqtt_status, received_via, reply_preview_text, reply_preview_sender, rx_hops, via_store_forward, radio_node_id, channel_key)
      VALUES (@sender_id, @sender_name, @payload, @channel, @timestamp, @packet_id, @status, @error, @emoji, @reply_id, @to_node, @mqtt_status, @received_via, @reply_preview_text, @reply_preview_sender, @rx_hops, @via_store_forward, @radio_node_id, @channel_key)
    `);
  const radioNodeId = message.radioNodeId != null ? Number(message.radioNodeId) >>> 0 : 0;
  const validReceivedVia = ['rf', 'mqtt', 'both'];
  return stmt.run({
    sender_id: safeNonNegativeInt(message.sender_id),
    sender_name: message.sender_name,
    payload: message.payload,
    channel: safeNonNegativeInt(message.channel),
    timestamp: message.timestamp,
    packet_id: message.packetId != null ? safeNonNegativeInt(message.packetId) : null,
    status: message.status ?? 'acked',
    error: message.error ?? null,
    emoji: message.emoji != null ? (sanitizeUnicodeReactionScalar(message.emoji) ?? null) : null,
    reply_id: message.replyId != null ? safeNonNegativeInt(message.replyId) : null,
    to_node: message.to != null ? safeNonNegativeInt(message.to) : null,
    mqtt_status: message.mqttStatus ?? null,
    received_via:
      message.receivedVia != null && validReceivedVia.includes(message.receivedVia)
        ? message.receivedVia
        : null,
    reply_preview_text: message.replyPreviewText ?? null,
    reply_preview_sender: message.replyPreviewSender ?? null,
    rx_hops:
      message.rxHops != null &&
      typeof message.rxHops === 'number' &&
      Number.isFinite(message.rxHops)
        ? Math.trunc(message.rxHops)
        : null,
    via_store_forward: message.viaStoreForward ? 1 : 0,
    radio_node_id: radioNodeId > 0 ? radioNodeId : null,
    channel_key: isChannelIdentityKey(message.channelKey) ? message.channelKey : null,
  });
}

/**
 * Upsert one Meshtastic node row, merging field by field (empty / null keeps the stored value).
 * Shared by `db:saveNode` and the main-process background ingest; callers validate first.
 */
export function upsertMeshtasticNodeRow(
  db: NodeSqliteDB,
  node: Record<string, unknown> & { node_id: number },
) {
  const stmt = db.prepareOnce(`
      INSERT INTO nodes (node_id, long_name, short_name, hw_model, snr, rssi, battery, last_heard, latitude, longitude, role, hops_away, via_mqtt, voltage, channel_utilization, air_util_tx, altitude, favorited, source, num_packets_rx_bad, num_rx_dupe, num_packets_rx, num_packets_tx, hops, path, public_key)
      VALUES (@node_id, @long_name, @short_name, @hw_model, @snr, @rssi, @battery, @last_heard, @latitude, @longitude, @role, @hops_away, @via_mqtt, @voltage, @channel_utilization, @air_util_tx, @altitude,
        COALESCE((SELECT favorited FROM nodes WHERE node_id = @node_id), 0),
        @source, @num_packets_rx_bad, @num_rx_dupe, @num_packets_rx, @num_packets_tx, @hops, @path, @public_key)
      ON CONFLICT(node_id) DO UPDATE SET
        long_name = COALESCE(NULLIF(excluded.long_name, ''), nodes.long_name),
        short_name = COALESCE(NULLIF(excluded.short_name, ''), nodes.short_name),
        hw_model = COALESCE(NULLIF(excluded.hw_model, ''), nodes.hw_model),
        snr = COALESCE(excluded.snr, nodes.snr),
        rssi = COALESCE(excluded.rssi, nodes.rssi),
        battery = COALESCE(excluded.battery, nodes.battery),
        last_heard = CASE WHEN excluded.last_heard IS NOT NULL AND excluded.last_heard > 0 THEN excluded.last_heard ELSE nodes.last_heard END,
        latitude = CASE WHEN excluded.latitude IS NOT NULL AND excluded.latitude != 0 THEN excluded.latitude ELSE nodes.latitude END,
        longitude = CASE WHEN excluded.longitude IS NOT NULL AND excluded.longitude != 0 THEN excluded.longitude ELSE nodes.longitude END,
        role = COALESCE(excluded.role, nodes.role),
        hops_away = CASE
          WHEN excluded.hops_away IS NOT NULL AND (nodes.hops_away IS NULL OR excluded.hops_away < nodes.hops_away) THEN excluded.hops_away
          ELSE nodes.hops_away
        END,
        via_mqtt = COALESCE(excluded.via_mqtt, nodes.via_mqtt),
        voltage = COALESCE(excluded.voltage, nodes.voltage),
        channel_utilization = COALESCE(excluded.channel_utilization, nodes.channel_utilization),
        air_util_tx = COALESCE(excluded.air_util_tx, nodes.air_util_tx),
        altitude = COALESCE(excluded.altitude, nodes.altitude),
        source = CASE
          WHEN nodes.source = 'mqtt' AND excluded.source = 'rf' AND COALESCE(excluded.via_mqtt, 0) = 1 THEN 'mqtt'
          ELSE COALESCE(excluded.source, nodes.source, 'rf')
        END,
        num_packets_rx_bad = COALESCE(excluded.num_packets_rx_bad, num_packets_rx_bad),
        num_rx_dupe = COALESCE(excluded.num_rx_dupe, num_rx_dupe),
        num_packets_rx = COALESCE(excluded.num_packets_rx, num_packets_rx),
        num_packets_tx = COALESCE(excluded.num_packets_tx, num_packets_tx),
        hops = CASE
          WHEN excluded.hops IS NOT NULL AND (nodes.hops IS NULL OR excluded.hops < nodes.hops) THEN excluded.hops
          ELSE nodes.hops
        END,
        path = COALESCE(excluded.path, nodes.path),
        public_key = COALESCE(excluded.public_key, nodes.public_key)
    `);
  return stmt.run({
    // Every named parameter needs a value; the renderer sends full rows, background-ingest
    // patches only what a packet carried (the upsert keeps stored values for nulls).
    long_name: null,
    short_name: null,
    hw_model: null,
    snr: null,
    battery: null,
    latitude: null,
    longitude: null,
    role: null,
    hops_away: node.hops_away ?? null,
    rssi: null,
    voltage: null,
    channel_utilization: null,
    air_util_tx: null,
    altitude: null,
    source: 'rf',
    num_packets_rx_bad: null,
    num_rx_dupe: null,
    num_packets_rx: null,
    num_packets_tx: null,
    ...node,
    last_heard:
      node.last_heard != null && Number(node.last_heard) > 0
        ? normalizeLastHeardToUnixSec(Number(node.last_heard))
        : (node.last_heard ?? null),
    via_mqtt: node.via_mqtt != null ? (node.via_mqtt ? 1 : 0) : null,
    hops: node.hops ?? node.hops_away ?? null,
    path: node.path != null ? JSON.stringify(node.path) : null,
    public_key: meshtasticNodePublicKeyHexOrNull(node.public_key_hex),
  });
}

/** Append one `position_history` point (shared with the background ingest). */
export function insertPositionHistoryRow(
  db: NodeSqliteDB,
  nodeId: number,
  lat: number,
  lon: number,
  recordedAt: number,
  source: string,
): void {
  db.prepareOnce(
    'INSERT INTO position_history (node_id, latitude, longitude, recorded_at, source) VALUES (?, ?, ?, ?, ?)',
  ).run(nodeId, lat, lon, recordedAt, source);
}

/** Register the Meshtastic `db:*` handlers. Channel name literals keep check:ipc-contract aligned. */
export function registerMeshtasticDbIpcHandlers(): void {
  // ─── IPC: Database operations ──────────────────────────────────────
  ipcMain.handle('db:saveMessage', (event, message) => {
    if (!validateIpcSender(event)) throw new Error('db:saveMessage: unauthorized sender');
    try {
      validateSaveMessage(message);
      const db = getDbForIpc('db:saveMessage');
      if (!db) return { changes: 0 };
      return insertMeshtasticMessageRow(db, message);
    } catch (err) {
      finishDbIpcHandler('db:saveMessage', err);
    }
  });

  ipcMain.handle('db:getMessages', (event, channel?: number, limit = 200) => {
    if (!validateIpcSender(event)) throw new Error('db:getMessages: unauthorized sender');
    try {
      const safeLimit = clampQueryLimit(limit, { default: 1000, max: 10000 });
      const db = getDbForIpc('db:getMessages');
      if (!db) return [];
      const columns = `id, sender_id, sender_name, payload, channel, timestamp,
         packet_id AS packetId, status, error, emoji, reply_id AS replyId, to_node,
         mqtt_status AS mqttStatus, received_via AS receivedVia,
         reply_preview_text AS replyPreviewText, reply_preview_sender AS replyPreviewSender,
         rx_hops AS rxHops, via_store_forward AS viaStoreForward,
         radio_node_id AS radioNodeId, channel_key AS channelKey`;
      let rows: Record<string, unknown>[];
      if (channel != null) {
        const ch = safeNonNegativeInt(channel);
        rows = db
          .prepareOnce(
            `SELECT ${columns} FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`,
          )
          .all(ch, safeLimit) as Record<string, unknown>[];
      } else {
        rows = db
          .prepareOnce(`SELECT ${columns} FROM messages ORDER BY timestamp DESC LIMIT ?`)
          .all(safeLimit) as Record<string, unknown>[];
      }

      // Map to_node back to `to` for the renderer; drop invalid reaction scalars from legacy rows
      return rows.map((r) => {
        const { to_node, emoji: emojiRaw, viaStoreForward: viaSfRaw, ...rest } = r;
        const emoji =
          emojiRaw != null ? (sanitizeUnicodeReactionScalar(emojiRaw) ?? undefined) : undefined;
        const viaStoreForward = viaSfRaw === 1 || viaSfRaw === true;
        return {
          ...rest,
          emoji,
          to: to_node ?? undefined,
          ...(viaStoreForward ? { viaStoreForward: true } : {}),
        };
      });
    } catch (err) {
      finishDbIpcHandler('db:getMessages', err);
    }
  });

  ipcMain.handle('db:listMeshtasticDmPeers', (event, ownNodeId: unknown, limit?: unknown) => {
    try {
      assertIpcSender(event, 'db:listMeshtasticDmPeers');
      if (typeof ownNodeId !== 'number' || !Number.isFinite(ownNodeId)) return [];
      const db = getDbForIpc('db:listMeshtasticDmPeers');
      if (!db) return [];
      return listMeshtasticDmPeersFromDb(db, ownNodeId, limit);
    } catch (err) {
      return finishDbIpcReadHandler('db:listMeshtasticDmPeers', err, []);
    }
  });

  ipcMain.handle('db:saveNode', (event, node) => {
    if (!validateIpcSender(event)) throw new Error('db:saveNode: unauthorized sender');
    try {
      validateSaveNode(node);
      if (node.path != null) {
        const pathJson = JSON.stringify(node.path);
        if (pathJson.length > DB_SAVE_NODE_PATH_MAX_BYTES) {
          throw new Error('db:saveNode: path too large');
        }
      }
      const db = getDbForIpc('db:saveNode');
      if (!db) return { changes: 0 };
      return upsertMeshtasticNodeRow(db, node);
    } catch (err) {
      finishDbIpcHandler('db:saveNode', err);
    }
  });

  ipcMain.handle('db:migrateMeshtasticNodeNum', (event, oldNum, newNum, key) => {
    if (!validateIpcSender(event)) {
      throw new Error('db:migrateMeshtasticNodeNum: unauthorized sender');
    }
    try {
      const db = getDbForIpc('db:migrateMeshtasticNodeNum');
      if (!db) return { migrated: false, messagesUpdated: 0 };
      return migrateMeshtasticNodeNumInDb(db, oldNum, newNum, key);
    } catch (err) {
      finishDbIpcHandler('db:migrateMeshtasticNodeNum', err);
    }
  });

  ipcMain.handle('db:saveNodePath', (event, nodeId: number, lastHeard: number, buffer: Buffer) => {
    if (!validateIpcSender(event)) throw new Error('db:saveNodePath: unauthorized sender');
    try {
      if (!getDbForIpc('db:saveNodePath')) return undefined;
      if (!isPathPacket(buffer)) {
        throw new Error('Not a PATH packet');
      }
      const { hops, path } = decodePathPayload(buffer);
      upsertNodePath(nodeId, normalizeLastHeardToUnixSec(lastHeard), hops, path);
      return { success: true, hops, path };
    } catch (err) {
      finishDbIpcHandler('db:saveNodePath', err);
    }
  });

  ipcMain.handle('db:setNodeFavorited', (event, nodeId: number, favorited: boolean) => {
    if (!validateIpcSender(event)) throw new Error('db:setNodeFavorited: unauthorized sender');
    try {
      const id = safeNonNegativeInt(nodeId);
      if (typeof favorited !== 'boolean')
        throw new Error('db:setNodeFavorited: favorited must be a boolean');
      const db = getDbForIpc('db:setNodeFavorited');
      if (!db) return { changes: 0 };
      return db
        .prepareOnce('UPDATE nodes SET favorited = ? WHERE node_id = ?')
        .run(favorited ? 1 : 0, id);
    } catch (err) {
      finishDbIpcHandler('db:setNodeFavorited', err);
    }
  });

  ipcMain.handle('db:getNodeNote', (event, nodeId: number) => {
    try {
      assertIpcSender(event, 'db:getNodeNote');
      const id = safeNonNegativeInt(nodeId);
      const db = getDbForIpc('db:getNodeNote');
      if (!db) return null;
      const row = db.prepareOnce('SELECT notes FROM node_notes WHERE node_id = ?').get(id) as
        { notes: string } | undefined;
      return row?.notes ?? null;
    } catch (err) {
      finishDbIpcHandler('db:getNodeNote', err);
    }
  });

  ipcMain.handle('db:setNodeNote', (event, nodeId: number, note: string) => {
    if (!validateIpcSender(event)) throw new Error('db:setNodeNote: unauthorized sender');
    try {
      const id = safeNonNegativeInt(nodeId);
      if (typeof note !== 'string') throw new Error('db:setNodeNote: note must be a string');
      if (note.length > 4000) throw new Error('db:setNodeNote: note too long (max 4000 chars)');
      const db = getDbForIpc('db:setNodeNote');
      if (!db) return { changes: 0 };
      db.prepareOnce(
        'INSERT INTO node_notes (node_id, notes, updated_at) VALUES (?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at',
      ).run(id, note, Date.now());
    } catch (err) {
      finishDbIpcHandler('db:setNodeNote', err);
    }
  });

  ipcMain.handle(
    'db:recordRendererMemorySample',
    (
      event,
      sample: {
        capturedAt?: unknown;
        bytes?: unknown;
        source?: unknown;
        sessionId?: unknown;
      },
    ) => {
      if (!validateIpcSender(event)) {
        throw new Error('db:recordRendererMemorySample: unauthorized sender');
      }
      try {
        const capturedAt = safeNonNegativeSafeInteger(sample?.capturedAt);
        const bytes = safeNonNegativeSafeInteger(sample?.bytes);
        const source = sample?.source;
        if (source !== 'user-agent' && source !== 'renderer-process') {
          throw new Error('db:recordRendererMemorySample: invalid source');
        }
        const sessionId =
          typeof sample?.sessionId === 'string' && sample.sessionId.length <= 64
            ? sample.sessionId
            : null;
        const db = getDbForIpc('db:recordRendererMemorySample');
        if (!db) return;
        insertRendererMemorySample(db, {
          captured_at: capturedAt,
          bytes,
          source,
          app_version: app.getVersion(),
          session_id: sessionId,
        });
      } catch (err) {
        finishDbIpcHandler('db:recordRendererMemorySample', err);
      }
    },
  );

  ipcMain.handle('db:getRendererMemorySampleSummary', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('db:getRendererMemorySampleSummary: unauthorized sender');
    }
    try {
      const db = getDbForIpc('db:getRendererMemorySampleSummary');
      if (!db) {
        return {
          count: 0,
          firstAt: null,
          lastAt: null,
          minBytes: null,
          maxBytes: null,
          spanMs: null,
        };
      }
      return summarizeRendererMemorySamples(db);
    } catch (err) {
      finishDbIpcHandler('db:getRendererMemorySampleSummary', err);
    }
  });

  ipcMain.handle('db:getNodes', (event) => {
    try {
      assertIpcSender(event, 'db:getNodes');
      const db = getDbForIpc('db:getNodes');
      if (!db) return [];
      return db.prepareOnce('SELECT * FROM nodes ORDER BY last_heard DESC').all();
    } catch (err) {
      finishDbIpcHandler('db:getNodes', err);
    }
  });

  ipcMain.handle('db:clearMessages', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:clearMessages');
      if (!db) return { changes: 0 };
      const result = db.prepareOnce('DELETE FROM messages').run();
      console.debug(`[IPC] db:clearMessages: deleted ${result.changes} messages`);
      return result;
    } catch (err) {
      finishDbIpcHandler('db:clearMessages', err);
    }
  });

  ipcMain.handle('db:clearNodes', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:clearNodes');
      if (!db) return { changes: 0 };
      const result = db.prepareOnce('DELETE FROM nodes').run();
      console.debug(`[IPC] db:clearNodes: deleted ${result.changes} nodes`);
      return result;
    } catch (err) {
      finishDbIpcHandler('db:clearNodes', err);
    }
  });

  ipcMain.handle('db:clearNodePositions', (event) => {
    if (!validateIpcSender(event)) throw new Error('db:clearNodePositions: unauthorized sender');
    try {
      const db = getDbForIpc('db:clearNodePositions');
      if (!db) return { changes: 0 };
      const result = db
        .prepareOnce('UPDATE nodes SET latitude = NULL, longitude = NULL, altitude = NULL')
        .run();
      console.debug(`[IPC] db:clearNodePositions: cleared positions for ${result.changes} nodes`);
      return result;
    } catch (err) {
      finishDbIpcHandler('db:clearNodePositions', err);
    }
  });

  ipcMain.handle('db:deleteNode', (event, nodeId: number) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const id = safeNonNegativeInt(nodeId);
      const db = getDbForIpc('db:deleteNode');
      if (!db) return { changes: 0 };
      const result = db.prepareOnce('DELETE FROM nodes WHERE node_id = ?').run(id);
      console.debug(
        `[IPC] db:deleteNode: deleted node 0x${id.toString(16).toUpperCase()} (${result.changes} rows)`,
      );
      return result;
    } catch (err) {
      finishDbIpcHandler('db:deleteNode', err);
    }
  });

  ipcMain.handle('db:deleteNodesNeverHeard', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:deleteNodesNeverHeard');
      if (!db) return { changes: 0 };
      const result = db
        .prepareOnce(
          "DELETE FROM nodes WHERE (last_heard IS NULL OR last_heard = 0) AND (favorited IS NULL OR favorited = 0) AND source != 'meshcore'",
        )
        .run();
      if (result.changes > 0) {
        console.debug(`[IPC] db:deleteNodesNeverHeard: pruned ${result.changes} never-heard nodes`);
      }
      return result;
    } catch (err) {
      finishDbIpcHandler('db:deleteNodesNeverHeard', err);
    }
  });

  ipcMain.handle('db:deleteNodesByAge', (event, days: number) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:deleteNodesByAge');
      if (!db) return 0;
      if (typeof days !== 'number' || days < 1 || !isFinite(days)) return { changes: 0 };
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const result = db
        .prepareOnce(
          `DELETE FROM nodes WHERE (${NODES_LAST_HEARD_SEC_SQL} < ? OR last_heard IS NULL OR last_heard = 0) AND (favorited IS NULL OR favorited = 0) AND source != 'meshcore'`,
        )
        .run(cutoff);
      if (result.changes > 0) {
        console.debug(
          `[IPC] db:deleteNodesByAge: pruned ${result.changes} nodes older than ${days}d`,
        );
      }
      return result;
    } catch (err) {
      finishDbIpcHandler('db:deleteNodesByAge', err);
    }
  });

  ipcMain.handle('db:pruneNodesByCount', (event, maxCount: number) => {
    if (!validateIpcSender(event)) throw new Error('db:pruneNodesByCount: unauthorized sender');
    try {
      const db = getDbForIpc('db:pruneNodesByCount');
      if (!db) return 0;
      if (typeof maxCount !== 'number' || maxCount < 1 || !isFinite(maxCount))
        return { changes: 0 };
      const total = (db.prepareOnce('SELECT COUNT(*) as cnt FROM nodes').get() as { cnt: number })
        .cnt;
      if (total <= maxCount) return { changes: 0 };
      const deletable = (
        db
          .prepareOnce(
            'SELECT COUNT(*) as cnt FROM nodes WHERE (favorited IS NULL OR favorited = 0)',
          )
          .get() as { cnt: number }
      ).cnt;
      const toDelete = Math.min(total - maxCount, deletable);
      if (toDelete <= 0) return { changes: 0 };
      const result = db
        .prepareOnce(
          `DELETE FROM nodes
         WHERE (favorited IS NULL OR favorited = 0)
           AND node_id IN (
             SELECT node_id FROM nodes
             WHERE (favorited IS NULL OR favorited = 0)
             ORDER BY ${NODES_LAST_HEARD_SEC_SQL} ASC
             LIMIT ?
           )`,
        )
        .run(toDelete);
      if (result.changes > 0) {
        console.debug(
          `[IPC] db:pruneNodesByCount: pruned ${result.changes} nodes, keeping top ${maxCount}`,
        );
      }
      return { changes: Number(result.changes) };
    } catch (err) {
      finishDbIpcHandler('db:pruneNodesByCount', err);
    }
  });

  ipcMain.handle('db:pruneMessagesByCount', (event, maxCount: number) => {
    if (!validateIpcSender(event)) throw new Error('db:pruneMessagesByCount: unauthorized sender');
    try {
      const db = getDbForIpc('db:pruneMessagesByCount');
      if (!db) return 0;
      if (typeof maxCount !== 'number' || maxCount < 100 || !isFinite(maxCount))
        return { changes: 0 };
      const cap = Math.floor(maxCount);
      const result = db
        .prepareOnce(
          'DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY timestamp DESC, id DESC LIMIT ?)',
        )
        .run(cap);
      if (result.changes > 0) {
        console.debug(
          `[IPC] db:pruneMessagesByCount: pruned ${result.changes} messages, keeping newest ${cap}`,
        );
      }
      return { changes: Number(result.changes) };
    } catch (err) {
      finishDbIpcHandler('db:pruneMessagesByCount', err);
    }
  });

  ipcMain.handle('db:deleteNodesBatch', (event, nodeIds: number[]) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:deleteNodesBatch');
      if (!db) return 0;
      if (!Array.isArray(nodeIds) || nodeIds.length === 0) return 0;
      const safe = nodeIds
        .filter((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)
        .slice(0, 10_000);
      if (safe.length === 0) return 0;
      const placeholders = safe.map(() => '?').join(', ');
      const result = db
        .prepareOnce(`DELETE FROM nodes WHERE node_id IN (${placeholders})`)
        .run(...safe);
      console.debug(`[IPC] db:deleteNodesBatch: deleted ${result.changes} nodes`);
      return result.changes;
    } catch (err) {
      finishDbIpcHandler('db:deleteNodesBatch', err);
    }
  });

  ipcMain.handle(
    'db:backfillChannelKeys',
    (event, protocol: unknown, radioNodeId: unknown, entries: unknown) => {
      assertIpcSender(event, 'db:backfillChannelKeys');
      try {
        if (protocol !== 'meshtastic' && protocol !== 'meshcore') {
          throw new Error('db:backfillChannelKeys: protocol must be meshtastic or meshcore');
        }
        const radio = Number(radioNodeId);
        if (!Number.isSafeInteger(radio) || radio <= 0) {
          throw new Error('db:backfillChannelKeys: radioNodeId must be a positive integer');
        }
        if (!Array.isArray(entries) || entries.length > 256) {
          throw new Error('db:backfillChannelKeys: entries must be an array (max 256)');
        }
        const safeEntries: ChannelKeyBackfillEntry[] = [];
        for (const raw of entries as unknown[]) {
          const rec = raw as { index?: unknown; key?: unknown } | null;
          const index = Number(rec?.index);
          if (!Number.isInteger(index) || index < 0 || index > 255) {
            throw new Error('db:backfillChannelKeys: entry index must be 0..255');
          }
          if (!isChannelIdentityKey(rec?.key)) {
            throw new Error('db:backfillChannelKeys: entry key must be a channel identity key');
          }
          safeEntries.push({ index, key: rec.key });
        }
        const db = getDbForIpc('db:backfillChannelKeys');
        if (!db) return { changes: 0 };
        const result = backfillChannelKeys(db, protocol, radio, safeEntries);
        if (result.changes > 0) {
          console.debug(
            `[IPC] db:backfillChannelKeys: stamped ${result.changes} ${protocol} rows for radio ${radio}`,
          );
        }
        return result;
      } catch (err) {
        finishDbIpcHandler('db:backfillChannelKeys', err);
      }
    },
  );

  ipcMain.handle(
    'db:clearMessagesByChannel',
    (event, channel: number, radioNodeId?: unknown, channelKey?: unknown) => {
      if (!validateIpcSender(event)) {
        throw new Error('IPC sender validation failed');
      }
      try {
        const db = getDbForIpc('db:clearMessagesByChannel');
        if (!db) return { changes: 0 };
        const ch = safeNonNegativeInt(channel);
        const radio = radioNodeId != null ? safeMeshcoreRadioNodeId(radioNodeId) : 0;
        const result = clearMeshtasticMessagesByChannel(db, ch, radio, channelKey);
        console.debug(
          `[IPC] db:clearMessagesByChannel: deleted ${result.changes} messages for channel ${ch}`,
        );
        return result;
      } catch (err) {
        finishDbIpcHandler('db:clearMessagesByChannel', err);
      }
    },
  );

  ipcMain.handle('db:getMessageChannels', (event) => {
    try {
      assertIpcSender(event, 'db:getMessageChannels');
      const db = getDbForIpc('db:getMessageChannels');
      if (!db) return [];
      return db.prepareOnce('SELECT DISTINCT channel FROM messages ORDER BY channel').all();
    } catch (err) {
      finishDbIpcHandler('db:getMessageChannels', err);
    }
  });

  ipcMain.handle('db:deleteNodesBySource', (event, source: string) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      if (!getDbForIpc('db:deleteNodesBySource')) return 0;
      if (typeof source !== 'string')
        throw new Error('db:deleteNodesBySource: source must be a string');
      if (source.length > 64) throw new Error('db:deleteNodesBySource: source string too long');
      const changes = deleteNodesBySource(source);
      console.debug(
        `[IPC] db:deleteNodesBySource(${sanitizeLogMessage(source)}): pruned ${changes} nodes`,
      );
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:deleteNodesBySource', err);
    }
  });

  ipcMain.handle('db:migrateRfStubNodes', (event) => {
    if (!validateIpcSender(event)) throw new Error('db:migrateRfStubNodes: unauthorized sender');
    try {
      if (!getDbForIpc('db:migrateRfStubNodes')) return 0;
      const changes = migrateRfStubNodes();
      if (changes > 0) {
        console.debug(`[IPC] db:migrateRfStubNodes: renamed ${changes} RF stub nodes`);
      }
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:migrateRfStubNodes', err);
    }
  });

  ipcMain.handle('db:deleteNodesWithoutLongname', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      if (!getDbForIpc('db:deleteNodesWithoutLongname')) return 0;
      const changes = deleteNodesWithoutLongname();
      if (changes > 0) {
        console.debug(`[IPC] db:deleteNodesWithoutLongname: pruned ${changes} unnamed nodes`);
      }
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:deleteNodesWithoutLongname', err);
    }
  });

  ipcMain.handle('db:prunePositionHistory', (event, days: number, exemptNodeIds?: unknown) => {
    if (!validateIpcSender(event)) throw new Error('db:prunePositionHistory: unauthorized sender');
    try {
      if (!getDbForIpc('db:prunePositionHistory')) return 0;
      const safeDays = typeof days === 'number' && days > 0 ? Math.floor(days) : 30;
      const changes = prunePositionHistory(safeDays, sanitizeExemptNodeIdsArg(exemptNodeIds));
      if (changes > 0) {
        console.debug(
          `[IPC] db:prunePositionHistory: pruned ${changes} rows older than ${safeDays}d`,
        );
      }
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:prunePositionHistory', err);
    }
  });

  ipcMain.handle(
    'db:prunePositionHistoryPerNode',
    (event, maxPerNode: number, exemptNodeIds?: unknown) => {
      if (!validateIpcSender(event))
        throw new Error('db:prunePositionHistoryPerNode: unauthorized sender');
      try {
        if (!getDbForIpc('db:prunePositionHistoryPerNode')) return 0;
        const cap =
          typeof maxPerNode === 'number' && maxPerNode > 0 ? Math.floor(maxPerNode) : 2000;
        const changes = prunePositionHistoryPerNode(cap, sanitizeExemptNodeIdsArg(exemptNodeIds));
        if (changes > 0) {
          console.debug(
            `[IPC] db:prunePositionHistoryPerNode: pruned ${changes} rows, keeping ${cap} per node`,
          );
        }
        return changes;
      } catch (err) {
        finishDbIpcHandler('db:prunePositionHistoryPerNode', err);
      }
    },
  );

  // ─── IPC: Update message delivery status ────────────────────────────
  ipcMain.handle(
    'db:updateMessageStatus',
    (event, packetId: number, status: string, error?: string, mqttStatus?: string) => {
      if (!validateIpcSender(event)) throw new Error('db:updateMessageStatus: unauthorized sender');
      try {
        const pid = safeNonNegativeInt(packetId);
        if (typeof status !== 'string')
          throw new Error('db:updateMessageStatus: status must be a string');
        const statusSafe = capStatusString('db:updateMessageStatus: status', status)!;
        const errorSafe = capStatusString('db:updateMessageStatus: error', error);
        const db = getDbForIpc('db:updateMessageStatus');
        if (!db) return { changes: 0 };
        if (mqttStatus !== undefined) {
          if (typeof mqttStatus !== 'string')
            throw new Error('db:updateMessageStatus: mqttStatus must be a string');
          const mqttSafe = capStatusString('db:updateMessageStatus: mqttStatus', mqttStatus)!;
          return db
            .prepareOnce(
              'UPDATE messages SET status = ?, error = ?, mqtt_status = ? WHERE packet_id = ?',
            )
            .run(statusSafe, errorSafe, mqttSafe, pid);
        }
        return db
          .prepareOnce('UPDATE messages SET status = ?, error = ? WHERE packet_id = ?')
          .run(statusSafe, errorSafe, pid);
      } catch (err) {
        finishDbIpcHandler('db:updateMessageStatus', err);
      }
    },
  );

  // ─── IPC: Upgrade received_via to 'both' when packet arrives on second transport ─
  ipcMain.handle(
    'db:updateMessageReceivedVia',
    (event, packetId: number, rxHops?: number | null) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMessageReceivedVia: unauthorized sender');
      try {
        const pid = safeNonNegativeInt(packetId);
        const db = getDbForIpc('db:updateMessageReceivedVia');
        if (!db) return { changes: 0 };
        const hopBind =
          rxHops != null && typeof rxHops === 'number' && Number.isFinite(rxHops)
            ? Math.trunc(rxHops)
            : null;
        return db
          .prepareOnce(
            "UPDATE messages SET received_via = 'both', rx_hops = COALESCE(?, rx_hops) WHERE packet_id = ? AND received_via != 'both'",
          )
          .run(hopBind, pid);
      } catch (err) {
        finishDbIpcHandler('db:updateMessageReceivedVia', err);
      }
    },
  );

  /** Replace optimistic temp `packet_id` with the real mesh id from `sendText()` (tapbacks key on `reply_id`). */
  ipcMain.handle(
    'db:updateMessagePacketId',
    (event, oldPacketId: number, newPacketId: number, senderId?: number) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMessagePacketId: unauthorized sender');
      const oldPid = safeNonNegativeInt(oldPacketId);
      const newPid = safeNonNegativeInt(newPacketId);
      if (oldPid === newPid) return;
      const db = getDbForIpc('db:updateMessagePacketId');
      if (!db) return;
      const deleteByPacketId = db.prepareOnce('DELETE FROM messages WHERE packet_id = ?');
      try {
        const scopedSenderId =
          senderId != null && Number.isFinite(senderId) ? safeNonNegativeInt(senderId) : undefined;
        const updated =
          scopedSenderId != null
            ? db
                .prepareOnce(
                  'UPDATE messages SET packet_id = ? WHERE packet_id = ? AND sender_id = ?',
                )
                .run(newPid, oldPid, scopedSenderId)
            : db
                .prepareOnce('UPDATE messages SET packet_id = ? WHERE packet_id = ?')
                .run(newPid, oldPid);
        if (updated.changes > 0) return;
        // RF echo may have inserted the real packet_id before this runs; drop orphan temp row.
        deleteByPacketId.run(oldPid);
      } catch (err) {
        const msg = errorMessageText(err);
        if (msg.includes('UNIQUE constraint failed')) {
          deleteByPacketId.run(oldPid);
          return;
        }
        finishDbIpcHandler('db:updateMessagePacketId', err);
      }
    },
  );

  ipcMain.handle('db:searchMessages', (event, query: string, limit?: number) => {
    try {
      assertIpcSender(event, 'db:searchMessages');
      if (!getDbForIpc('db:searchMessages')) return [];
      if (typeof query !== 'string' || query.length > 500) return [];
      return searchMessages(query, Math.min(limit ?? 50, 200));
    } catch (err) {
      finishDbIpcHandler('db:searchMessages', err);
    }
  });

  // ─── IPC: Drop a failed outbound row superseded by an automatic resend ─────
  // Only `status = 'failed'` rows match, so a packet-id collision cannot delete delivered or
  // inbound history.
  ipcMain.handle(
    'db:deleteFailedOutboundMessage',
    (event, protocol: unknown, packetId: unknown): { changes: number } | undefined => {
      if (!validateIpcSender(event))
        throw new Error('db:deleteFailedOutboundMessage: unauthorized sender');
      try {
        if (protocol !== 'meshtastic' && protocol !== 'meshcore')
          throw new Error('db:deleteFailedOutboundMessage: invalid protocol');
        const pid = safeNonNegativeInt(packetId);
        const db = getDbForIpc('db:deleteFailedOutboundMessage');
        if (!db) return { changes: 0 };
        const table = protocol === 'meshtastic' ? 'messages' : 'meshcore_messages';
        const result = db
          .prepareOnce(`DELETE FROM ${table} WHERE packet_id = ? AND status = 'failed'`)
          .run(pid);
        return { changes: Number(result.changes) };
      } catch (err) {
        finishDbIpcHandler('db:deleteFailedOutboundMessage', err);
      }
    },
  );

  // ─── IPC: Position history ────────────────────────────────────────
  ipcMain.handle(
    'db:savePositionHistory',
    (event, nodeId: number, lat: number, lon: number, recordedAt: number, source: string) => {
      if (!validateIpcSender(event)) throw new Error('db:savePositionHistory: unauthorized sender');
      try {
        const db = getDbForIpc('db:savePositionHistory');
        if (!db) return { changes: 0 };
        const id = safeNonNegativeInt(nodeId);
        if (
          typeof lat !== 'number' ||
          !isFinite(lat) ||
          typeof lon !== 'number' ||
          !isFinite(lon) ||
          typeof recordedAt !== 'number' ||
          !isFinite(recordedAt)
        )
          return;
        const src = typeof source === 'string' ? source.slice(0, 16) : 'rf';
        insertPositionHistoryRow(db, id, lat, lon, recordedAt, src);
      } catch (err) {
        finishDbIpcHandler('db:savePositionHistory', err);
      }
    },
  );

  ipcMain.handle('db:getPositionHistory', (event, sinceMs: number) => {
    try {
      assertIpcSender(event, 'db:getPositionHistory');
      const db = getDbForIpc('db:getPositionHistory');
      if (!db) return [];
      const since = typeof sinceMs === 'number' && isFinite(sinceMs) ? sinceMs : 0;
      return db
        .prepareOnce(
          'SELECT node_id, latitude, longitude, recorded_at, source FROM position_history WHERE recorded_at >= ? ORDER BY node_id, recorded_at',
        )
        .all(since);
    } catch (err) {
      return finishDbIpcReadHandler('db:getPositionHistory', err, []);
    }
  });

  ipcMain.handle('db:clearPositionHistory', (event) => {
    if (!validateIpcSender(event)) throw new Error('db:clearPositionHistory: unauthorized sender');
    try {
      const db = getDbForIpc('db:clearPositionHistory');
      if (!db) return { changes: 0 };
      return db.prepareOnce('DELETE FROM position_history').run();
    } catch (err) {
      finishDbIpcHandler('db:clearPositionHistory', err);
    }
  });
}
