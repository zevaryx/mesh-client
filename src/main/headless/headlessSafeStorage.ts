/**
 * Headless stand-in for Electron `safeStorage`.
 *
 * Electron encrypts with an OS keyring (Keychain, DPAPI, libsecret). A container has none, so the
 * operator supplies key material (`MESH_CLIENT_SECRET_KEY_FILE`, e.g. a Docker secret, or
 * `MESH_CLIENT_SECRET_KEY`). Values are sealed with AES-256-GCM under a key derived by scrypt.
 *
 * Without key material, `isEncryptionAvailable()` is false — the same signal Electron gives when
 * no keyring exists — so `SecureSecretStore` keeps secrets in process memory only and reports
 * `persistent: false`. Nothing is ever written in plaintext.
 *
 * This is weaker than an OS keyring: anyone who can read both the database and the key (or the
 * container's environment) can decrypt. Prefer a key file over the env var.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Minimum key-material length, so an operator cannot configure a trivially guessable key. */
export const HEADLESS_SECRET_KEY_MIN_LENGTH = 16;
/** Backend name reported by `getSelectedStorageBackend()` (never `basic_text`). */
export const HEADLESS_SAFE_STORAGE_BACKEND = 'headless_key';

const FORMAT_PREFIX = Buffer.from('mch1', 'ascii');
const KDF_SALT = 'mesh-client-headless-safe-storage-v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface HeadlessSafeStorage {
  isEncryptionAvailable: () => boolean;
  getSelectedStorageBackend: () => string;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
}

/** Build a safeStorage over `keyMaterial`; `null` means "no key configured". */
export function createHeadlessSafeStorage(keyMaterial: string | null): HeadlessSafeStorage {
  if (keyMaterial !== null && keyMaterial.length < HEADLESS_SECRET_KEY_MIN_LENGTH) {
    throw new Error(
      `headless secret key must be at least ${HEADLESS_SECRET_KEY_MIN_LENGTH} characters`,
    );
  }
  const key = keyMaterial === null ? null : scryptSync(keyMaterial, KDF_SALT, KEY_BYTES);

  const requireKey = (): Buffer => {
    if (!key) {
      // Same contract as Electron: callers must check isEncryptionAvailable() first.
      throw new Error('Encryption is not available.');
    }
    return key;
  };

  return {
    isEncryptionAvailable: () => key !== null,
    getSelectedStorageBackend: () => (key ? HEADLESS_SAFE_STORAGE_BACKEND : 'unknown'),
    encryptString: (plainText) => {
      const k = requireKey();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', k, iv);
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([FORMAT_PREFIX, iv, cipher.getAuthTag(), body]);
    },
    decryptString: (encrypted) => {
      const k = requireKey();
      const headerBytes = FORMAT_PREFIX.length + IV_BYTES + TAG_BYTES;
      if (
        encrypted.length < headerBytes ||
        !encrypted.subarray(0, FORMAT_PREFIX.length).equals(FORMAT_PREFIX)
      ) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.');
      }
      const ivEnd = FORMAT_PREFIX.length + IV_BYTES;
      const decipher = createDecipheriv(
        'aes-256-gcm',
        k,
        encrypted.subarray(FORMAT_PREFIX.length, ivEnd),
      );
      decipher.setAuthTag(encrypted.subarray(ivEnd, headerBytes));
      // A wrong key or tampered ciphertext fails authentication here and throws.
      return Buffer.concat([
        decipher.update(encrypted.subarray(headerBytes)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
