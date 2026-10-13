// @vitest-environment node
import { webcrypto } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installInsecureContextFallbacks, randomUuidFrom } from './insecureContextFallbacks';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('insecure context fallbacks (headless web UI over plain HTTP)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds version 4 UUIDs from getRandomValues', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => randomUuidFrom((bytes) => webcrypto.getRandomValues(bytes))),
    );
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    // Version and variant bits are forced even from all-ones / all-zeros input.
    expect(randomUuidFrom((bytes) => bytes.fill(0xff))).toBe(
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    );
    expect(randomUuidFrom((bytes) => bytes.fill(0))).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('adds crypto.randomUUID when the browser hides it, and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const crypto: { getRandomValues: typeof webcrypto.getRandomValues; randomUUID?: () => string } =
      { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
    installInsecureContextFallbacks({ crypto, isSecureContext: false });
    expect(crypto.randomUUID?.()).toMatch(UUID_V4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('not a secure context');
  });

  it('keeps the native randomUUID and stays quiet in a secure context', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const native = vi.fn(() => 'native');
    const crypto = {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      randomUUID: native,
    };
    installInsecureContextFallbacks({ crypto, isSecureContext: true });
    expect(crypto.randomUUID()).toBe('native');
    expect(warn).not.toHaveBeenCalled();
  });
});
