/**
 * Link-keeper dependencies from main-process pieces: how to open a TCP / HTTP link (the bridges'
 * main-process connects) and the database the target is saved in. Pure, so the lazily loaded
 * desktop host bundle can build them from injected functions.
 */
import type { MeshtasticLinkKeeperDeps } from './linkKeeper';
import {
  type LinkTargetDb,
  loadMeshtasticLinkTarget,
  saveMeshtasticLinkTarget,
} from './linkTargetStore';

export interface MeshtasticLinkOpeners {
  connectTcp: (host: string, port: number) => Promise<void>;
  connectHttp: (host: string, tls: boolean) => Promise<void>;
}

export function meshtasticLinkKeeperDeps(
  open: MeshtasticLinkOpeners,
  getDb: LinkTargetDb,
): MeshtasticLinkKeeperDeps {
  return {
    connect: (target) =>
      target.kind === 'tcp'
        ? open.connectTcp(target.host, target.port)
        : open.connectHttp(target.host, target.tls),
    loadTarget: () => loadMeshtasticLinkTarget(getDb),
    saveTarget: (target) => {
      saveMeshtasticLinkTarget(getDb, target);
    },
  };
}
