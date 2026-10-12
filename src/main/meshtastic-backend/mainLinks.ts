/**
 * Link-keeper wiring shared by the Electron main process and the headless server: open TCP / HTTP
 * through the same bridges renderers use, and persist the target in `app_settings`.
 */
import { connectMeshtasticHttpFromMain } from '../ipc/http-bridge';
import { connectMeshtasticTcpFromMain } from '../ipc/tcp-bridge';
import type { MeshtasticLinkKeeperDeps } from './linkKeeper';
import type { MeshtasticLinkTarget } from './linkTarget';
import { loadMeshtasticLinkTarget, saveMeshtasticLinkTarget } from './linkTargetStore';

export function connectMeshtasticLinkFromMain(target: MeshtasticLinkTarget): Promise<void> {
  return target.kind === 'tcp'
    ? connectMeshtasticTcpFromMain(target.host, target.port)
    : connectMeshtasticHttpFromMain(target.host, target.tls);
}

export function mainMeshtasticLinkKeeperDeps(): MeshtasticLinkKeeperDeps {
  return {
    connect: connectMeshtasticLinkFromMain,
    loadTarget: loadMeshtasticLinkTarget,
    saveTarget: saveMeshtasticLinkTarget,
  };
}
