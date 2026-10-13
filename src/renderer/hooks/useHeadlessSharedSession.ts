import { useEffect, useRef } from 'react';

import {
  createSharedSessionSync,
  sharedLinkConnectArgs,
  type SharedSessionRefresh,
} from '../lib/headlessSharedSession';
import { isWebHost } from '../lib/hostKind';
import { loadLastConnection } from '../lib/lastConnectionStorage';
import type { MeshProtocol } from '../lib/types';
import type { ProtocolConnectionActions } from './useProtocolConnection';

/**
 * Web UI only: follow what other browser tabs on the same server change (see
 * `lib/headlessSharedSession.ts`). Mount once from `App.tsx`; a no-op on desktop.
 */
export function useHeadlessSharedSession(
  refresh: Record<MeshProtocol, SharedSessionRefresh>,
  connections: Record<'meshtastic' | 'meshcore', ProtocolConnectionActions>,
): void {
  // Latest values without resubscribing on every render.
  const refreshRef = useRef(refresh);
  const connectionsRef = useRef(connections);
  useEffect(() => {
    refreshRef.current = refresh;
    connectionsRef.current = connections;
  });

  useEffect(() => {
    if (!isWebHost()) return;
    const sync = createSharedSessionSync({
      refresh: (protocol) => refreshRef.current[protocol],
      link: (protocol) => ({
        status: () => connectionsRef.current[protocol].state.status,
        join: (change) => {
          const args = sharedLinkConnectArgs(change, loadLastConnection(protocol));
          if (!args) return Promise.resolve();
          const conn = connectionsRef.current[protocol];
          return args.type === 'serial'
            ? conn.connectAutomatic('serial', undefined, args.portId)
            : conn.connectAutomatic(args.type, args.address);
        },
        disconnect: () => connectionsRef.current[protocol].disconnect(),
      }),
    });
    const api = window.electronAPI.sharedSession;
    const offData = api.onDataChanged(sync.onDataChanged);
    const offLink = api.onLinkChanged(sync.onLinkChanged);
    // A tab opened while the server already holds a radio link (another browser, or the
    // background after a restart) joins it instead of showing Disconnected.
    api
      .getLinkState()
      .then((links) => {
        sync.joinOpenLinks(links, (protocol) =>
          protocol === 'meshtastic' || protocol === 'meshcore'
            ? loadLastConnection(protocol) !== null
            : false,
        );
      })
      .catch((err: unknown) => {
        console.warn('[sharedSession] reading the open links failed', err);
      });
    return () => {
      offData();
      offLink();
      sync.dispose();
    };
  }, []);
}
