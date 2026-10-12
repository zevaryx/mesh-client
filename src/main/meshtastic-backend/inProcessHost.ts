/**
 * Headless host: runs the Meshtastic background ingest in the server process. The headless
 * server is plain Node already, so a separate process would add no isolation it needs.
 */
import {
  applyMeshtasticBackendCommand,
  createMeshtasticLinkTaps,
  dispatchMeshtasticBackendEvent,
  type MeshtasticBackendHandle,
  type MeshtasticBackendHostDeps,
} from './hostProtocol';
import { MeshtasticBackendIngest } from './meshtasticBackendIngest';

export function startInProcessMeshtasticBackend(
  deps: MeshtasticBackendHostDeps,
): MeshtasticBackendHandle {
  let ingest: MeshtasticBackendIngest | null = null;
  const links = createMeshtasticLinkTaps((cmd) => {
    if (ingest) applyMeshtasticBackendCommand(ingest, cmd);
  });
  ingest = new MeshtasticBackendIngest({
    persist: (record) => {
      dispatchMeshtasticBackendEvent({ t: 'persist', record }, deps, links.write);
    },
    writeToRadio: (frame) => {
      dispatchMeshtasticBackendEvent({ t: 'write', frame }, deps, links.write);
    },
    onCaughtUp: (count) => {
      dispatchMeshtasticBackendEvent({ t: 'caughtUp', count }, deps, links.write);
    },
  });
  const running = ingest;
  return {
    taps: links.taps,
    setRendererPresent: (present) => {
      running.setRendererPresent(present);
    },
    dispose: () => {
      ingest = null;
      running.dispose();
    },
  };
}
