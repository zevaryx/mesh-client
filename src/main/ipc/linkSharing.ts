/**
 * Shared viewing (headless web UI: several browser tabs, one server) for the radio link bridges.
 * Without it each tab that connects replaces the socket (TCP) or restarts the polling (HTTP),
 * which reconnects the radio and makes it resend its config. This tap, given to the bridges by
 * the headless server only (the desktop main bundle never imports this module), makes them:
 *
 * - let a tab connecting to the open link's target join it when it is not on it yet; a tab already
 *   on it that connects again still gets a fresh link (its own recovery path);
 * - keep the link when a tab that is not on it sends a disconnect (MeshCore cleans up before
 *   connecting);
 * - announce each opened link and each user disconnect to every tab, so disconnected tabs join
 *   and connected tabs drop it;
 * - for MeshCore, send commands from all tabs one at a time and replies only to the tab that
 *   asked (`meshcoreTcpMux.ts`).
 *
 * Membership survives a socket a member replaced; it is cleared when the link drops (every tab
 * reconnects: the first opens it, the rest join) or a user disconnects it.
 */
import type { IpcMainInvokeEvent } from 'electron';

import type { MeshtasticLinkTarget } from '../meshtastic-backend/linkTarget';
import { MeshcoreTcpMux } from './meshcoreTcpMux';
import type { TcpBridgeTap } from './tcp-bridge';

export type SharedLinkAnnouncement =
  | { state: 'connected'; transport: 'tcp'; host: string; port: number }
  | { state: 'connected'; transport: 'http'; host: string; tls: boolean }
  | { state: 'disconnected'; transport: 'tcp' | 'http' };

export interface SharedLinkTapOptions {
  protocol: 'meshtastic' | 'meshcore';
  transport: 'tcp' | 'http';
  /** Stable id of the calling renderer (a browser tab), or `null` when unknown. */
  sessionOf: (event: IpcMainInvokeEvent) => number | null;
  announce: (protocol: 'meshtastic' | 'meshcore', change: SharedLinkAnnouncement) => void;
  /** MeshCore only: push a radio frame to every tab (the bridge's data channel). */
  broadcast?: (frame: Uint8Array) => void;
}

export interface SharedLinkTap extends TcpBridgeTap {
  /** The open link, as announced (`null` when none): what a tab opened later can join. */
  current: () => Extract<SharedLinkAnnouncement, { state: 'connected' }> | null;
}

interface ReplyTarget {
  send: (channel: string, ...args: unknown[]) => void;
  once?: (name: 'destroyed', fn: () => void) => unknown;
}

function sameTarget(a: MeshtasticLinkTarget, b: MeshtasticLinkTarget): boolean {
  if (a.kind === 'tcp' && b.kind === 'tcp') return a.host === b.host && a.port === b.port;
  if (a.kind === 'http' && b.kind === 'http') return a.host === b.host && a.tls === b.tls;
  return false;
}

export function createSharedLinkTap(opts: SharedLinkTapOptions): SharedLinkTap {
  const { protocol, transport, sessionOf } = opts;
  const members = new Set<number>();
  let target: MeshtasticLinkTarget | null = null;
  let writeToLink: ((bytes: Uint8Array) => void) | null = null;
  const replyTargets = new Map<number, ReplyTarget>();
  const dataChannel = `${protocol}:tcp-data`;

  const mux =
    protocol === 'meshcore'
      ? new MeshcoreTcpMux({
          writeToRadio: (frame) => {
            writeToLink?.(frame);
          },
          deliver: (sid, frame) => {
            if (sid === null) opts.broadcast?.(frame);
            else replyTargets.get(sid)?.send(dataChannel, frame);
          },
        })
      : null;

  const join = (event: IpcMainInvokeEvent): number | null => {
    const sid = sessionOf(event);
    if (sid === null || members.has(sid)) return sid;
    members.add(sid);
    const sender = event.sender as unknown as ReplyTarget;
    sender.once?.('destroyed', () => {
      members.delete(sid);
    });
    return sid;
  };

  const announcement = (): ReturnType<SharedLinkTap['current']> => {
    if (target?.kind === 'tcp') {
      return { state: 'connected', transport: 'tcp', host: target.host, port: target.port };
    }
    if (target?.kind === 'http') {
      return { state: 'connected', transport: 'http', host: target.host, tls: target.tls };
    }
    return null;
  };

  const isOutsider = (event: IpcMainInvokeEvent): boolean => {
    const sid = sessionOf(event);
    return sid !== null && !members.has(sid);
  };

  /** Remember where a tab's MeshCore replies go; forget its commands when it closes. */
  const replyTargetOf = (event: IpcMainInvokeEvent): number | null => {
    const sid = sessionOf(event);
    if (sid === null || replyTargets.has(sid)) return sid;
    const sender = event.sender as unknown as ReplyTarget;
    replyTargets.set(sid, sender);
    sender.once?.('destroyed', () => {
      replyTargets.delete(sid);
      mux?.sessionClosed(sid);
    });
    return sid;
  };

  return {
    current: announcement,
    onOpen: (write, info) => {
      writeToLink = write;
      target = info?.target ?? null;
      mux?.reset();
      if (info?.event) join(info.event);
      const change = announcement();
      if (change) opts.announce(protocol, change);
    },
    onData: (chunk) => {
      if (!mux) return false;
      mux.fromRadio(chunk);
      return true;
    },
    onClose: (dropped?: boolean) => {
      writeToLink = null;
      target = null;
      mux?.reset();
      if (dropped) members.clear();
    },
    onUserDisconnect: (hadLink) => {
      members.clear();
      if (hadLink) opts.announce(protocol, { state: 'disconnected', transport });
    },
    join: (event, wanted) => {
      if (!target || !sameTarget(target, wanted) || !isOutsider(event)) return false;
      const sid = join(event);
      console.debug(`[link-sharing] ${protocol}: tab ${String(sid)} joined the shared link`);
      return true;
    },
    keepOnDisconnect: (event) => {
      if (!isOutsider(event)) return false;
      console.debug(`[link-sharing] ${protocol}: disconnect from a tab not on the link; kept`);
      return true;
    },
    takeWrite: (event, bytes) => {
      if (!mux) return false;
      const sid = replyTargetOf(event);
      if (sid === null) return false;
      mux.fromSession(sid, bytes);
      return true;
    },
  };
}

/** Several taps on one bridge (background ingest + shared viewing) as one. */
export function combineTaps(...taps: (TcpBridgeTap | undefined)[]): TcpBridgeTap | undefined {
  const list = taps.filter((t): t is TcpBridgeTap => t !== undefined);
  if (list.length <= 1) return list[0];
  return {
    onOpen: (write, info) => {
      for (const t of list) t.onOpen(write, info);
    },
    onData: (chunk) => {
      let delivered = false;
      for (const t of list) if (t.onData(chunk) === true) delivered = true;
      return delivered;
    },
    onClose: (dropped?: boolean) => {
      for (const t of list) t.onClose(dropped);
    },
    onUserDisconnect: (hadLink) => {
      for (const t of list) t.onUserDisconnect?.(hadLink);
    },
    join: (event, target) => list.some((t) => t.join?.(event, target) === true),
    keepOnDisconnect: (event) => list.some((t) => t.keepOnDisconnect?.(event) === true),
    takeWrite: (event, bytes) => list.some((t) => t.takeWrite?.(event, bytes) === true),
  };
}
