// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  createHeadlessSafeStorage,
  HEADLESS_SAFE_STORAGE_BACKEND,
  HEADLESS_SECRET_KEY_MIN_LENGTH,
} from './headlessSafeStorage';

const KEY = 'k'.repeat(HEADLESS_SECRET_KEY_MIN_LENGTH);

describe('createHeadlessSafeStorage', () => {
  it('round-trips strings with a configured key and never stores plaintext', () => {
    const storage = createHeadlessSafeStorage(KEY);
    expect(storage.isEncryptionAvailable()).toBe(true);
    expect(storage.getSelectedStorageBackend()).toBe(HEADLESS_SAFE_STORAGE_BACKEND);
    const sealed = storage.encryptString('private key ✓');
    expect(sealed.toString('utf8')).not.toContain('private key');
    expect(storage.decryptString(sealed)).toBe('private key ✓');
  });

  it('uses a fresh IV per encryption', () => {
    const storage = createHeadlessSafeStorage(KEY);
    expect(storage.encryptString('same').equals(storage.encryptString('same'))).toBe(false);
  });

  it('decrypts across instances with the same key, and fails with a different key', () => {
    const sealed = createHeadlessSafeStorage(KEY).encryptString('secret');
    expect(createHeadlessSafeStorage(KEY).decryptString(sealed)).toBe('secret');
    expect(() => createHeadlessSafeStorage('another-key-material').decryptString(sealed)).toThrow();
  });

  it('rejects tampered or foreign ciphertext', () => {
    const storage = createHeadlessSafeStorage(KEY);
    const sealed = storage.encryptString('secret');
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    expect(() => storage.decryptString(tampered)).toThrow();
    expect(() => storage.decryptString(Buffer.from('not ours at all, too short'))).toThrow(
      'Error while decrypting',
    );
  });

  it('reports encryption unavailable without a key, like Electron with no keyring', () => {
    const storage = createHeadlessSafeStorage(null);
    expect(storage.isEncryptionAvailable()).toBe(false);
    expect(storage.getSelectedStorageBackend()).not.toBe('basic_text');
    expect(() => storage.encryptString('x')).toThrow('Encryption is not available.');
    expect(() => storage.decryptString(Buffer.alloc(40))).toThrow('Encryption is not available.');
  });

  it('refuses short key material', () => {
    expect(() => createHeadlessSafeStorage('short')).toThrow('at least');
  });
});
