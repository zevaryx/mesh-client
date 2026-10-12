/**
 * Persistent app settings IPC (`appSettings:*`, SQLite `app_settings` key/value).
 *
 * Shared by the Electron main process and the headless server. Keys are allow-listed so a
 * compromised renderer (or, headless, a token holder) cannot write arbitrary rows.
 */
import { ipcMain } from 'electron';

import {
  MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX,
  MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX,
  MESHCORE_ROOM_LAST_POST_SETTING_PREFIX,
  MESHCORE_ROOM_SYNC_SETTING_PREFIX,
  MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX,
} from '../../shared/appSettingsKeyPrefixes';
import type { NodeSqliteDB } from '../db-compat';
import { sanitizeLogMessage } from '../sanitize-log-message';
import { validateIpcSender } from '../validate-ipc-sender';

// Allow-list keys to prevent arbitrary writes from a compromised renderer.
const APP_SETTINGS_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'meshtasticMessageRetentionEnabled',
  'meshtasticMessageRetentionCount',
  'meshcoreMessageRetentionEnabled',
  'meshcoreMessageRetentionCount',
  'reticulumMessageRetentionEnabled',
  'reticulumMessageRetentionCount',
  'rrcMessageRetentionEnabled',
  'rrcMessageRetentionCount',
  'locale',
  'mapBasemapId',
  'meshtasticMqttClientId',
  'meshcoreMqttClientId',
  'meshtasticConfigureTargetNodeNum',
  'meshtasticLastRfSelfNodeId',
  'meshtasticOwnNodeNumsByPublicKey',
  'meshcoreLastSelfNodeId',
  'storeForwardAutoFetchHistory',
  'storeForwardHistoryProfile',
  'reduceMotion',
  'use24HourTime',
  'notificationSounds',
  'alwaysShowMessageActions',
  'reticulumAutostart',
  'reticulumAutoResendOnAnnounce',
  'autoUpdateDownloadEnabled',
  'reticulumLastSelfLxmfHash',
  'reticulumRmapAnnounceIntervalMin',
  'reticulumRmapReachableOn',
  'reticulumRmapHeightMeters',
  'reticulumRmapDiscoveryLxmfAddress',
  'reticulumRmapDiscoveryStampValue',
  'reticulumRmapDiscoveryEncrypt',
  'reticulumRmapPublishIfac',
  /** Legacy blob; prefer meshtasticRemoteAdminKey:<nodeNum> per-node keys. */
  'meshtasticRemoteAdminKeyByNode',
]);
const APP_SETTINGS_MAX_VALUE_LENGTH = 256;

export function isAppSettingsKeyAllowed(key: string): boolean {
  return (
    APP_SETTINGS_ALLOWED_KEYS.has(key) ||
    key.startsWith(MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_ROOM_SYNC_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_ROOM_LAST_POST_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX)
  );
}

export function isLegacyPlaintextCredentialKey(key: string): boolean {
  return (
    key.startsWith(MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX)
  );
}

export function appSettingsMaxValueLengthForKey(key: string): number {
  if (key === 'notificationSounds') return 4096;
  if (key === 'meshtasticOwnNodeNumsByPublicKey') return 4096;
  if (
    key.startsWith(MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX) ||
    key.startsWith(MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX)
  ) {
    return 512;
  }
  return APP_SETTINGS_MAX_VALUE_LENGTH;
}

export interface AppSettingsIpcDeps {
  getDatabase: () => NodeSqliteDB;
}

/** Register `appSettings:get|set|remove`. Channel name literals keep check:ipc-contract aligned. */
export function registerAppSettingsIpcHandlers(deps: AppSettingsIpcDeps): void {
  ipcMain.handle('appSettings:get', (event) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    try {
      const rows = deps.getDatabase().prepareOnce('SELECT key, value FROM app_settings').all() as {
        key: string;
        value: string;
      }[];
      const out: Record<string, string> = {};
      for (const row of rows) {
        if (typeof row.key === 'string' && typeof row.value === 'string') {
          out[row.key] = row.value;
        }
      }
      return out;
    } catch (err) {
      console.error(
        '[IPC] appSettings:get failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('appSettings:set', (event, key: unknown, value: unknown) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    if (typeof key !== 'string' || !isAppSettingsKeyAllowed(key)) {
      throw new Error('appSettings:set: key not allowed');
    }
    if (isLegacyPlaintextCredentialKey(key)) {
      throw new Error('appSettings:set: plaintext credentials are not allowed');
    }
    const maxValueLength = appSettingsMaxValueLengthForKey(key);
    if (typeof value !== 'string' || value.length > maxValueLength) {
      throw new Error(`appSettings:set: value must be a string under ${maxValueLength} chars`);
    }
    try {
      const result = deps
        .getDatabase()
        .prepareOnce('INSERT OR REPLACE INTO app_settings(key, value) VALUES (?, ?)')
        .run(key, value);
      console.debug(`[IPC] appSettings:set: ${sanitizeLogMessage(key)} (${result.changes} rows)`);
      return { changes: Number(result.changes) };
    } catch (err) {
      console.error(
        '[IPC] appSettings:set failed:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
      throw err;
    }
  });

  ipcMain.handle('appSettings:remove', (event, key: unknown) => {
    if (!validateIpcSender(event)) {
      throw new Error('IPC sender validation failed');
    }
    if (typeof key !== 'string' || !isAppSettingsKeyAllowed(key)) {
      throw new Error('appSettings:remove: key not allowed');
    }
    const result = deps
      .getDatabase()
      .prepareOnce('DELETE FROM app_settings WHERE key = ?')
      .run(key);
    return { changes: Number(result.changes) };
  });
}
