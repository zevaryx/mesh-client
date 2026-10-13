/**
 * Headless wiring for the MeshCore background session (`meshcore-backend/meshcoreBackground.ts`):
 * messages pulled while no tab is open go to the server's database through the same writer as
 * `db:saveMeshcoreMessage`, senders resolve from the stored contacts, and a link keeper reopens
 * the last TCP or serial link a tab used (after a server restart or a drop).
 */
import type { NodeSqliteDB } from '../db-compat';
import { getDbForIpc } from '../db-ipc-lifecycle';
import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import {
  MeshcoreBackground,
  type MeshcoreLinkKind,
  type MeshcoreStoredContact,
} from '../meshcore-backend/meshcoreBackground';
import { persistMeshcoreMessage } from '../meshcoreMessageChannel';
import { MeshtasticLinkKeeper } from '../meshtastic-backend/linkKeeper';
import { mainMeshcoreLinkKeeperDeps } from '../meshtastic-backend/mainLinks';

export interface MeshcoreBackgroundHost {
  taps: Record<MeshcoreLinkKind, TcpBridgeTap>;
  setRendererPresent: (present: boolean) => void;
  dispose: () => void;
}

/** Contact whose public key starts with `prefixHex` (lowercase hex), from `meshcore_contacts`. */
export function storedMeshcoreContactByPrefix(
  db: NodeSqliteDB | null,
  prefixHex: string,
): MeshcoreStoredContact | null {
  if (!db || !/^[0-9a-f]+$/.test(prefixHex)) return null;
  const row = db
    .prepareOnce(
      "SELECT node_id, COALESCE(NULLIF(TRIM(nickname), ''), adv_name) AS name, contact_type " +
        "FROM meshcore_contacts WHERE LOWER(public_key) LIKE ? || '%' LIMIT 1",
    )
    .get(prefixHex) as
    { node_id: number; name: string | null; contact_type: number | null } | undefined;
  if (!row) return null;
  return { nodeId: row.node_id >>> 0, name: row.name, contactType: row.contact_type ?? 0 };
}

export function startMeshcoreBackground(opts: {
  onCaughtUp: (count: number) => void;
  connectSerial: (portId: string, baudRate: number) => Promise<void>;
}): MeshcoreBackgroundHost {
  const background = new MeshcoreBackground({
    persist: (row) => {
      const db = getDbForIpc('meshcore-backend:persist');
      return db ? persistMeshcoreMessage(db, row).changes > 0 : false;
    },
    contactByPrefix: (prefixHex) =>
      storedMeshcoreContactByPrefix(getDbForIpc('meshcore-backend:contacts'), prefixHex),
    onCaughtUp: opts.onCaughtUp,
  });
  const keeper = new MeshtasticLinkKeeper(mainMeshcoreLinkKeeperDeps(opts.connectSerial));
  keeper.start();
  return {
    taps: {
      tcp: keeper.wrap(background.taps.tcp),
      serial: keeper.wrap(background.taps.serial),
    },
    setRendererPresent: (present) => {
      background.setRendererPresent(present);
      keeper.setRendererPresent(present);
    },
    dispose: () => {
      keeper.dispose();
      background.dispose();
    },
  };
}
