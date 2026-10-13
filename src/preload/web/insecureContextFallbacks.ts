/**
 * Browsers expose some APIs only in secure contexts (HTTPS, or `localhost`). Opening the headless
 * server over plain HTTP by LAN address or host name is not one, so:
 *
 * - `crypto.randomUUID` is missing: the renderer calls it when it connects, saves a location or
 *   sends a multi-part message. It is added here from `crypto.getRandomValues` (available
 *   everywhere), as a version 4 UUID like the native one.
 * - `crypto.subtle` is missing too and cannot be replaced: MeshCore channel decryption, MeshCore
 *   key checks and some Reticulum and translation features fail. Notifications and the clipboard
 *   are also limited. One warning in the console says so; the fix is HTTPS (a reverse proxy) or an
 *   SSH tunnel to `localhost`.
 */

/** The part of `window.crypto` used here. */
interface CryptoLike {
  getRandomValues(array: Uint8Array<ArrayBuffer>): unknown;
  randomUUID?: () => string;
}

/** A version 4 UUID (RFC 9562) from random bytes. */
export function randomUuidFrom(fillRandom: (bytes: Uint8Array<ArrayBuffer>) => unknown): string {
  const b = new Uint8Array(16);
  fillRandom(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function installInsecureContextFallbacks(win: {
  crypto: CryptoLike;
  isSecureContext: boolean;
}): void {
  const { crypto } = win;
  if (typeof crypto.randomUUID !== 'function') {
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => randomUuidFrom((bytes) => crypto.getRandomValues(bytes)),
      configurable: true,
      writable: true,
    });
  }
  if (!win.isSecureContext) {
    console.warn(
      '[web-bridge] this page is not a secure context (plain HTTP, not localhost): ' +
        'MeshCore channel decryption and other crypto features are unavailable. ' +
        'Serve it over HTTPS or open it through an SSH tunnel to localhost.',
    );
  }
}
