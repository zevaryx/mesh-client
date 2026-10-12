// @vitest-environment node
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX,
  MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX,
  MESHCORE_ROOM_LAST_POST_SETTING_PREFIX,
  MESHCORE_ROOM_SYNC_SETTING_PREFIX,
  MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX,
} from './appSettingsKeyPrefixes';

/** The main-process allow-list lives in the shared app-settings IPC module. */
const APP_SETTINGS_IPC_SOURCE = readFileSync(
  join(__dirname, '../main/ipc/app-settings-handlers.ts'),
  'utf-8',
);

describe('appSettingsKeyPrefixes', () => {
  it('exports the canonical prefixes used by renderer storage modules', () => {
    expect(MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX).toBe('meshtasticRemoteAdminKey:');
    expect(MESHCORE_ROOM_SYNC_SETTING_PREFIX).toBe('meshcoreRoomSync:');
    expect(MESHCORE_ROOM_LAST_POST_SETTING_PREFIX).toBe('meshcoreRoomLastPost:');
    expect(MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX).toBe('meshcoreRoomCredential:');
    expect(MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX).toBe('meshcoreRepeaterCredential:');
  });

  it('is imported by main IPC allowlist (no duplicated string literals)', () => {
    expect(APP_SETTINGS_IPC_SOURCE).toContain("from '../../shared/appSettingsKeyPrefixes'");
    expect(APP_SETTINGS_IPC_SOURCE).toContain('MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX');
    expect(APP_SETTINGS_IPC_SOURCE).toContain('MESHCORE_ROOM_SYNC_SETTING_PREFIX');
    expect(APP_SETTINGS_IPC_SOURCE).toContain('MESHCORE_ROOM_LAST_POST_SETTING_PREFIX');
    expect(APP_SETTINGS_IPC_SOURCE).toContain('MESHCORE_ROOM_CREDENTIAL_SETTING_PREFIX');
    expect(APP_SETTINGS_IPC_SOURCE).toContain('MESHCORE_REPEATER_CREDENTIAL_SETTING_PREFIX');
    expect(APP_SETTINGS_IPC_SOURCE).not.toMatch(
      /const MESHTASTIC_REMOTE_ADMIN_KEY_SETTING_PREFIX = 'meshtasticRemoteAdminKey:'/,
    );
  });
});
