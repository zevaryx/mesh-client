/**
 * Main-process sink for Meshtastic background-ingest rows: the same validation and
 * `INSERT OR IGNORE` as `db:saveMessage`. Skips quietly while the database is closed.
 */
import { getDbForIpc } from '../db-ipc-lifecycle';
import { validateSaveMessage } from '../ipc/db-ipc-validation';
import { insertMeshtasticMessageRow } from '../ipc/db-meshtastic-handlers';

export function persistMeshtasticBackendRow(row: unknown): boolean {
  validateSaveMessage(row);
  const db = getDbForIpc('meshtastic-backend:persist');
  if (!db) return false;
  return insertMeshtasticMessageRow(db, row).changes > 0;
}
