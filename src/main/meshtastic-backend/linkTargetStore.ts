/**
 * Persists the Meshtastic link the keeper should restore (`app_settings`, main-process only:
 * the key is not in the renderer's `appSettings:set` allowlist). Returns `null` while the
 * database is closed or the stored value is malformed.
 */
import type { NodeSqliteDB } from '../db-compat';
import { type MeshtasticLinkTarget, parseMeshtasticLinkTarget } from './linkTarget';

export const MESHTASTIC_LINK_TARGET_SETTING = 'meshtasticBackgroundLink';

/** `getDb` returns the open database, or `null` while it is closed (nothing is read or written). */
export type LinkTargetDb = () => NodeSqliteDB | null;

/** The MeshCore background's saved link (same format). */
export const MESHCORE_LINK_TARGET_SETTING = 'meshcoreBackgroundLink';

export function loadMeshtasticLinkTarget(
  getDb: LinkTargetDb,
  key: string = MESHTASTIC_LINK_TARGET_SETTING,
): MeshtasticLinkTarget | null {
  const db = getDb();
  if (!db) return null;
  const row = db.prepareOnce('SELECT value FROM app_settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return null;
  try {
    return parseMeshtasticLinkTarget(JSON.parse(row.value));
  } catch {
    // catch-no-log-ok malformed stored JSON reads as "no saved link"
    return null;
  }
}

export function saveMeshtasticLinkTarget(
  getDb: LinkTargetDb,
  target: MeshtasticLinkTarget | null,
  key: string = MESHTASTIC_LINK_TARGET_SETTING,
): void {
  const db = getDb();
  if (!db) return;
  if (target === null) {
    db.prepareOnce('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepareOnce('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)').run(
    key,
    JSON.stringify(target),
  );
}
