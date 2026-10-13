/**
 * Builds the {@link LinkSharing} the headless server passes to the radio bridges. Kept apart from
 * `linkSharing.ts` (types and membership) so only the headless entry imports the implementations.
 */
import type { IpcMainInvokeEvent } from 'electron';

import { type LinkSharing, SharedLinkMembers } from './linkSharing';
import { MeshcoreTcpMux } from './meshcoreTcpMux';

export function createLinkSharing(opts: {
  sessionOf: (event: IpcMainInvokeEvent) => number | null;
  announce: LinkSharing['announce'];
}): LinkSharing {
  return {
    ...opts,
    members: () => new SharedLinkMembers(opts),
    meshcoreMux: (deps) => new MeshcoreTcpMux(deps),
  };
}
