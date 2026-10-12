/**
 * Where the Meshtastic radio lives, as the main process connects to it (no Electron imports).
 * The background ingest's link keeper reconnects to the last target a renderer chose.
 */
export type MeshtasticLinkTarget =
  { kind: 'tcp'; host: string; port: number } | { kind: 'http'; host: string; tls: boolean };

/**
 * Who opened a link. Only renderers open links over IPC; `backend` links are opened by the
 * main-process link keeper while no renderer is present.
 */
export type MeshtasticLinkOrigin = 'renderer' | 'backend';

export interface MeshtasticLinkInfo {
  origin: MeshtasticLinkOrigin;
  target?: MeshtasticLinkTarget;
}

/** Parse a stored target; `null` for anything malformed (the store is trusted but versioned). */
export function parseMeshtasticLinkTarget(value: unknown): MeshtasticLinkTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.host !== 'string' || v.host.length === 0 || v.host.length > 253) return null;
  if (v.kind === 'tcp') {
    const port = v.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { kind: 'tcp', host: v.host, port };
  }
  if (v.kind === 'http' && typeof v.tls === 'boolean') {
    return { kind: 'http', host: v.host, tls: v.tls };
  }
  return null;
}
