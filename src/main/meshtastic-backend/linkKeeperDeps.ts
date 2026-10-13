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
  /** Headless only: a port on the server. */
  connectSerial?: (portId: string, baudRate: number) => Promise<void>;
}

export function meshtasticLinkKeeperDeps(
  open: MeshtasticLinkOpeners,
  getDb: LinkTargetDb,
  settingKey?: string,
  logTag?: string,
): MeshtasticLinkKeeperDeps {
  return {
    connect: (target) => {
      if (target.kind === 'tcp') return open.connectTcp(target.host, target.port);
      if (target.kind === 'http') return open.connectHttp(target.host, target.tls);
      if (!open.connectSerial) return Promise.reject(new Error('serial links are not kept here'));
      return open.connectSerial(target.portId, target.baudRate);
    },
    loadTarget: () => loadMeshtasticLinkTarget(getDb, settingKey),
    saveTarget: (target) => {
      saveMeshtasticLinkTarget(getDb, target, settingKey);
    },
    ...(logTag ? { logTag } : {}),
  };
}
