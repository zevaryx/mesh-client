/**
 * Link-keeper wiring for the headless server: open TCP / HTTP through the same bridges renderers
 * use (serial through the server's serial bridge), and keep the target in `app_settings`. (The
 * desktop host builds the Meshtastic one from injected functions; see `desktopHostEntry.ts`.)
 */
import { getDbForIpc } from '../db-ipc-lifecycle';
import { connectMeshtasticHttpFromMain } from '../ipc/http-bridge';
import { connectTcpFromMain } from '../ipc/tcp-bridge';
import type { MeshtasticLinkKeeperDeps } from './linkKeeper';
import { meshtasticLinkKeeperDeps } from './linkKeeperDeps';
import { MESHCORE_LINK_TARGET_SETTING } from './linkTargetStore';

type SerialOpener = (portId: string, baudRate: number) => Promise<void>;

export function mainMeshtasticLinkKeeperDeps(
  connectSerial?: SerialOpener,
): MeshtasticLinkKeeperDeps {
  return meshtasticLinkKeeperDeps(
    {
      connectTcp: (host, port) => connectTcpFromMain('meshtastic', host, port),
      connectHttp: connectMeshtasticHttpFromMain,
      ...(connectSerial ? { connectSerial } : {}),
    },
    () => getDbForIpc('meshtastic-backend:link'),
  );
}

/** MeshCore background session (TCP or serial companion radio); its target has its own key. */
export function mainMeshcoreLinkKeeperDeps(connectSerial?: SerialOpener): MeshtasticLinkKeeperDeps {
  return meshtasticLinkKeeperDeps(
    {
      connectTcp: (host, port) => connectTcpFromMain('meshcore', host, port),
      connectHttp: () => Promise.reject(new Error('MeshCore has no HTTP links')),
      ...(connectSerial ? { connectSerial } : {}),
    },
    () => getDbForIpc('meshcore-backend:link'),
    MESHCORE_LINK_TARGET_SETTING,
    'meshcore-backend',
  );
}
