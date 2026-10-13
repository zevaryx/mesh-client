/**
 * Shared viewing in the web UI: several browser tabs on one headless server.
 *
 * - **Data:** another tab wrote something this tab did not see on the radio stream (a message it
 *   sent, a delivery status, a delete, a favorite, MeshCore contacts). Reload that protocol's
 *   messages or nodes from SQLite, debounced so a burst of writes costs one reload.
 * - **Link:** another tab connected a radio link this tab is not on: join it (the server attaches
 *   this tab to the open link instead of reconnecting). A user disconnected the link in another
 *   tab: drop it here too, as an explicit disconnect so this tab does not reconnect it.
 *
 * Each handler is idempotent for the tab that caused the change (it is already connecting,
 * connected or disconnected), because the server announces link changes to every tab.
 * Failures are logged; the next change or a manual action recovers.
 */
import { formatHostForUrl } from '@/shared/connectHost';
import type { MeshProtocol } from '@/shared/meshProtocol';
import type { WebBridgeDataChange, WebBridgeLinkChange } from '@/shared/webBridgeDataSync';

import { errLikeToLogString } from './errLikeToLogString';

export const SHARED_SESSION_RELOAD_DEBOUNCE_MS = 400;

export interface SharedSessionRefresh {
  refreshMessagesFromDb: () => Promise<void>;
  refreshNodesFromDb: () => Promise<void>;
}

export interface SharedSessionLinkActions {
  status: () => string;
  /** Join the link another tab opened (the server attaches this tab to it). */
  join: (change: WebBridgeLinkChange) => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface SharedSessionDeps {
  refresh: (protocol: MeshProtocol) => SharedSessionRefresh;
  link: (protocol: WebBridgeLinkChange['protocol']) => SharedSessionLinkActions;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface SharedSessionSync {
  onDataChanged: (change: WebBridgeDataChange) => void;
  onLinkChanged: (change: WebBridgeLinkChange) => void;
  dispose: () => void;
}

export function createSharedSessionSync(deps: SharedSessionDeps): SharedSessionSync {
  const setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimeout ??
    ((h) => {
      clearTimeout(h as ReturnType<typeof setTimeout>);
    });
  const pending = new Map<string, unknown>();

  const reload = (change: WebBridgeDataChange): void => {
    const r = deps.refresh(change.protocol);
    const run = change.kind === 'messages' ? r.refreshMessagesFromDb : r.refreshNodesFromDb;
    run().catch((err: unknown) => {
      console.warn(
        `[sharedSession] ${change.protocol} ${change.kind} reload failed ` +
          errLikeToLogString(err),
      );
    });
  };

  return {
    onDataChanged: (change) => {
      const key = `${change.protocol}:${change.kind}`;
      const prev = pending.get(key);
      if (prev !== undefined) clearTimer(prev);
      pending.set(
        key,
        setTimer(() => {
          pending.delete(key);
          reload(change);
        }, SHARED_SESSION_RELOAD_DEBOUNCE_MS),
      );
    },
    onLinkChanged: (change) => {
      const link = deps.link(change.protocol);
      const status = link.status();
      if (change.state === 'connected') {
        if (status !== 'disconnected') return;
        console.debug(`[sharedSession] ${change.protocol}: joining the link another tab opened`);
        link.join(change).catch((err: unknown) => {
          console.warn(
            `[sharedSession] ${change.protocol}: joining the shared link failed ` +
              errLikeToLogString(err),
          );
        });
        return;
      }
      if (status === 'disconnected') return;
      console.debug(`[sharedSession] ${change.protocol}: another tab disconnected the link`);
      link.disconnect().catch((err: unknown) => {
        console.warn(
          `[sharedSession] ${change.protocol}: following the disconnect failed ` +
            errLikeToLogString(err),
        );
      });
    },
    dispose: () => {
      for (const handle of pending.values()) clearTimer(handle);
      pending.clear();
    },
  };
}

/**
 * How to connect to an announced link: the tab that opened it saved its connection type and
 * address (shared browser storage), which also carries what the announcement cannot (HTTP's
 * `https://` choice, MeshCore's `http` name for its network option). Without a matching saved
 * connection: TCP by host and port, HTTP by host.
 */
export function sharedLinkConnectArgs(
  change: WebBridgeLinkChange,
  saved: { type: string; httpAddress?: string } | null,
): { type: 'tcp' | 'http'; address: string } | null {
  if (saved && (saved.type === 'tcp' || saved.type === 'http') && saved.httpAddress) {
    return { type: saved.type, address: saved.httpAddress };
  }
  if (change.host === undefined) return null;
  if (change.transport === 'http') return { type: 'http', address: change.host };
  return change.port === undefined
    ? null
    : { type: 'tcp', address: formatHostForUrl(change.host, change.port) };
}
