/**
 * Main-owned secure secret storage IPC (`secureSecrets:*`).
 *
 * Shared by the Electron main process and the headless server; values are sealed by
 * `safeStorage` (OS keyring in Electron, operator key headless) — see `secure-secret-store.ts`.
 */
import { ipcMain } from 'electron';

import { MS_PER_MINUTE } from '../../shared/timeConstants';
import type { NodeSqliteDB } from '../db-compat';
import { createIpcRateLimiter } from '../ipcRateLimit';
import { SecureSecretStore } from '../secure-secret-store';
import { assertIpcSender } from '../validate-ipc-sender';

export interface SecureSecretsIpcDeps {
  getDatabase: () => NodeSqliteDB;
}

/** Register every `secureSecrets:*` handler. Channel name literals keep check:ipc-contract aligned. */
export function registerSecureSecretsIpcHandlers(deps: SecureSecretsIpcDeps): void {
  /** Typed secure-secret operations — max 120 / 60s for startup hydration and migrations. */
  const secureSecretIpcRateLimit = createIpcRateLimiter({
    max: 120,
    windowMs: MS_PER_MINUTE,
    label: 'secureSecrets',
  });
  const secureSecretStore = new SecureSecretStore(deps.getDatabase);

  ipcMain.handle('secureSecrets:status', (event) => {
    assertIpcSender(event, 'secureSecrets:status');
    secureSecretIpcRateLimit.checkOrThrow();
    return secureSecretStore.status();
  });

  ipcMain.handle('secureSecrets:list', (event) => {
    assertIpcSender(event, 'secureSecrets:list');
    secureSecretIpcRateLimit.checkOrThrow();
    return secureSecretStore.list();
  });

  ipcMain.handle('secureSecrets:getAll', (event) => {
    assertIpcSender(event, 'secureSecrets:getAll');
    secureSecretIpcRateLimit.checkOrThrow();
    return secureSecretStore.getAll();
  });

  ipcMain.handle('secureSecrets:get', (event, key: unknown) => {
    assertIpcSender(event, 'secureSecrets:get');
    secureSecretIpcRateLimit.checkOrThrow();
    return secureSecretStore.get(key);
  });

  ipcMain.handle(
    'secureSecrets:set',
    (event, key: unknown, value: unknown, requirePersistent?: unknown) => {
      assertIpcSender(event, 'secureSecrets:set');
      secureSecretIpcRateLimit.checkOrThrow();
      return secureSecretStore.set(key, value, requirePersistent);
    },
  );

  ipcMain.handle('secureSecrets:remove', (event, key: unknown) => {
    assertIpcSender(event, 'secureSecrets:remove');
    secureSecretIpcRateLimit.checkOrThrow();
    secureSecretStore.remove(key);
  });

  ipcMain.handle('secureSecrets:migrateLegacyIdentityCiphertext', (event, ciphertext: unknown) => {
    assertIpcSender(event, 'secureSecrets:migrateLegacyIdentityCiphertext');
    secureSecretIpcRateLimit.checkOrThrow();
    return secureSecretStore.migrateLegacyIdentityCiphertext(ciphertext);
  });

  ipcMain.handle(
    'secureSecrets:migrateLegacyBackupCiphertext',
    (event, protocol: unknown, id: unknown, format: unknown, ciphertext: unknown) => {
      assertIpcSender(event, 'secureSecrets:migrateLegacyBackupCiphertext');
      secureSecretIpcRateLimit.checkOrThrow();
      return secureSecretStore.migrateLegacyBackupCiphertext(protocol, id, format, ciphertext);
    },
  );
}
