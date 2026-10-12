/**
 * Environment configuration for the headless server (`pnpm run start:headless`, Docker image).
 *
 * | Variable                     | Default              | Meaning                                       |
 * | ---------------------------- | -------------------- | --------------------------------------------- |
 * | `MESH_CLIENT_DATA_DIR`       | `./mesh-client-data` | Stands in for Electron `userData`             |
 * | `MESH_CLIENT_WEB_HOST`       | `127.0.0.1`          | Bind address (`0.0.0.0` in the Docker image)  |
 * | `MESH_CLIENT_WEB_PORT`       | `8080`               | HTTP + WebSocket port                         |
 * | `MESH_CLIENT_WEB_TOKEN`      | random per start     | Session token (min 16 chars)                  |
 * | `MESH_CLIENT_WEB_AUTH`       | `token`              | `off` disables auth (isolated networks only)  |
 * | `MESH_CLIENT_RENDERER_DIR`   | `<bundle>/../dist/renderer` | Vite renderer build                    |
 * | `MESH_CLIENT_SECRET_KEY_FILE`| unset                | File with key material for stored secrets (Docker secret) |
 * | `MESH_CLIENT_SECRET_KEY`     | unset                | Same, inline (visible in `docker inspect`; prefer the file) |
 * | `MESH_CLIENT_WEB_MAX_UPLOAD_MB` | `64`              | Max total upload per browser file pick (1–1024 MiB) |
 * | `MESH_CLIENT_MESHTASTIC_BACKEND` | `on`            | `off` stops storing Meshtastic TCP chat while no tab owns the link |
 *
 * Without a secret key, credentials (MeshCore identity, MQTT passwords, …) stay in memory only and
 * are lost on restart; see `headlessSafeStorage.ts`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseTcpPortFromString } from '../../shared/tcpPort';
import { HEADLESS_SECRET_KEY_MIN_LENGTH } from './headlessSafeStorage';

export const HEADLESS_DEFAULT_PORT = 8080;
export const HEADLESS_MIN_TOKEN_LENGTH = 16;

export interface HeadlessConfig {
  dataDir: string;
  host: string;
  port: number;
  /** `null` when auth is disabled. */
  token: string | null;
  /** True when the token was generated at startup (printed once in the access URL). */
  tokenGenerated: boolean;
  rendererDir: string;
  bridgeScriptFile: string;
  /** Key material for headless `safeStorage`; `null` keeps secrets in memory only. */
  secretKey: string | null;
  secretKeySource: 'file' | 'env' | null;
  /** Max total bytes one browser file pick may upload. */
  maxUploadBytes: number;
  /** Store Meshtastic TCP chat in the server while no browser tab owns the link. */
  meshtasticBackgroundIngest: boolean;
}

export const HEADLESS_DEFAULT_MAX_UPLOAD_MB = 64;

export class HeadlessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessConfigError';
  }
}

/**
 * Resolve config from `env`. `bundleDir` is the directory of the built server bundle
 * (`dist-headless/`), next to which `web-bridge.js` is emitted.
 */
export function resolveHeadlessConfig(
  env: Record<string, string | undefined>,
  bundleDir: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8'),
): HeadlessConfig {
  const authMode = (env.MESH_CLIENT_WEB_AUTH ?? 'token').trim().toLowerCase();
  if (authMode !== 'token' && authMode !== 'off') {
    throw new HeadlessConfigError(`MESH_CLIENT_WEB_AUTH must be "token" or "off"`);
  }

  let token: string | null = null;
  let tokenGenerated = false;
  if (authMode === 'token') {
    const configured = env.MESH_CLIENT_WEB_TOKEN?.trim();
    if (configured) {
      if (configured.length < HEADLESS_MIN_TOKEN_LENGTH) {
        throw new HeadlessConfigError(
          `MESH_CLIENT_WEB_TOKEN must be at least ${HEADLESS_MIN_TOKEN_LENGTH} characters`,
        );
      }
      token = configured;
    } else {
      token = randomBytes(24).toString('base64url');
      tokenGenerated = true;
    }
  }

  const rawPort = env.MESH_CLIENT_WEB_PORT?.trim();
  const port = rawPort ? parseTcpPortFromString(rawPort, -1) : HEADLESS_DEFAULT_PORT;
  if (port < 0) {
    throw new HeadlessConfigError('MESH_CLIENT_WEB_PORT must be an integer 1-65535');
  }

  let secretKey: string | null = null;
  let secretKeySource: HeadlessConfig['secretKeySource'] = null;
  const keyFile = env.MESH_CLIENT_SECRET_KEY_FILE?.trim();
  if (keyFile) {
    try {
      secretKey = readFile(keyFile).trim();
    } catch (err) {
      throw new HeadlessConfigError(
        `MESH_CLIENT_SECRET_KEY_FILE could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    secretKeySource = 'file';
  } else if (env.MESH_CLIENT_SECRET_KEY?.trim()) {
    secretKey = env.MESH_CLIENT_SECRET_KEY.trim();
    secretKeySource = 'env';
  }
  if (secretKey !== null && secretKey.length < HEADLESS_SECRET_KEY_MIN_LENGTH) {
    throw new HeadlessConfigError(
      `secret key must be at least ${HEADLESS_SECRET_KEY_MIN_LENGTH} characters`,
    );
  }

  const rawUpload = env.MESH_CLIENT_WEB_MAX_UPLOAD_MB?.trim();
  const uploadMb = rawUpload ? Number(rawUpload) : HEADLESS_DEFAULT_MAX_UPLOAD_MB;
  if (!Number.isInteger(uploadMb) || uploadMb < 1 || uploadMb > 1024) {
    throw new HeadlessConfigError('MESH_CLIENT_WEB_MAX_UPLOAD_MB must be an integer 1-1024');
  }

  const backendMode = (env.MESH_CLIENT_MESHTASTIC_BACKEND ?? 'on').trim().toLowerCase();
  if (backendMode !== 'on' && backendMode !== 'off') {
    throw new HeadlessConfigError('MESH_CLIENT_MESHTASTIC_BACKEND must be "on" or "off"');
  }

  return {
    meshtasticBackgroundIngest: backendMode === 'on',
    maxUploadBytes: uploadMb * 1024 * 1024,
    secretKey,
    secretKeySource,
    dataDir: path.resolve(env.MESH_CLIENT_DATA_DIR?.trim() || 'mesh-client-data'),
    host: env.MESH_CLIENT_WEB_HOST?.trim() || '127.0.0.1',
    port,
    token,
    tokenGenerated,
    rendererDir: path.resolve(
      env.MESH_CLIENT_RENDERER_DIR?.trim() || path.join(bundleDir, '..', 'dist', 'renderer'),
    ),
    bridgeScriptFile: path.join(bundleDir, 'web-bridge.js'),
  };
}

/** URL to print at startup; includes the token so the first page load can authenticate. */
export function formatHeadlessAccessUrl(config: HeadlessConfig, boundPort: number): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const hostPart = host.includes(':') ? `[${host}]` : host;
  const base = `http://${hostPart}:${boundPort}/`;
  return config.token === null ? base : `${base}?token=${encodeURIComponent(config.token)}`;
}
