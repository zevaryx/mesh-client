/**
 * `utilityProcess` entry for the Meshtastic background ingest (desktop; bundled by
 * `scripts/esbuild-main-build.mjs` as `meshtastic-backend.js`). Commands arrive on
 * `process.parentPort`; ingest output goes back as {@link MeshtasticBackendEvent}s.
 */
import {
  applyMeshtasticBackendCommand,
  isMeshtasticBackendCommand,
  type MeshtasticBackendEvent,
} from './hostProtocol';
import { MeshtasticBackendIngest } from './meshtasticBackendIngest';

const port = process.parentPort;
const post = (event: MeshtasticBackendEvent): void => {
  port.postMessage(event);
};

const ingest = new MeshtasticBackendIngest({
  persistMessage: (row) => {
    post({ t: 'persist', row });
  },
  writeToRadio: (frame) => {
    post({ t: 'write', frame });
  },
  onCaughtUp: (count) => {
    post({ t: 'caughtUp', count });
  },
});

port.on('message', (e) => {
  const cmd: unknown = e.data;
  if (!isMeshtasticBackendCommand(cmd)) {
    console.warn('[meshtastic-backend] dropped malformed command');
    return;
  }
  applyMeshtasticBackendCommand(ingest, cmd);
});
