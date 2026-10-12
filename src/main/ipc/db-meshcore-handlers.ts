/**
 * MeshCore SQLite IPC (`db:*`: messages, contacts, contact groups, hop/trace/path history).
 *
 * Moved verbatim from `src/main/index.ts`; registered by the Electron main process and the
 * headless server. Writes go through `getDbForIpc` / `finishDbIpcHandler` (db-ipc-lifecycle).
 */
import { ipcMain } from 'electron';

import { isChannelIdentityKey } from '../../shared/channelIdentityKey';
import { clampQueryLimit } from '../../shared/clampQueryLimit';
import {
  sanitizeMeshcoreAdvLatLonForDb,
  sanitizeMeshcoreLastAdvertForDb,
} from '../../shared/meshcoreContactSanitize';
import { MESHCORE_CONTACTS_BATCH_MAX } from '../../shared/meshcoreContactsBatchLimit';
import { meshcoreMessageChannelIndex } from '../../shared/meshcoreMessageChannel';
import { effectiveMessageTimestampMs } from '../../shared/messageTimestampSkew';
import { sanitizeUnicodeReactionScalar } from '../../shared/reactionEmoji';
import { clearChannelMessagesByKey } from '../channelIdentityDb';
import {
  addContactToGroup,
  createContactGroup,
  deleteAllMeshcorePathHistory,
  deleteContactGroup,
  deleteMeshcoreContactOn,
  deleteMeshcoreContactsByAge,
  deleteMeshcoreContactsNeverAdvertised,
  deleteMeshcorePathHistoryForNode,
  getAllMeshcoreHopHistoryRows,
  getAllMeshcorePathHistory,
  getContactGroupMembers,
  getContactGroups,
  getMeshcoreHopHistory,
  getMeshcorePathHistory,
  getMeshcoreTraceHistory,
  type MeshcoreContactUpsertParams,
  pruneMeshcoreContactsByCount,
  pruneMeshcorePathHistory,
  recordMeshcorePathOutcome,
  removeContactFromGroup,
  saveMeshcoreContactsBatch,
  saveMeshcoreHopHistory,
  saveMeshcoreTraceHistory,
  searchMeshcoreMessages,
  updateContactGroup,
  upsertMeshcorePathHistory,
} from '../database';
import { finishDbIpcHandler, finishDbIpcReadHandler, getDbForIpc } from '../db-ipc-lifecycle';
import { listMeshcoreDmPeersFromDb } from '../listDmPeers';
import { sanitizeLogMessage } from '../log-service';
import {
  clearMeshcoreMessagesByChannel,
  MESHCORE_MESSAGE_CHANNEL_SQL,
  persistMeshcoreMessage,
} from '../meshcoreMessageChannel';
import { assertIpcSender, validateIpcSender } from '../validate-ipc-sender';
import {
  MAX_GROUP_NAME,
  MAX_NODE_STRING,
  MAX_PAYLOAD_LENGTH,
  MAX_STATUS_STRING,
  meshcoreContactInputToUpsertParams,
  safeMeshcoreChannelIndex,
  safeMeshcoreRadioNodeId,
  safeNonNegativeInt,
  validateSaveMeshcoreContact,
  validateSaveMeshcoreMessage,
} from './db-ipc-validation';

/** Min node ID for MeshCore chat stub nodes (derived from meshcoreUtils). */
const MESHCORE_CHAT_STUB_ID_MIN = 0xa0000000 >>> 0;
/** Max node ID for MeshCore chat stub nodes (derived from meshcoreUtils). */
const MESHCORE_CHAT_STUB_ID_MAX = 0xafffffff >>> 0;

/** Register the MeshCore `db:*` handlers. Channel name literals keep check:ipc-contract aligned. */
export function registerMeshcoreDbIpcHandlers(): void {
  ipcMain.handle('db:listMeshcoreDmPeers', (event, ownNodeId: unknown, limit?: unknown) => {
    try {
      assertIpcSender(event, 'db:listMeshcoreDmPeers');
      if (typeof ownNodeId !== 'number' || !Number.isFinite(ownNodeId)) return [];
      const db = getDbForIpc('db:listMeshcoreDmPeers');
      if (!db) return [];
      return listMeshcoreDmPeersFromDb(db, ownNodeId, limit);
    } catch (err) {
      return finishDbIpcReadHandler('db:listMeshcoreDmPeers', err, []);
    }
  });

  ipcMain.handle('db:pruneMeshcoreMessagesByCount', (event, maxCount: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:pruneMeshcoreMessagesByCount: unauthorized sender');
    try {
      const db = getDbForIpc('db:pruneMeshcoreMessagesByCount');
      if (!db) return 0;
      if (typeof maxCount !== 'number' || maxCount < 100 || !isFinite(maxCount))
        return { changes: 0 };
      const cap = Math.floor(maxCount);
      const result = db
        .prepareOnce(
          'DELETE FROM meshcore_messages WHERE id NOT IN (SELECT id FROM meshcore_messages ORDER BY timestamp DESC, id DESC LIMIT ?)',
        )
        .run(cap);
      if (result.changes > 0) {
        console.debug(
          `[IPC] db:pruneMeshcoreMessagesByCount: pruned ${result.changes} messages, keeping newest ${cap}`,
        );
      }
      return { changes: Number(result.changes) };
    } catch (err) {
      finishDbIpcHandler('db:pruneMeshcoreMessagesByCount', err);
    }
  });

  ipcMain.handle('db:deleteMeshcoreContactsNeverAdvertised', (event) => {
    if (!validateIpcSender(event))
      throw new Error('db:deleteMeshcoreContactsNeverAdvertised: unauthorized sender');
    try {
      if (!getDbForIpc('db:deleteMeshcoreContactsNeverAdvertised')) return 0;
      const changes = deleteMeshcoreContactsNeverAdvertised();
      if (changes > 0) {
        console.debug(
          `[IPC] db:deleteMeshcoreContactsNeverAdvertised: removed ${changes} contacts`,
        );
      }
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:deleteMeshcoreContactsNeverAdvertised', err);
    }
  });

  ipcMain.handle('db:deleteMeshcoreContactsByAge', (event, days: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:deleteMeshcoreContactsByAge: unauthorized sender');
    try {
      if (!getDbForIpc('db:deleteMeshcoreContactsByAge')) return 0;
      const safeDays = typeof days === 'number' && days > 0 ? Math.floor(days) : 30;
      const changes = deleteMeshcoreContactsByAge(safeDays);
      if (changes > 0) {
        console.debug(
          `[IPC] db:deleteMeshcoreContactsByAge: removed ${changes} contacts older than ${safeDays}d`,
        );
      }
      return changes;
    } catch (err) {
      finishDbIpcHandler('db:deleteMeshcoreContactsByAge', err);
    }
  });

  ipcMain.handle('db:pruneMeshcoreContactsByCount', (event, maxCount: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:pruneMeshcoreContactsByCount: unauthorized sender');
    try {
      if (!getDbForIpc('db:pruneMeshcoreContactsByCount')) return 0;
      const safeMax = typeof maxCount === 'number' && maxCount > 0 ? Math.floor(maxCount) : 5000;
      const changes = pruneMeshcoreContactsByCount(safeMax);
      if (changes > 0) {
        console.debug(`[IPC] db:pruneMeshcoreContactsByCount: removed ${changes} excess contacts`);
      }
      return { changes };
    } catch (err) {
      finishDbIpcHandler('db:pruneMeshcoreContactsByCount', err);
    }
  });

  // ─── IPC: MeshCore database operations ──────────────────────────────
  ipcMain.handle('db:getMeshcoreMessages', (event, channelIdx?: number, limit = 200) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreMessages');
      const safeLimit = clampQueryLimit(limit, { default: 200, max: 10000 });
      const db = getDbForIpc('db:getMeshcoreMessages');
      if (!db) return [];
      // Order by row id (insert order at this client), not `timestamp`:
      // outgoing messages use Date.now() while RF inbound uses the radio's clock; if the device
      // time lags, ORDER BY timestamp DESC kept "recent" sends but dropped inbound rows from the
      // LIMIT window. Reversed DESC→ASC yields oldest-first within the N most recently stored rows.
      if (channelIdx != null) {
        const ch = typeof channelIdx === 'number' ? Math.trunc(channelIdx) : 0;
        const rows = db
          .prepareOnce(
            `SELECT * FROM meshcore_messages WHERE ${MESHCORE_MESSAGE_CHANNEL_SQL} = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(ch, safeLimit) as Record<string, unknown>[];
        rows.reverse();
        return rows.map((row) => ({
          ...row,
          timestamp: effectiveMessageTimestampMs(Number(row.timestamp)),
        }));
      }
      const rows = db
        .prepareOnce('SELECT * FROM meshcore_messages ORDER BY id DESC LIMIT ?')
        .all(safeLimit) as Record<string, unknown>[];
      rows.reverse();
      return rows.map((row) => ({
        ...row,
        timestamp: effectiveMessageTimestampMs(Number(row.timestamp)),
      }));
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreMessages', err);
    }
  });

  ipcMain.handle('db:searchMeshcoreMessages', (event, query: string, limit?: number) => {
    try {
      assertIpcSender(event, 'db:searchMeshcoreMessages');
      if (!getDbForIpc('db:searchMeshcoreMessages')) return [];
      if (typeof query !== 'string' || query.length > 500) return [];
      return searchMeshcoreMessages(query, Math.min(limit ?? 50, 200));
    } catch (err) {
      finishDbIpcHandler('db:searchMeshcoreMessages', err);
    }
  });

  ipcMain.handle('db:getMeshcoreContacts', (event) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreContacts');
      const db = getDbForIpc('db:getMeshcoreContacts');
      if (!db) return [];
      return db.prepareOnce('SELECT * FROM meshcore_contacts').all();
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreContacts', err);
    }
  });

  ipcMain.handle('db:saveMeshcoreMessage', (event, message) => {
    if (!validateIpcSender(event)) throw new Error('db:saveMeshcoreMessage: unauthorized sender');
    try {
      validateSaveMeshcoreMessage(message);
      const m = message as Record<string, unknown>;
      const replyId = m.reply_id != null ? Number(m.reply_id) : null;
      if (replyId != null && (!Number.isFinite(replyId) || replyId < 0)) {
        throw new Error('db:saveMeshcoreMessage: reply_id must be a non-negative finite number');
      }
      const db = getDbForIpc('db:saveMeshcoreMessage');
      if (!db) return { changes: 0 };
      const validReceivedVia = ['rf', 'mqtt', 'both'] as const;
      const receivedViaRaw = m.received_via;
      const received_via =
        typeof receivedViaRaw === 'string' &&
        (validReceivedVia as readonly string[]).includes(receivedViaRaw)
          ? receivedViaRaw
          : null;
      const rxFp =
        typeof m.rx_packet_fingerprint === 'string' ? m.rx_packet_fingerprint.toUpperCase() : null;
      const replyPreviewText =
        typeof m.reply_preview_text === 'string' ? m.reply_preview_text.slice(0, 50) : null;
      const replyPreviewSender =
        typeof m.reply_preview_sender === 'string' ? m.reply_preview_sender.slice(0, 64) : null;
      const rowParams = {
        sender_id: m.sender_id != null ? Number(m.sender_id) >>> 0 : null,
        sender_name: typeof m.sender_name === 'string' ? m.sender_name : null,
        payload: m.payload as string,
        channel_idx: meshcoreMessageChannelIndex(
          m.channel_idx != null ? Math.trunc(Number(m.channel_idx)) : 0,
          m.to_node != null ? Number(m.to_node) >>> 0 : null,
          m.room_server_id != null ? Number(m.room_server_id) : null,
        ),
        local_order: m.local_order != null ? Number(m.local_order) : null,
        timestamp: effectiveMessageTimestampMs(Number(m.timestamp)),
        status: typeof m.status === 'string' ? m.status : 'acked',
        packet_id: m.packet_id != null ? Number(m.packet_id) : null,
        emoji: m.emoji != null ? (sanitizeUnicodeReactionScalar(m.emoji) ?? null) : null,
        reply_id: replyId,
        to_node: m.to_node != null ? Number(m.to_node) >>> 0 : null,
        received_via,
        rx_packet_fingerprint: rxFp,
        reply_preview_text: replyPreviewText,
        reply_preview_sender: replyPreviewSender,
        rx_hops:
          m.rx_hops != null && Number.isFinite(Number(m.rx_hops))
            ? Math.trunc(Number(m.rx_hops))
            : null,
        room_server_id:
          m.room_server_id != null && Number.isFinite(Number(m.room_server_id))
            ? Math.trunc(Number(m.room_server_id))
            : null,
        radio_node_id: (() => {
          if (m.radio_node_id == null) return null;
          const radio = Number(m.radio_node_id) >>> 0;
          return radio > 0 ? radio : null;
        })(),
        channel_key: isChannelIdentityKey(m.channel_key) ? m.channel_key : null,
      };

      return persistMeshcoreMessage(db, rowParams);
    } catch (err) {
      finishDbIpcHandler('db:saveMeshcoreMessage', err);
    }
  });

  ipcMain.handle('db:saveMeshcoreContact', (event, contact) => {
    if (!validateIpcSender(event)) throw new Error('db:saveMeshcoreContact: unauthorized sender');
    try {
      if (!getDbForIpc('db:saveMeshcoreContact')) return { changes: 0 };
      validateSaveMeshcoreContact(contact);
      return saveMeshcoreContactsBatch([meshcoreContactInputToUpsertParams(contact)]);
    } catch (err) {
      finishDbIpcHandler('db:saveMeshcoreContact', err);
    }
  });

  ipcMain.handle('db:saveMeshcoreContactsBatch', (event, contacts: unknown) => {
    if (!validateIpcSender(event))
      throw new Error('db:saveMeshcoreContactsBatch: unauthorized sender');
    try {
      if (!getDbForIpc('db:saveMeshcoreContactsBatch')) return { changes: 0 };
      if (!Array.isArray(contacts)) {
        throw new Error('db:saveMeshcoreContactsBatch: contacts must be an array');
      }
      const rows: MeshcoreContactUpsertParams[] = [];
      for (let i = 0; i < contacts.length; i += MESHCORE_CONTACTS_BATCH_MAX) {
        const slice = contacts.slice(i, i + MESHCORE_CONTACTS_BATCH_MAX);
        for (const contact of slice) {
          validateSaveMeshcoreContact(contact);
          rows.push(meshcoreContactInputToUpsertParams(contact));
        }
      }
      return saveMeshcoreContactsBatch(rows);
    } catch (err) {
      finishDbIpcHandler('db:saveMeshcoreContactsBatch', err);
    }
  });

  ipcMain.handle(
    'db:updateMeshcoreContactRfTransport',
    (event, nodeId: number, transportScope: unknown, transportReturn: unknown) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreContactRfTransport: unauthorized sender');
      try {
        const db = getDbForIpc('db:updateMeshcoreContactRfTransport');
        if (!db) return { changes: 0 };
        const id = safeNonNegativeInt(nodeId);
        const ts =
          transportScope != null &&
          typeof transportScope === 'number' &&
          Number.isFinite(transportScope)
            ? Math.trunc(transportScope) & 0xffff
            : null;
        const tr =
          transportReturn != null &&
          typeof transportReturn === 'number' &&
          Number.isFinite(transportReturn)
            ? Math.trunc(transportReturn) & 0xffff
            : null;
        db.prepareOnce(
          'UPDATE meshcore_contacts SET last_rf_transport_scope = ?, last_rf_transport_return = ? WHERE node_id = ?',
        ).run(ts, tr, id);
      } catch (err) {
        finishDbIpcHandler('db:updateMeshcoreContactRfTransport', err);
      }
    },
  );

  ipcMain.handle(
    'db:updateMeshcoreContactNickname',
    (event, nodeId: number, nickname: string | null) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreContactNickname: unauthorized sender');
      try {
        const db = getDbForIpc('db:updateMeshcoreContactNickname');
        if (!db) return { changes: 0 };
        const id = safeNonNegativeInt(nodeId);
        if (nickname != null && (typeof nickname !== 'string' || nickname.length > MAX_NODE_STRING))
          throw new Error('db:updateMeshcoreContactNickname: invalid nickname');
        db.prepareOnce('UPDATE meshcore_contacts SET nickname = ? WHERE node_id = ?').run(
          nickname ?? null,
          id,
        );
      } catch (err) {
        finishDbIpcHandler('db:updateMeshcoreContactNickname', err);
      }
    },
  );

  ipcMain.handle(
    'db:updateMeshcoreContactFavorited',
    (event, nodeId: number, favorited: boolean, publicKeyHex?: string | null) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreContactFavorited: unauthorized sender');
      try {
        const id = safeNonNegativeInt(nodeId);
        if (typeof favorited !== 'boolean') {
          throw new Error('db:updateMeshcoreContactFavorited: favorited must be a boolean');
        }
        if (publicKeyHex != null && typeof publicKeyHex !== 'string') {
          throw new Error(
            'db:updateMeshcoreContactFavorited: publicKeyHex must be a string or null',
          );
        }
        if (publicKeyHex != null && publicKeyHex.length > 128) {
          throw new Error('db:updateMeshcoreContactFavorited: publicKeyHex too long');
        }
        const db = getDbForIpc('db:updateMeshcoreContactFavorited');
        if (!db) return null;
        const run = db
          .prepareOnce('UPDATE meshcore_contacts SET favorited = ? WHERE node_id = ?')
          .run(favorited ? 1 : 0, id);
        if (run.changes > 0) return run;
        const hex = publicKeyHex?.replace(/\s/g, '') ?? '';
        if (!hex) {
          throw new Error(
            'db:updateMeshcoreContactFavorited: contact not in database; public_key required to create row',
          );
        }
        db.prepareOnce(
          `INSERT INTO meshcore_contacts (node_id, public_key, favorited)
         VALUES (?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET favorited = excluded.favorited`,
        ).run(id, hex, favorited ? 1 : 0);
        return { changes: 1 };
      } catch (err) {
        finishDbIpcHandler('db:updateMeshcoreContactFavorited', err);
      }
    },
  );

  ipcMain.handle(
    'db:updateMeshcoreMessageSender',
    (event, messageId: number, senderId: number, senderName: string) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreMessageSender: unauthorized sender');
      try {
        const id = messageId;
        const sid = senderId;
        if (!Number.isFinite(id) || id < 1) {
          throw new Error('db:updateMeshcoreMessageSender: invalid messageId');
        }
        if (!Number.isFinite(sid) || sid < 1) {
          throw new Error('db:updateMeshcoreMessageSender: invalid senderId');
        }
        const name = typeof senderName === 'string' ? senderName.trim().slice(0, 64) : '';
        if (!name) throw new Error('db:updateMeshcoreMessageSender: senderName required');
        const db = getDbForIpc('db:updateMeshcoreMessageSender');
        if (!db) return { changes: 0 };
        return db
          .prepareOnce(
            'UPDATE meshcore_messages SET sender_id = @sender_id, sender_name = @sender_name WHERE id = @id',
          )
          .run({ id, sender_id: sid, sender_name: name });
      } catch (err) {
        finishDbIpcHandler('db:updateMeshcoreMessageSender', err);
      }
    },
  );

  ipcMain.handle('db:updateMeshcoreMessageStatus', (event, packetId: number, status: string) => {
    if (!validateIpcSender(event))
      throw new Error('db:updateMeshcoreMessageStatus: unauthorized sender');
    try {
      const db = getDbForIpc('db:updateMeshcoreMessageStatus');
      if (!db) return { changes: 0 };
      const pid = packetId;
      if (!Number.isFinite(pid))
        throw new Error('db:updateMeshcoreMessageStatus: invalid packetId');
      if (typeof status !== 'string' || status.length > MAX_STATUS_STRING)
        throw new Error('db:updateMeshcoreMessageStatus: invalid status');
      return db
        .prepareOnce('UPDATE meshcore_messages SET status = ? WHERE packet_id = ?')
        .run(status, pid);
    } catch (err) {
      finishDbIpcHandler('db:updateMeshcoreMessageStatus', err);
    }
  });

  ipcMain.handle(
    'db:updateMeshcoreMessageStatusByKey',
    (
      event,
      senderId: number,
      timestamp: number,
      channelIdx: number,
      payload: string,
      status: string,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreMessageStatusByKey: unauthorized sender');
      try {
        const db = getDbForIpc('db:updateMeshcoreMessageStatusByKey');
        if (!db) return { changes: 0 };
        const sid = senderId;
        const ts = timestamp;
        const ch = Math.trunc(channelIdx);
        if (!Number.isFinite(sid) || sid < 0)
          throw new Error('db:updateMeshcoreMessageStatusByKey: invalid senderId');
        if (!Number.isFinite(ts))
          throw new Error('db:updateMeshcoreMessageStatusByKey: invalid timestamp');
        if (!Number.isFinite(ch))
          throw new Error('db:updateMeshcoreMessageStatusByKey: invalid channelIdx');
        if (typeof payload !== 'string')
          throw new Error('db:updateMeshcoreMessageStatusByKey: payload must be a string');
        if (payload.length > MAX_PAYLOAD_LENGTH)
          throw new Error('db:updateMeshcoreMessageStatusByKey: payload too long');
        if (typeof status !== 'string' || status.length > MAX_STATUS_STRING)
          throw new Error('db:updateMeshcoreMessageStatusByKey: invalid status');
        return db
          .prepareOnce(
            `UPDATE meshcore_messages SET status = ?
           WHERE sender_id = ? AND timestamp = ? AND channel_idx = ? AND payload = ?`,
          )
          .run(status, sid, ts, ch, payload);
      } catch (err) {
        finishDbIpcHandler('db:updateMeshcoreMessageStatusByKey', err);
      }
    },
  );

  ipcMain.handle('db:deleteMeshcoreContact', (event, nodeId: number) => {
    if (!validateIpcSender(event)) throw new Error('db:deleteMeshcoreContact: unauthorized sender');
    try {
      const db = getDbForIpc('db:deleteMeshcoreContact');
      if (!db) return { changes: 0 };
      const id = safeNonNegativeInt(nodeId);
      return deleteMeshcoreContactOn(db, id);
    } catch (err) {
      finishDbIpcHandler('db:deleteMeshcoreContact', err);
    }
  });

  ipcMain.handle('db:clearMeshcoreMessages', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:clearMeshcoreMessages');
      if (!db) return { changes: 0 };
      return db.prepareOnce('DELETE FROM meshcore_messages').run();
    } catch (err) {
      finishDbIpcHandler('db:clearMeshcoreMessages', err);
    }
  });

  ipcMain.handle('db:getMeshcoreMessageChannels', (event) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreMessageChannels');
      const db = getDbForIpc('db:getMeshcoreMessageChannels');
      if (!db) return [];
      return db
        .prepareOnce(
          `SELECT DISTINCT ${MESHCORE_MESSAGE_CHANNEL_SQL} AS channel FROM meshcore_messages ORDER BY channel`,
        )
        .all();
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreMessageChannels', err);
    }
  });

  ipcMain.handle(
    'db:clearMeshcoreMessagesByChannel',
    (event, channelIdx: number, radioNodeId: number, channelKey?: unknown) => {
      if (!validateIpcSender(event)) {
        throw new Error('IPC sender validation failed');
      }
      try {
        const db = getDbForIpc('db:clearMeshcoreMessagesByChannel');
        if (!db) return { changes: 0 };
        const ch = safeMeshcoreChannelIndex(channelIdx);
        const radio = safeMeshcoreRadioNodeId(radioNodeId);
        const result =
          ch >= 0 && isChannelIdentityKey(channelKey)
            ? clearChannelMessagesByKey(db, 'meshcore', ch, radio, channelKey)
            : clearMeshcoreMessagesByChannel(db, ch, radio);
        console.debug(
          `[IPC] db:clearMeshcoreMessagesByChannel: deleted ${result.changes} messages from channel_idx ${ch} radio_node_id ${radio}`,
        );
        return result;
      } catch (err) {
        finishDbIpcHandler('db:clearMeshcoreMessagesByChannel', err);
      }
    },
  );

  ipcMain.handle('db:clearMeshcoreContacts', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:clearMeshcoreContacts');
      if (!db) return { changes: 0 };
      return db.prepareOnce('DELETE FROM meshcore_contacts').run();
    } catch (err) {
      finishDbIpcHandler('db:clearMeshcoreContacts', err);
    }
  });

  // Deletes only non-favorited Repeater-type contacts (contact_type = 2), leaving Chat and Room
  // contacts intact.
  ipcMain.handle('db:clearMeshcoreRepeaters', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const db = getDbForIpc('db:clearMeshcoreRepeaters');
      if (!db) return { changes: 0 };
      return db
        .prepareOnce(
          'DELETE FROM meshcore_contacts WHERE contact_type = 2 AND COALESCE(favorited, 0) = 0',
        )
        .run();
    } catch (err) {
      finishDbIpcHandler('db:clearMeshcoreRepeaters', err);
    }
  });

  // Marks all contacts as not on radio (on_radio = 0).
  ipcMain.handle('db:markAllMeshcoreContactsOffRadio', (event) => {
    if (!validateIpcSender(event))
      throw new Error('db:markAllMeshcoreContactsOffRadio: unauthorized sender');
    try {
      const db = getDbForIpc('db:markAllMeshcoreContactsOffRadio');
      if (!db) return { changes: 0 };
      return db.prepareOnce('UPDATE meshcore_contacts SET on_radio = 0').run();
    } catch (err) {
      finishDbIpcHandler('db:markAllMeshcoreContactsOffRadio', err);
    }
  });

  // Returns count of contacts currently marked as on_radio = 1.
  ipcMain.handle('db:getMeshcoreContactCount', (event) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreContactCount');
      const db = getDbForIpc('db:getMeshcoreContactCount');
      if (!db) return 0;
      const result = db
        .prepareOnce('SELECT COUNT(*) as cnt FROM meshcore_contacts WHERE on_radio = 1')
        .get() as { cnt: number };
      return result.cnt;
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreContactCount', err);
    }
  });

  // Deletes contacts without pubkey, excluding chat stub nodes. Returns { deleted, excludedStubCount }.
  ipcMain.handle('db:deleteMeshcoreContactsWithoutPubkey', (event) => {
    if (!validateIpcSender(event))
      throw new Error('db:deleteMeshcoreContactsWithoutPubkey: unauthorized sender');
    try {
      const db = getDbForIpc('db:deleteMeshcoreContactsWithoutPubkey');
      if (!db) return { changes: 0 };
      // Count stubs that would be excluded (for reporting)
      const stubCountResult = db
        .prepareOnce(
          `SELECT COUNT(*) as cnt FROM meshcore_contacts
         WHERE (public_key IS NULL OR public_key = '')
         AND node_id >= ? AND node_id <= ?`,
        )
        .get(MESHCORE_CHAT_STUB_ID_MIN, MESHCORE_CHAT_STUB_ID_MAX) as { cnt: number };
      const excludedStubCount = stubCountResult.cnt;
      // Delete non-stub contacts without pubkey
      const result = db
        .prepareOnce(
          `DELETE FROM meshcore_contacts
         WHERE (public_key IS NULL OR public_key = '')
         AND NOT (node_id >= ? AND node_id <= ?)`,
        )
        .run(MESHCORE_CHAT_STUB_ID_MIN, MESHCORE_CHAT_STUB_ID_MAX);
      return { deleted: result.changes, excludedStubCount };
    } catch (err) {
      finishDbIpcHandler('db:deleteMeshcoreContactsWithoutPubkey', err);
    }
  });

  // Offloads all contacts with pubkey from radio (sets on_radio = 0). Returns count offloaded.
  ipcMain.handle('db:offloadAllMeshcoreContacts', (event) => {
    if (!validateIpcSender(event))
      throw new Error('db:offloadAllMeshcoreContacts: unauthorized sender');
    try {
      const db = getDbForIpc('db:offloadAllMeshcoreContacts');
      if (!db) return { changes: 0 };
      const result = db
        .prepareOnce(
          `UPDATE meshcore_contacts SET on_radio = 0
         WHERE on_radio = 1 AND public_key IS NOT NULL AND public_key != ''`,
        )
        .run();
      return result.changes;
    } catch (err) {
      finishDbIpcHandler('db:offloadAllMeshcoreContacts', err);
    }
  });

  // Mark a single contact off-radio by public_key (CONTACT_DELETED push). Returns { changes }.
  ipcMain.handle('db:markMeshcoreContactOffRadio', (event, publicKeyHex: unknown) => {
    if (!validateIpcSender(event))
      throw new Error('db:markMeshcoreContactOffRadio: unauthorized sender');
    try {
      if (typeof publicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
        throw new Error('db:markMeshcoreContactOffRadio: public_key must be 64 hex chars');
      }
      const db = getDbForIpc('db:markMeshcoreContactOffRadio');
      if (!db) return { changes: 0 };
      const key = publicKeyHex.toLowerCase();
      const result = db
        .prepareOnce(
          `UPDATE meshcore_contacts SET on_radio = 0
         WHERE lower(public_key) = ? AND on_radio = 1`,
        )
        .run(key);
      return { changes: result.changes };
    } catch (err) {
      return finishDbIpcReadHandler('db:markMeshcoreContactOffRadio', err, { changes: 0 });
    }
  });

  // Get a single contact by node_id (returns on_radio status).
  ipcMain.handle('db:getMeshcoreContactById', (event, nodeId: number) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreContactById');
      const db = getDbForIpc('db:getMeshcoreContactById');
      if (!db) return null;
      const id = safeNonNegativeInt(nodeId);
      return db
        .prepareOnce(
          'SELECT node_id, public_key, on_radio FROM meshcore_contacts WHERE node_id = ?',
        )
        .get(id);
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreContactById', err);
    }
  });

  ipcMain.handle('db:getContactGroups', (event, selfNodeId: number) => {
    try {
      assertIpcSender(event, 'db:getContactGroups');
      if (!getDbForIpc('db:getContactGroups')) return [];
      return getContactGroups(safeNonNegativeInt(selfNodeId));
    } catch (err) {
      finishDbIpcHandler('db:getContactGroups', err);
    }
  });

  ipcMain.handle('db:createContactGroup', (event, selfNodeId: number, name: string) => {
    if (!validateIpcSender(event)) throw new Error('db:createContactGroup: unauthorized sender');
    try {
      if (!getDbForIpc('db:createContactGroup')) return null;
      const id = safeNonNegativeInt(selfNodeId);
      if (typeof name !== 'string' || name.trim().length === 0)
        throw new Error('db:createContactGroup: name must be a non-empty string');
      if (name.length > MAX_GROUP_NAME) throw new Error('db:createContactGroup: name too long');
      return createContactGroup(id, name.trim());
    } catch (err) {
      finishDbIpcHandler('db:createContactGroup', err);
    }
  });

  ipcMain.handle('db:updateContactGroup', (event, groupId: number, name: string) => {
    if (!validateIpcSender(event)) throw new Error('db:updateContactGroup: unauthorized sender');
    try {
      if (!getDbForIpc('db:updateContactGroup')) return;
      const id = safeNonNegativeInt(groupId);
      if (typeof name !== 'string' || name.trim().length === 0)
        throw new Error('db:updateContactGroup: name must be a non-empty string');
      if (name.length > MAX_GROUP_NAME) throw new Error('db:updateContactGroup: name too long');
      updateContactGroup(id, name.trim());
    } catch (err) {
      finishDbIpcHandler('db:updateContactGroup', err);
    }
  });

  ipcMain.handle('db:deleteContactGroup', (event, groupId: number) => {
    if (!validateIpcSender(event)) throw new Error('db:deleteContactGroup: unauthorized sender');
    try {
      if (!getDbForIpc('db:deleteContactGroup')) return;
      deleteContactGroup(safeNonNegativeInt(groupId));
    } catch (err) {
      finishDbIpcHandler('db:deleteContactGroup', err);
    }
  });

  ipcMain.handle('db:addContactToGroup', (event, groupId: number, contactNodeId: number) => {
    if (!validateIpcSender(event)) throw new Error('db:addContactToGroup: unauthorized sender');
    try {
      if (!getDbForIpc('db:addContactToGroup')) return;
      addContactToGroup(safeNonNegativeInt(groupId), safeNonNegativeInt(contactNodeId));
    } catch (err) {
      finishDbIpcHandler('db:addContactToGroup', err);
    }
  });

  ipcMain.handle('db:removeContactFromGroup', (event, groupId: number, contactNodeId: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:removeContactFromGroup: unauthorized sender');
    try {
      if (!getDbForIpc('db:removeContactFromGroup')) return;
      removeContactFromGroup(safeNonNegativeInt(groupId), safeNonNegativeInt(contactNodeId));
    } catch (err) {
      finishDbIpcHandler('db:removeContactFromGroup', err);
    }
  });

  ipcMain.handle('db:getContactGroupMembers', (event, groupId: number) => {
    try {
      assertIpcSender(event, 'db:getContactGroupMembers');
      if (!getDbForIpc('db:getContactGroupMembers')) return [];
      return getContactGroupMembers(safeNonNegativeInt(groupId));
    } catch (err) {
      finishDbIpcHandler('db:getContactGroupMembers', err);
    }
  });

  ipcMain.handle(
    'db:updateMeshcoreContactAdvert',
    (
      event,
      nodeId: number,
      lastAdvert: number | null,
      advLat: number | null,
      advLon: number | null,
      advName?: string | null,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreContactAdvert: unauthorized sender');
      try {
        const safeNodeId = safeNonNegativeInt(nodeId);
        if (advName != null && (typeof advName !== 'string' || advName.length > MAX_NODE_STRING)) {
          throw new Error('db:updateMeshcoreContactAdvert: invalid adv_name');
        }
        const db = getDbForIpc('db:updateMeshcoreContactAdvert');
        if (!db) return { changes: 0 };
        const safeLastAdvert = sanitizeMeshcoreLastAdvertForDb(lastAdvert);
        const coords = sanitizeMeshcoreAdvLatLonForDb(advLat, advLon);
        // Monotonic: a rebooted repeater with a reset RTC must not drag last_advert backwards.
        const lastAdvertSql =
          'last_advert = CASE WHEN ? IS NOT NULL AND ? > COALESCE(last_advert, 0) THEN ? ELSE last_advert END';
        if (advName !== undefined) {
          db.prepareOnce(
            `UPDATE meshcore_contacts SET ${lastAdvertSql}, adv_lat = ?, adv_lon = ?, adv_name = ? WHERE node_id = ?`,
          ).run(
            safeLastAdvert,
            safeLastAdvert,
            safeLastAdvert,
            coords.adv_lat,
            coords.adv_lon,
            advName ?? null,
            safeNodeId,
          );
        } else {
          db.prepareOnce(
            `UPDATE meshcore_contacts SET ${lastAdvertSql}, adv_lat = ?, adv_lon = ? WHERE node_id = ?`,
          ).run(
            safeLastAdvert,
            safeLastAdvert,
            safeLastAdvert,
            coords.adv_lat,
            coords.adv_lon,
            safeNodeId,
          );
        }
      } catch (err) {
        console.error(
          '[IPC] db:updateMeshcoreContactAdvert error:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
        throw err;
      }
    },
  );

  ipcMain.handle('db:updateMeshcoreContactType', (event, nodeId: number, contactType: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:updateMeshcoreContactType: unauthorized sender');
    try {
      const db = getDbForIpc('db:updateMeshcoreContactType');
      if (!db) return { changes: 0 };
      const safeNodeId = safeNonNegativeInt(nodeId);
      const safeType = safeNonNegativeInt(contactType);
      db.prepareOnce('UPDATE meshcore_contacts SET contact_type = ? WHERE node_id = ?').run(
        safeType,
        safeNodeId,
      );
    } catch (err) {
      console.error(
        '[IPC] db:updateMeshcoreContactType error:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle(
    'db:updateMeshcoreContactLastRf',
    (
      event,
      nodeId: number,
      lastSnr: number,
      lastRssi: number,
      hops?: number | null,
      timestamp?: number | null,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:updateMeshcoreContactLastRf: unauthorized sender');
      try {
        const db = getDbForIpc('db:updateMeshcoreContactLastRf');
        if (!db) return { changes: 0 };
        const safeNodeId = safeNonNegativeInt(nodeId);
        if (typeof lastSnr !== 'number' || !Number.isFinite(lastSnr)) {
          throw new Error('db:updateMeshcoreContactLastRf: lastSnr must be a finite number');
        }
        if (typeof lastRssi !== 'number' || !Number.isFinite(lastRssi)) {
          throw new Error('db:updateMeshcoreContactLastRf: lastRssi must be a finite number');
        }
        const safeTimestamp = sanitizeMeshcoreLastAdvertForDb(timestamp ?? null);
        db.prepareOnce(
          'UPDATE meshcore_contacts SET ' +
            'last_snr = ?, ' +
            'last_rssi = ?, ' +
            'hops_away = CASE WHEN ? IS NOT NULL AND (hops_away IS NULL OR ? < hops_away) THEN ? ELSE hops_away END, ' +
            'last_advert = CASE WHEN ? IS NOT NULL AND ? > COALESCE(last_advert, 0) THEN ? ELSE last_advert END ' +
            'WHERE node_id = ?',
        ).run(
          lastSnr,
          lastRssi,
          hops ?? null,
          hops ?? null,
          hops ?? null,
          safeTimestamp,
          safeTimestamp,
          safeTimestamp,
          safeNodeId,
        );
      } catch (err) {
        console.error(
          '[IPC] db:updateMeshcoreContactLastRf error:',
          sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
        );
        throw err;
      }
    },
  );

  ipcMain.handle(
    'db:saveMeshcoreHopHistory',
    (
      event,
      nodeId: number,
      timestamp: number,
      hops: number | null,
      snr: number | null,
      rssi: number | null,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:saveMeshcoreHopHistory: unauthorized sender');
      try {
        if (!getDbForIpc('db:saveMeshcoreHopHistory')) return false;
        saveMeshcoreHopHistory(nodeId, timestamp, hops, snr, rssi);
        return true;
      } catch (err) {
        finishDbIpcHandler('db:saveMeshcoreHopHistory', err);
      }
    },
  );

  ipcMain.handle('db:getMeshcoreHopHistory', (event, nodeId: number) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreHopHistory');
      if (!getDbForIpc('db:getMeshcoreHopHistory')) return [];
      return getMeshcoreHopHistory(nodeId);
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreHopHistory', err);
    }
  });

  ipcMain.handle('db:getAllMeshcoreHopHistory', (event) => {
    try {
      assertIpcSender(event, 'db:getAllMeshcoreHopHistory');
      if (!getDbForIpc('db:getAllMeshcoreHopHistory')) return [];
      return getAllMeshcoreHopHistoryRows();
    } catch (err) {
      finishDbIpcHandler('db:getAllMeshcoreHopHistory', err);
    }
  });

  ipcMain.handle(
    'db:saveMeshcoreTraceHistory',
    (
      event,
      nodeId: number,
      timestamp: number,
      pathLen: number | null,
      pathSnrs: number[],
      lastSnr: number | null,
      tag: number,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:saveMeshcoreTraceHistory: unauthorized sender');
      try {
        if (!getDbForIpc('db:saveMeshcoreTraceHistory')) return false;
        saveMeshcoreTraceHistory(nodeId, timestamp, pathLen, pathSnrs, lastSnr, tag);
        return true;
      } catch (err) {
        finishDbIpcHandler('db:saveMeshcoreTraceHistory', err);
      }
    },
  );

  ipcMain.handle('db:getMeshcoreTraceHistory', (event, nodeId: number) => {
    try {
      assertIpcSender(event, 'db:getMeshcoreTraceHistory');
      if (!getDbForIpc('db:getMeshcoreTraceHistory')) return [];
      return getMeshcoreTraceHistory(nodeId);
    } catch (err) {
      finishDbIpcHandler('db:getMeshcoreTraceHistory', err);
    }
  });

  ipcMain.handle('db:pruneMeshcorePathHistory', (event, nodeId: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:pruneMeshcorePathHistory: unauthorized sender');
    try {
      if (!getDbForIpc('db:pruneMeshcorePathHistory')) return false;
      pruneMeshcorePathHistory(nodeId);
      return true;
    } catch (err) {
      finishDbIpcHandler('db:pruneMeshcorePathHistory', err);
    }
  });

  ipcMain.handle(
    'db:upsertMeshcorePathHistory',
    (
      event,
      nodeId: number,
      pathHash: string,
      hopCount: number,
      pathBytes: number[],
      wasFloodDiscovery: boolean,
      routeWeight: number,
    ) => {
      if (!validateIpcSender(event))
        throw new Error('db:upsertMeshcorePathHistory: unauthorized sender');
      try {
        if (!getDbForIpc('db:upsertMeshcorePathHistory')) return false;
        upsertMeshcorePathHistory(
          nodeId,
          pathHash,
          hopCount,
          pathBytes,
          wasFloodDiscovery,
          routeWeight,
        );
        return true;
      } catch (err) {
        finishDbIpcHandler('db:upsertMeshcorePathHistory', err);
      }
    },
  );

  ipcMain.handle(
    'db:recordMeshcorePathOutcome',
    (event, nodeId: number, pathHash: string, success: boolean, tripTimeMs?: number) => {
      if (!validateIpcSender(event))
        throw new Error('db:recordMeshcorePathOutcome: unauthorized sender');
      try {
        if (!getDbForIpc('db:recordMeshcorePathOutcome')) return false;
        recordMeshcorePathOutcome(nodeId, pathHash, success, tripTimeMs);
        return true;
      } catch (err) {
        finishDbIpcHandler('db:recordMeshcorePathOutcome', err);
      }
    },
  );

  ipcMain.handle('db:getAllMeshcorePathHistory', (event) => {
    try {
      assertIpcSender(event, 'db:getAllMeshcorePathHistory');
      if (!getDbForIpc('db:getAllMeshcorePathHistory')) return [];
      return getAllMeshcorePathHistory();
    } catch (err) {
      finishDbIpcHandler('db:getAllMeshcorePathHistory', err);
    }
  });

  ipcMain.handle('db:getMeshcorePathHistory', (event, nodeId: number) => {
    try {
      assertIpcSender(event, 'db:getMeshcorePathHistory');
      if (!getDbForIpc('db:getMeshcorePathHistory')) return [];
      return getMeshcorePathHistory(nodeId);
    } catch (err) {
      finishDbIpcHandler('db:getMeshcorePathHistory', err);
    }
  });

  ipcMain.handle('db:deleteMeshcorePathHistoryForNode', (event, nodeId: number) => {
    if (!validateIpcSender(event))
      throw new Error('db:deleteMeshcorePathHistoryForNode: unauthorized sender');
    try {
      if (!getDbForIpc('db:deleteMeshcorePathHistoryForNode')) return false;
      deleteMeshcorePathHistoryForNode(nodeId);
      return true;
    } catch (err) {
      finishDbIpcHandler('db:deleteMeshcorePathHistoryForNode', err);
    }
  });

  ipcMain.handle('db:deleteAllMeshcorePathHistory', (event) => {
    if (!validateIpcSender(event))
      throw new Error('db:deleteAllMeshcorePathHistory: unauthorized sender');
    try {
      if (!getDbForIpc('db:deleteAllMeshcorePathHistory')) return false;
      deleteAllMeshcorePathHistory();
      return true;
    } catch (err) {
      finishDbIpcHandler('db:deleteAllMeshcorePathHistory', err);
    }
  });
}
