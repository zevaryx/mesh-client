/**
 * Persists the Meshtastic link the keeper should restore (`app_settings`, main-process only:
 * the key is not in the renderer's `appSettings:set` allowlist). Returns `null` while the
 * database is closed or the stored value is malformed.
 */
import { getDbForIpc } from '../db-ipc-lifecycle';
import { type MeshtasticLinkTarget, parseMeshtasticLinkTarget } from './linkTarget';

export const MESHTASTIC_LINK_TARGET_SETTING = 'meshtasticBackgroundLink';

export function loadMeshtasticLinkTarget(): MeshtasticLinkTarget | null {
  const db = getDbForIpc('meshtastic-backend:loadLink');
  if (!db) return null;
  const row = db
    .prepareOnce('SELECT value FROM app_settings WHERE key = ?')
    .get(MESHTASTIC_LINK_TARGET_SETTING) as { value: string } | undefined;
  if (!row) return null;
  try {
    return parseMeshtasticLinkTarget(JSON.parse(row.value));
  } catch {
    // catch-no-log-ok malformed stored JSON reads as "no saved link"
    return null;
  }
}

export function saveMeshtasticLinkTarget(target: MeshtasticLinkTarget | null): void {
  const db = getDbForIpc('meshtastic-backend:saveLink');
  if (!db) return;
  if (target === null) {
    db.prepareOnce('DELETE FROM app_settings WHERE key = ?').run(MESHTASTIC_LINK_TARGET_SETTING);
    return;
  }
  db.prepareOnce('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)').run(
    MESHTASTIC_LINK_TARGET_SETTING,
    JSON.stringify(target),
  );
}
