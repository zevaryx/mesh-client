// @vitest-environment node
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatHeadlessAccessUrl,
  HEADLESS_DEFAULT_PORT,
  HeadlessConfigError,
  resolveHeadlessConfig,
} from './config';

const BUNDLE_DIR = path.resolve('/opt/mesh-client/dist-headless');

describe('resolveHeadlessConfig', () => {
  it('uses loopback, default port and a generated token by default', () => {
    const config = resolveHeadlessConfig({}, BUNDLE_DIR);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(HEADLESS_DEFAULT_PORT);
    expect(config.tokenGenerated).toBe(true);
    expect(config.token?.length).toBeGreaterThanOrEqual(32);
    expect(config.rendererDir).toBe(path.resolve('/opt/mesh-client/dist/renderer'));
    expect(config.bridgeScriptFile).toBe(path.join(BUNDLE_DIR, 'web-bridge.js'));
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).token).not.toBe(config.token);
  });

  it('reads explicit settings from the environment', () => {
    const config = resolveHeadlessConfig(
      {
        MESH_CLIENT_DATA_DIR: '/data',
        MESH_CLIENT_WEB_HOST: '0.0.0.0',
        MESH_CLIENT_WEB_PORT: '9000',
        MESH_CLIENT_WEB_TOKEN: 'a-long-enough-token',
        MESH_CLIENT_RENDERER_DIR: '/srv/renderer',
      },
      BUNDLE_DIR,
    );
    expect(config).toMatchObject({
      dataDir: path.resolve('/data'),
      host: '0.0.0.0',
      port: 9000,
      token: 'a-long-enough-token',
      tokenGenerated: false,
      rendererDir: path.resolve('/srv/renderer'),
    });
  });

  it('disables auth only when MESH_CLIENT_WEB_AUTH=off', () => {
    expect(resolveHeadlessConfig({ MESH_CLIENT_WEB_AUTH: 'off' }, BUNDLE_DIR).token).toBeNull();
    expect(() => resolveHeadlessConfig({ MESH_CLIENT_WEB_AUTH: 'none' }, BUNDLE_DIR)).toThrow(
      HeadlessConfigError,
    );
  });

  it('rejects short tokens and invalid ports', () => {
    expect(() => resolveHeadlessConfig({ MESH_CLIENT_WEB_TOKEN: 'short' }, BUNDLE_DIR)).toThrow(
      'at least 16',
    );
    for (const port of ['0', '70000', 'abc']) {
      expect(() => resolveHeadlessConfig({ MESH_CLIENT_WEB_PORT: port }, BUNDLE_DIR)).toThrow(
        'MESH_CLIENT_WEB_PORT',
      );
    }
  });
});

describe('formatHeadlessAccessUrl', () => {
  it('includes the encoded token and maps wildcard binds to localhost', () => {
    const config = resolveHeadlessConfig(
      { MESH_CLIENT_WEB_HOST: '0.0.0.0', MESH_CLIENT_WEB_TOKEN: 'tok/with+chars==xx' },
      BUNDLE_DIR,
    );
    expect(formatHeadlessAccessUrl(config, 8080)).toBe(
      'http://localhost:8080/?token=tok%2Fwith%2Bchars%3D%3Dxx',
    );
  });

  it('brackets IPv6 hosts and omits the token when auth is off', () => {
    const config = resolveHeadlessConfig(
      { MESH_CLIENT_WEB_HOST: '::1', MESH_CLIENT_WEB_AUTH: 'off' },
      BUNDLE_DIR,
    );
    expect(formatHeadlessAccessUrl(config, 1234)).toBe('http://[::1]:1234/');
  });
});
