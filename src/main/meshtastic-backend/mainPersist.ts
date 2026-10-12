/**
 * Database access for the background-ingest sink (`persist.ts`), from the main process's own
 * database module and SQL helpers. Kept apart from `persist.ts` so the desktop host bundle can
 * carry the sink logic while the database stays a main-bundle singleton.
 */
import { getDbForIpc } from '../db-ipc-lifecycle';
import {
  insertMeshtasticMessageRow,
  insertPositionHistoryRow,
  upsertMeshtasticNodeRow,
} from '../ipc/db-meshtastic-handlers';
import type { MeshtasticBackendPersistDb } from './persist';

export function mainMeshtasticBackendPersistDb(): MeshtasticBackendPersistDb {
  return {
    getDb: () => getDbForIpc('meshtastic-backend:persist'),
    insertMessage: insertMeshtasticMessageRow,
    upsertNode: upsertMeshtasticNodeRow,
    insertPosition: insertPositionHistoryRow,
  };
}
