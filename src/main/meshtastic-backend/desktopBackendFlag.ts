/** Opt-in switch for the desktop Meshtastic background ingest (kept tiny: it lives in index.js). */
export const MESHTASTIC_BACKEND_ENV = 'MESH_CLIENT_MESHTASTIC_BACKEND';

export function isDesktopMeshtasticBackendEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MESHTASTIC_BACKEND_ENV]?.trim().toLowerCase() === 'on';
}
