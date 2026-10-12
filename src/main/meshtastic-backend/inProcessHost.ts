/**
 * Headless host: runs the Meshtastic background ingest in the server process. The headless
 * server is plain Node already, so a separate process would add no isolation it needs.
 */
import {
  dispatchMeshtasticBackendEvent,
  type MeshtasticBackendHandle,
  type MeshtasticBackendHostDeps,
} from './hostProtocol';
import { MeshtasticBackendIngest } from './meshtasticBackendIngest';

export function startInProcessMeshtasticBackend(
  deps: MeshtasticBackendHostDeps,
): MeshtasticBackendHandle {
  let write: ((frame: Uint8Array) => void) | null = null;
  const ingest = new MeshtasticBackendIngest({
    persist: (record) => {
      dispatchMeshtasticBackendEvent({ t: 'persist', record }, deps, write);
    },
    writeToRadio: (frame) => {
      dispatchMeshtasticBackendEvent({ t: 'write', frame }, deps, write);
    },
    onCaughtUp: (count) => {
      dispatchMeshtasticBackendEvent({ t: 'caughtUp', count }, deps, write);
    },
  });
  return {
    tap: {
      onOpen: (w) => {
        write = w;
        ingest.linkOpened();
      },
      onData: (chunk) => {
        ingest.pushBytes(chunk);
      },
      onClose: () => {
        write = null;
        ingest.linkClosed();
      },
    },
    setRendererPresent: (present) => {
      ingest.setRendererPresent(present);
    },
    dispose: () => {
      write = null;
      ingest.dispose();
    },
  };
}
