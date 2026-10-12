/**
 * Desktop host: runs the Meshtastic background ingest in an Electron `utilityProcess`, so
 * decoding stays off the main process event loop. Opt-in for now
 * (`MESH_CLIENT_MESHTASTIC_BACKEND=utility`) while the ingest is a spike.
 *
 * Failure behavior: if the worker bundle is missing or the process exits, the host logs a
 * warning and becomes a no-op; the renderer path is unaffected.
 */
import fs from 'node:fs';
import path from 'node:path';

import { utilityProcess } from 'electron';

import {
  dispatchMeshtasticBackendEvent,
  isMeshtasticBackendEvent,
  type MeshtasticBackendCommand,
  type MeshtasticBackendHandle,
  type MeshtasticBackendHostDeps,
} from './hostProtocol';

export const MESHTASTIC_BACKEND_WORKER_FILE = 'meshtastic-backend.js';

/** The part of Electron's `UtilityProcess` the host uses (lets tests inject a fake). */
export interface MeshtasticBackendChild {
  postMessage: (message: MeshtasticBackendCommand) => void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill: () => boolean;
}

function forkWorker(): MeshtasticBackendChild | null {
  const file = path.join(__dirname, MESHTASTIC_BACKEND_WORKER_FILE);
  if (!fs.existsSync(file)) {
    console.warn(`[meshtastic-backend] ${MESHTASTIC_BACKEND_WORKER_FILE} not built; disabled`);
    return null;
  }
  return utilityProcess.fork(file, [], { serviceName: 'Meshtastic backend' });
}

export function startUtilityMeshtasticBackend(
  deps: MeshtasticBackendHostDeps,
  fork: () => MeshtasticBackendChild | null = forkWorker,
): MeshtasticBackendHandle {
  let child = fork();
  let write: ((frame: Uint8Array) => void) | null = null;
  const send = (cmd: MeshtasticBackendCommand): void => {
    if (!child) return;
    try {
      child.postMessage(cmd);
    } catch (err) {
      console.warn('[meshtastic-backend] post to worker failed', err);
    }
  };
  if (child) {
    const current = child;
    current.on('message', (message) => {
      if (!isMeshtasticBackendEvent(message)) {
        console.warn('[meshtastic-backend] dropped malformed worker event');
        return;
      }
      dispatchMeshtasticBackendEvent(message, deps, write);
    });
    current.on('exit', (code) => {
      if (child !== current) return;
      console.warn(`[meshtastic-backend] worker exited (code ${String(code)}); disabled`);
      child = null;
    });
  }
  return {
    tap: {
      onOpen: (w) => {
        write = w;
        send({ t: 'open' });
      },
      onData: (bytes) => {
        send({ t: 'data', bytes });
      },
      onClose: () => {
        write = null;
        send({ t: 'close' });
      },
    },
    setRendererPresent: (value) => {
      send({ t: 'present', value });
    },
    dispose: () => {
      write = null;
      const current = child;
      child = null;
      current?.kill();
    },
  };
}
