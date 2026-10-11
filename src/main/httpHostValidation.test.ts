// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isValidHttpHostname, validateHttpHost } from './httpHostValidation';

describe('isValidHttpHostname', () => {
  it('accepts common valid hostnames', () => {
    expect(isValidHttpHostname('example.com')).toBe(true);
    expect(isValidHttpHostname('my-router.local')).toBe(true);
    expect(isValidHttpHostname('192.168.1.1')).toBe(true);
    expect(isValidHttpHostname('a')).toBe(true);
    expect(isValidHttpHostname('sub.domain.example.org')).toBe(true);
  });

  it('accepts IPv6 bare and bracketed', () => {
    expect(isValidHttpHostname('::1')).toBe(true);
    expect(isValidHttpHostname('[::1]')).toBe(true);
    expect(isValidHttpHostname('fd00::1')).toBe(true);
    expect(isValidHttpHostname('[2001:db8::1]')).toBe(true);
    expect(isValidHttpHostname('fe80::1')).toBe(true);
  });

  it('rejects invalid hostnames', () => {
    expect(isValidHttpHostname('host with spaces')).toBe(false);
    expect(isValidHttpHostname('-leading-hyphen.com')).toBe(false);
    expect(isValidHttpHostname('trailing-hyphen-.com')).toBe(false);
    expect(isValidHttpHostname('')).toBe(false);
    expect(isValidHttpHostname('has..double.dot')).toBe(false);
    expect(isValidHttpHostname('999.999.999.999')).toBe(false);
    expect(isValidHttpHostname('gggg::1')).toBe(false);
  });
});

describe('validateHttpHost', () => {
  it('accepts bare hosts and authority strings with a port', () => {
    expect(() => {
      validateHttpHost('192.168.1.50');
    }).not.toThrow();
    expect(() => {
      validateHttpHost('192.168.1.50:80');
    }).not.toThrow();
    expect(() => {
      validateHttpHost('[fd00::1]:4403');
    }).not.toThrow();
    expect(() => {
      validateHttpHost('meshtastic.local');
    }).not.toThrow();
  });

  it('rejects non-strings, empty and over-long hosts', () => {
    expect(() => {
      validateHttpHost(42);
    }).toThrow('Invalid host');
    expect(() => {
      validateHttpHost('');
    }).toThrow('Invalid host');
    expect(() => {
      validateHttpHost(`${'a'.repeat(250)}.com`);
    }).toThrow('Invalid host');
  });

  it('rejects malformed hostnames', () => {
    expect(() => {
      validateHttpHost('host with spaces');
    }).toThrow('Invalid host format');
    expect(() => {
      validateHttpHost('-bad.example');
    }).toThrow('Invalid host format');
  });
});
