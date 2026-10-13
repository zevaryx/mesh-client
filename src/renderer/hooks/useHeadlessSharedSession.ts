import { useEffect, useRef } from 'react';

import { createSharedSessionSync, type SharedSessionRefresh } from '../lib/headlessSharedSession';
import { isWebHost } from '../lib/hostKind';
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
        connectTcp: (address) => connectionsRef.current[protocol].connectAutomatic('tcp', address),
        disconnect: () => connectionsRef.current[protocol].disconnect(),
      }),
    });
    const api = window.electronAPI.sharedSession;
    const offData = api.onDataChanged(sync.onDataChanged);
    const offLink = api.onLinkChanged(sync.onLinkChanged);
    return () => {
      offData();
      offLink();
      sync.dispose();
    };
  }, []);
}
