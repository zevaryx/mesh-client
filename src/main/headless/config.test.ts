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

describe('resolveHeadlessConfig secret key', () => {
  it('has no secret key by default (secrets stay in memory)', () => {
    const config = resolveHeadlessConfig({}, BUNDLE_DIR);
    expect(config.secretKey).toBeNull();
    expect(config.secretKeySource).toBeNull();
  });

  it('prefers the key file over the inline env var and trims it', () => {
    const config = resolveHeadlessConfig(
      {
        MESH_CLIENT_SECRET_KEY_FILE: '/run/secrets/k',
        MESH_CLIENT_SECRET_KEY: 'inline-key-material',
      },
      BUNDLE_DIR,
      (file) => (file === '/run/secrets/k' ? 'file-key-material-123\n' : ''),
    );
    expect(config.secretKey).toBe('file-key-material-123');
    expect(config.secretKeySource).toBe('file');
  });

  it('reads the inline env var when no file is set', () => {
    const config = resolveHeadlessConfig(
      { MESH_CLIENT_SECRET_KEY: 'inline-key-material' },
      BUNDLE_DIR,
    );
    expect(config).toMatchObject({ secretKey: 'inline-key-material', secretKeySource: 'env' });
  });

  it('fails clearly on an unreadable file or short key', () => {
    expect(() =>
      resolveHeadlessConfig({ MESH_CLIENT_SECRET_KEY_FILE: '/missing' }, BUNDLE_DIR, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow('MESH_CLIENT_SECRET_KEY_FILE could not be read: ENOENT');
    expect(() => resolveHeadlessConfig({ MESH_CLIENT_SECRET_KEY: 'short' }, BUNDLE_DIR)).toThrow(
      'secret key must be at least',
    );
  });
});

describe('resolveHeadlessConfig upload limit', () => {
  it('defaults to 64 MiB and accepts 1-1024 MiB', () => {
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).maxUploadBytes).toBe(64 * 1024 * 1024);
    expect(
      resolveHeadlessConfig({ MESH_CLIENT_WEB_MAX_UPLOAD_MB: '512' }, BUNDLE_DIR).maxUploadBytes,
    ).toBe(512 * 1024 * 1024);
    for (const bad of ['0', '2048', '1.5', 'lots']) {
      expect(() =>
        resolveHeadlessConfig({ MESH_CLIENT_WEB_MAX_UPLOAD_MB: bad }, BUNDLE_DIR),
      ).toThrow('MESH_CLIENT_WEB_MAX_UPLOAD_MB');
    }
  });
});

describe('resolveHeadlessConfig Meshtastic background ingest', () => {
  it('is on by default, can be turned off, and rejects other values', () => {
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).meshtasticBackgroundIngest).toBe(true);
    expect(
      resolveHeadlessConfig({ MESH_CLIENT_MESHTASTIC_BACKEND: ' OFF ' }, BUNDLE_DIR)
        .meshtasticBackgroundIngest,
    ).toBe(false);
    expect(() =>
      resolveHeadlessConfig({ MESH_CLIENT_MESHTASTIC_BACKEND: 'utility' }, BUNDLE_DIR),
    ).toThrow('MESH_CLIENT_MESHTASTIC_BACKEND must be "on" or "off"');
  });
});

describe('resolveHeadlessConfig MeshCore background ingest', () => {
  it('is on by default, can be turned off, and rejects other values', () => {
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).meshcoreBackgroundIngest).toBe(true);
    expect(
      resolveHeadlessConfig({ MESH_CLIENT_MESHCORE_BACKEND: 'off' }, BUNDLE_DIR)
        .meshcoreBackgroundIngest,
    ).toBe(false);
    expect(() =>
      resolveHeadlessConfig({ MESH_CLIENT_MESHCORE_BACKEND: 'yes' }, BUNDLE_DIR),
    ).toThrow('MESH_CLIENT_MESHCORE_BACKEND must be "on" or "off"');
  });
});

describe('resolveHeadlessConfig hardening options', () => {
  const files: Record<string, string> = { '/run/secrets/web_token': '  file-token-0123456789\n' };
  const readFile = (file: string): string => {
    const content = files[file];
    if (content === undefined) throw new Error('ENOENT');
    return content;
  };

  it('reads the token from a file (Docker secret) ahead of the variable', () => {
    const config = resolveHeadlessConfig(
      {
        MESH_CLIENT_WEB_TOKEN_FILE: '/run/secrets/web_token',
        MESH_CLIENT_WEB_TOKEN: 'env-token-0123456789',
      },
      BUNDLE_DIR,
      readFile,
    );
    expect(config.token).toBe('file-token-0123456789');
    expect(config.tokenSource).toBe('file');
    expect(config.tokenGenerated).toBe(false);
  });

  it('fails clearly on a missing, empty or short token file', () => {
    files['/run/secrets/empty'] = '\n';
    files['/run/secrets/short'] = 'short';
    expect(() =>
      resolveHeadlessConfig({ MESH_CLIENT_WEB_TOKEN_FILE: '/nope' }, BUNDLE_DIR, readFile),
    ).toThrow('MESH_CLIENT_WEB_TOKEN_FILE could not be read');
    expect(() =>
      resolveHeadlessConfig(
        { MESH_CLIENT_WEB_TOKEN_FILE: '/run/secrets/empty' },
        BUNDLE_DIR,
        readFile,
      ),
    ).toThrow('MESH_CLIENT_WEB_TOKEN_FILE is empty');
    expect(() =>
      resolveHeadlessConfig(
        { MESH_CLIENT_WEB_TOKEN_FILE: '/run/secrets/short' },
        BUNDLE_DIR,
        readFile,
      ),
    ).toThrow('at least 16');
  });

  it('reports where the token came from', () => {
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).tokenSource).toBe('generated');
    expect(
      resolveHeadlessConfig({ MESH_CLIENT_WEB_TOKEN: 'env-token-0123456789' }, BUNDLE_DIR)
        .tokenSource,
    ).toBe('env');
    expect(resolveHeadlessConfig({ MESH_CLIENT_WEB_AUTH: 'off' }, BUNDLE_DIR).tokenSource).toBe(
      null,
    );
  });

  it('parses allowed host names for auth-off mode', () => {
    expect(resolveHeadlessConfig({}, BUNDLE_DIR).allowedHosts).toEqual([]);
    expect(
      resolveHeadlessConfig(
        { MESH_CLIENT_WEB_ALLOWED_HOSTS: ' Station.Local , ,mesh.lan' },
        BUNDLE_DIR,
      ).allowedHosts,
    ).toEqual(['station.local', 'mesh.lan']);
  });

  it('parses the session cap and proxy trust', () => {
    const defaults = resolveHeadlessConfig({}, BUNDLE_DIR);
    expect(defaults.maxSessions).toBe(16);
    expect(defaults.trustProxy).toBe(false);
    const set = resolveHeadlessConfig(
      { MESH_CLIENT_WEB_MAX_SESSIONS: '4', MESH_CLIENT_WEB_TRUST_PROXY: 'on' },
      BUNDLE_DIR,
    );
    expect(set.maxSessions).toBe(4);
    expect(set.trustProxy).toBe(true);
    for (const value of ['0', '257', '2.5', 'x']) {
      expect(() =>
        resolveHeadlessConfig({ MESH_CLIENT_WEB_MAX_SESSIONS: value }, BUNDLE_DIR),
      ).toThrow('MESH_CLIENT_WEB_MAX_SESSIONS');
    }
    expect(() => resolveHeadlessConfig({ MESH_CLIENT_WEB_TRUST_PROXY: 'yes' }, BUNDLE_DIR)).toThrow(
      'MESH_CLIENT_WEB_TRUST_PROXY must be "on" or "off"',
    );
  });
});
