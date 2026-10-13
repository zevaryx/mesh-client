/**
 * Shared viewing (headless web UI: several browser tabs, one server) for the radio link bridges:
 * which tabs are on a link, and announcing link changes to every tab. Used by the TCP bridge
 * (`tcp-bridge.ts`) and the Meshtastic HTTP bridge (`http-bridge.ts`); see `TcpBridgeSharing`
 * for the rules.
 */
import type { IpcMainInvokeEvent } from 'electron';

export type SharedLinkAnnouncement =
  | { state: 'connected'; transport: 'tcp'; host: string; port: number }
  | { state: 'connected'; transport: 'http'; host: string; tls: boolean }
  | { state: 'disconnected'; transport: 'tcp' | 'http' };

export interface LinkSharing {
  /** Stable id of the calling renderer (a browser tab), or `null` when unknown. */
  sessionOf: (event: IpcMainInvokeEvent) => number | null;
  announce: (protocol: 'meshtastic' | 'meshcore', change: SharedLinkAnnouncement) => void;
}

/** The tabs on one link; a tab that closes leaves it. */
export class SharedLinkMembers {
  private readonly members = new Set<number>();

  constructor(private readonly sharing: LinkSharing) {}

  has(sid: number): boolean {
    return this.members.has(sid);
  }

  /** Add the calling tab; returns its session id, or `null` when unknown. */
  join(event: IpcMainInvokeEvent): number | null {
    const sid = this.sharing.sessionOf(event);
    if (sid === null || this.members.has(sid)) return sid;
    this.members.add(sid);
    const sender = event.sender as { once?: (name: 'destroyed', fn: () => void) => unknown };
    sender.once?.('destroyed', () => {
      this.members.delete(sid);
    });
    return sid;
  }

  /** True when the calling tab is known and not on the link. */
  isOutsider(event: IpcMainInvokeEvent): boolean {
    const sid = this.sharing.sessionOf(event);
    return sid !== null && !this.members.has(sid);
  }

  clear(): void {
    this.members.clear();
  }
}
