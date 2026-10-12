/**
 * Chat outbox IPC (`chat:outbox:*`): SQLite-backed queue of unsent messages per protocol view.
 *
 * Moved verbatim from `src/main/index.ts`; registered by the Electron main process and the
 * headless server.
 */
import { ipcMain } from 'electron';

import { MESH_PROTOCOL_SET } from '../../shared/meshProtocol';
import { finishDbIpcHandler, finishDbIpcReadHandler, getDbForIpc } from '../db-ipc-lifecycle';
import { assertIpcSender } from '../validate-ipc-sender';

const OUTBOX_VALID_PROTOCOLS = MESH_PROTOCOL_SET;
const OUTBOX_VALID_STATUSES = new Set(['queued', 'sending', 'blocked', 'failed']);

/** Register the `chat:outbox:*` handlers. Channel name literals keep check:ipc-contract aligned. */
export function registerChatOutboxIpcHandlers(): void {
  ipcMain.handle('chat:outbox:list', (event, protocol: unknown) => {
    try {
      assertIpcSender(event, 'chat:outbox:list');
      if (typeof protocol !== 'string' || !OUTBOX_VALID_PROTOCOLS.has(protocol)) {
        throw new Error('chat:outbox:list: invalid protocol');
      }
      const db = getDbForIpc('chat:outbox:list');
      if (!db) return [];
      const rows = db
        .prepareOnce('SELECT * FROM chat_outbox WHERE protocol = ? ORDER BY created_at ASC')
        .all(protocol) as Record<string, unknown>[];
      return rows.map(rowToOutboxEntry);
    } catch (err) {
      return finishDbIpcReadHandler('chat:outbox:list', err, []);
    }
  });

  ipcMain.handle('chat:outbox:add', (event, entry: unknown) => {
    try {
      assertIpcSender(event, 'chat:outbox:add');
      if (!entry || typeof entry !== 'object') throw new Error('chat:outbox:add: invalid entry');
      const e = entry as Record<string, unknown>;
      if (typeof e.protocol !== 'string' || !OUTBOX_VALID_PROTOCOLS.has(e.protocol))
        throw new Error('chat:outbox:add: invalid protocol');
      if (typeof e.viewKey !== 'string') throw new Error('chat:outbox:add: invalid viewKey');
      if (typeof e.channel !== 'number') throw new Error('chat:outbox:add: invalid channel');
      if (typeof e.payload !== 'string' || e.payload.length === 0 || e.payload.length > 2048)
        throw new Error('chat:outbox:add: invalid payload');
      const now = Date.now();
      const db = getDbForIpc('chat:outbox:add');
      if (!db) throw new Error('chat:outbox:add: database closed');
      const result = db
        .prepareOnce(
          `INSERT INTO chat_outbox
        (protocol, view_key, channel, to_node, payload, reply_id, status, error,
         attempt_count, next_retry_at, created_at, updated_at, group_id, group_index, group_total,
         priority)
       VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
        )
        .run(
          e.protocol,
          e.viewKey,
          e.channel,
          e.toNode ?? null,
          e.payload,
          e.replyId ?? null,
          typeof e.status === 'string' && OUTBOX_VALID_STATUSES.has(e.status) ? e.status : 'queued',
          e.error ?? null,
          e.nextRetryAt ?? null,
          e.createdAt ?? now,
          now,
          e.groupId ?? null,
          e.groupIndex ?? null,
          e.groupTotal ?? null,
          e.priority === 'emergency' ? 'emergency' : 'normal',
        );
      const row = db
        .prepareOnce('SELECT * FROM chat_outbox WHERE id = ?')
        .get(result.lastInsertRowid) as Record<string, unknown>;
      return rowToOutboxEntry(row);
    } catch (err) {
      finishDbIpcHandler('chat:outbox:add', err);
    }
  });

  ipcMain.handle(
    'chat:outbox:updateStatus',
    (
      event,
      id: unknown,
      status: unknown,
      error?: unknown,
      nextRetryAt?: unknown,
      attemptCount?: unknown,
    ) => {
      try {
        assertIpcSender(event, 'chat:outbox:updateStatus');
        if (typeof id !== 'number' || !Number.isInteger(id))
          throw new Error('chat:outbox:updateStatus: invalid id');
        if (typeof status !== 'string' || !OUTBOX_VALID_STATUSES.has(status))
          throw new Error('chat:outbox:updateStatus: invalid status');
        const db = getDbForIpc('chat:outbox:updateStatus');
        if (!db) return;
        if (typeof attemptCount === 'number' && Number.isInteger(attemptCount)) {
          db.prepareOnce(
            'UPDATE chat_outbox SET status = ?, error = ?, next_retry_at = ?, attempt_count = ?, updated_at = ? WHERE id = ?',
          ).run(
            status,
            typeof error === 'string' ? error : null,
            typeof nextRetryAt === 'number' ? nextRetryAt : null,
            attemptCount,
            Date.now(),
            id,
          );
        } else {
          db.prepareOnce(
            'UPDATE chat_outbox SET status = ?, error = ?, next_retry_at = ?, updated_at = ? WHERE id = ?',
          ).run(
            status,
            typeof error === 'string' ? error : null,
            typeof nextRetryAt === 'number' ? nextRetryAt : null,
            Date.now(),
            id,
          );
        }
      } catch (err) {
        finishDbIpcHandler('chat:outbox:updateStatus', err);
      }
    },
  );

  ipcMain.handle('chat:outbox:remove', (event, id: unknown) => {
    try {
      assertIpcSender(event, 'chat:outbox:remove');
      if (typeof id !== 'number' || !Number.isInteger(id))
        throw new Error('chat:outbox:remove: invalid id');
      const db = getDbForIpc('chat:outbox:remove');
      if (!db) return;
      db.prepareOnce('DELETE FROM chat_outbox WHERE id = ?').run(id);
    } catch (err) {
      finishDbIpcHandler('chat:outbox:remove', err);
    }
  });
}

function rowToOutboxEntry(row: Record<string, unknown>) {
  return {
    id: row.id as number,
    protocol: row.protocol as string,
    viewKey: row.view_key as string,
    channel: row.channel as number,
    toNode: (row.to_node as number | null) ?? null,
    payload: row.payload as string,
    replyId: (row.reply_id as number | null) ?? null,
    status: row.status as string,
    error: (row.error as string | null) ?? null,
    attemptCount: (row.attempt_count as number) ?? 0,
    nextRetryAt: (row.next_retry_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    groupId: (row.group_id as string | null) ?? null,
    groupIndex: (row.group_index as number | null) ?? null,
    groupTotal: (row.group_total as number | null) ?? null,
    priority: (row.priority as string) === 'emergency' ? 'emergency' : 'normal',
  };
}
