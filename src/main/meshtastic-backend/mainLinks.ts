/**
 * Link-keeper wiring for the headless server: open TCP / HTTP through the same bridges renderers
 * use, and keep the target in `app_settings`. (The desktop host builds the same from injected
 * functions; see `desktopHostEntry.ts`.)
 */
import { getDbForIpc } from '../db-ipc-lifecycle';
import { connectMeshtasticHttpFromMain } from '../ipc/http-bridge';
import { connectMeshtasticTcpFromMain } from '../ipc/tcp-bridge';
import type { MeshtasticLinkKeeperDeps } from './linkKeeper';
import { meshtasticLinkKeeperDeps } from './linkKeeperDeps';

export function mainMeshtasticLinkKeeperDeps(): MeshtasticLinkKeeperDeps {
  return meshtasticLinkKeeperDeps(
    { connectTcp: connectMeshtasticTcpFromMain, connectHttp: connectMeshtasticHttpFromMain },
    () => getDbForIpc('meshtastic-backend:link'),
  );
}
