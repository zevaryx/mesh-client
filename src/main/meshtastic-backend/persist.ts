/**
 * Main-process sink for Meshtastic background-ingest rows: the same validation and
 * `INSERT OR IGNORE` as `db:saveMessage`. Skips quietly while the database is closed.
 *
 * Blocked senders are dropped here, matching `PacketRouter` (a fully blocked LoRa sender is
 * never stored). The check reads `blocked_contacts` per row, so a block made in any tab applies
 * immediately, also in the desktop utilityProcess host, which has no database of its own.
 */
import { LORA_BLOCKLIST_SCOPE_ID, normalizeBlockedHash } from '../../shared/blockedContactHash';
import type { NodeSqliteDB } from '../db-compat';
import { getDbForIpc } from '../db-ipc-lifecycle';
import { validateSaveMessage } from '../ipc/db-ipc-validation';
import { insertMeshtasticMessageRow } from '../ipc/db-meshtastic-handlers';

export function isMeshtasticSenderBlocked(db: NodeSqliteDB, nodeNum: number): boolean {
  const row = db
    .prepareOnce(
      'SELECT 1 FROM blocked_contacts WHERE protocol = ? AND identity_id = ? AND blocked_hash = ? LIMIT 1',
    )
    .get('meshtastic', LORA_BLOCKLIST_SCOPE_ID, normalizeBlockedHash(String(nodeNum >>> 0)));
  return row !== undefined;
}

/** Returns true when a new row was written. */
export function persistMeshtasticBackendRow(row: unknown): boolean {
  validateSaveMessage(row);
  const db = getDbForIpc('meshtastic-backend:persist');
  if (!db) return false;
  if (isMeshtasticSenderBlocked(db, row.sender_id)) return false;
  return insertMeshtasticMessageRow(db, row).changes > 0;
}
