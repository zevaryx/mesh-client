/**
 * Loads the opt-in desktop background-ingest host bundle (`meshtastic-backend-host.js`, next to
 * `index.js`). Returns `null` with a warning when it is missing (e.g. `pnpm run dev` before
 * `pnpm run build:main`); the app then runs without the background ingest.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as DesktopHost from './desktopHostEntry';

export const MESHTASTIC_BACKEND_HOST_FILE = 'meshtastic-backend-host.js';

export function loadDesktopMeshtasticHost(dir: string = __dirname): typeof DesktopHost | null {
  const file = path.join(dir, MESHTASTIC_BACKEND_HOST_FILE);
  if (!fs.existsSync(file)) {
    console.warn(`[meshtastic-backend] ${MESHTASTIC_BACKEND_HOST_FILE} not built; disabled`);
    return null;
  }
  return createRequire(__filename)(file) as typeof DesktopHost;
}
