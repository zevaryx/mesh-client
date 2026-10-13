/**
 * TAK server lifecycle shared by the Electron main process and the headless server: lazy-loads
 * `TakServerManager`, forwards its events to the renderer, and restores auto-start / remote-relay
 * settings at startup. Moved from `src/main/index.ts`.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { type TAKServerStatus, type TAKSettings } from '../../shared/tak-types';
import { sanitizeLogMessage } from '../log-service';
import type { RendererPushTarget } from '../rendererPushTarget';
import { errorMessageText } from '../sanitize-log-message';
import { type TakServerManager } from '../tak-server-manager';
import { canAutoConnectTakRemote, loadTakRemoteSettings } from './remote-settings';

/** TAK status before the lazy-loaded `TakServerManager` module is imported. */
export const IDLE_TAK_STATUS: TAKServerStatus = { running: false, port: 8089, clientCount: 0 };

export function validateTakSettings(settings: unknown): asserts settings is TAKSettings {
  if (!settings || typeof settings !== 'object')
    throw new Error('tak:start: settings must be an object');
  const s = settings as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') throw new Error('tak:start: enabled must be boolean');
  const port = Number(s.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('tak:start: port must be an integer 1024–65535');
  if (typeof s.serverName !== 'string' || s.serverName.length === 0 || s.serverName.length > 256)
    throw new Error('tak:start: serverName must be a non-empty string ≤ 256 chars');
  if (typeof s.requireClientCert !== 'boolean')
    throw new Error('tak:start: requireClientCert must be boolean');
  if (typeof s.autoStart !== 'boolean') throw new Error('tak:start: autoStart must be boolean');
}

export interface TakServerHostDeps {
  getMainWindow: () => RendererPushTarget | null;
}

export interface TakServerHost {
  /** Load (once) and return the manager. */
  ensure: () => Promise<TakServerManager>;
  /** The manager if it has been loaded, else `null` (callers treat that as idle). */
  get: () => TakServerManager | null;
  /** Start the server / remote relay when saved settings ask for it (call after initDatabase). */
  autoStartFromSavedSettings: () => void;
}

export function createTakServerHost(deps: TakServerHostDeps): TakServerHost {
  let takServerManager: TakServerManager | null = null;
  let takServerManagerLoadPromise: Promise<TakServerManager> | null = null;

  /** Manager event → renderer channel. */
  const TAK_FORWARDS: readonly (readonly [string, string])[] = [
    ['status', 'tak:status'],
    ['client-connected', 'tak:clientConnected'],
    ['client-disconnected', 'tak:clientDisconnected'],
    ['remote-status', 'tak:remoteStatus'],
    ['client-updated', 'tak:clientUpdated'],
    // Dropped while the window is down: a chat message must not be sent on the mesh late.
    ['client-chat', 'tak:inboundChat'],
    // The renderer re-reads tak:getContacts on mount, so a dropped batch is recovered there.
    ['contacts', 'tak:contacts'],
  ];

  function attachTakForwarders(manager: TakServerManager): void {
    for (const [event, channel] of TAK_FORWARDS) {
      manager.on(event, (payload: unknown) => {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) mainWindow.webContents.send(channel, payload);
        else if (channel !== 'tak:contacts') {
          console.debug(`[main] ${channel} dropped (mainWindow not ready)`);
        }
      });
    }
  }

  async function ensureTakServerManager(): Promise<TakServerManager> {
    if (takServerManager) return takServerManager;
    takServerManagerLoadPromise ??= import('../tak-server-manager').then((mod) => {
      const manager = new mod.TakServerManager();
      attachTakForwarders(manager);
      takServerManager = manager;
      return manager;
    });
    return takServerManagerLoadPromise;
  }

  function autoStartFromSavedSettings(): void {
    // Auto-restore TAK server if auto-start is enabled
    const takSettingsPath = path.join(app.getPath('userData'), 'tak-settings.json');
    try {
      if (fs.existsSync(takSettingsPath)) {
        const raw: unknown = JSON.parse(fs.readFileSync(takSettingsPath, 'utf-8'));
        // Backfill autoStart for settings files saved before the field was added.
        if (
          raw != null &&
          typeof raw === 'object' &&
          typeof (raw as Record<string, unknown>).autoStart !== 'boolean'
        ) {
          (raw as Record<string, unknown>).autoStart = false;
        }
        const saved = raw;
        validateTakSettings(saved);
        if (saved.autoStart) {
          void ensureTakServerManager()
            .then((m) => m.start(saved))
            .catch((e: unknown) => {
              console.error('[TAK] Auto-start failed:', sanitizeLogMessage(errorMessageText(e)));
            });
        }
      }
    } catch (e: unknown) {
      console.warn('[TAK] Settings restore failed:', sanitizeLogMessage(errorMessageText(e)));
    }

    // Reconnect the remote TAK relay when it was saved with autoConnect. An unverified or
    // unencrypted relay is only started by hand, so a hand-edited settings file cannot make it
    // connect at launch.
    try {
      const remoteSettings = loadTakRemoteSettings();
      if (remoteSettings?.autoConnect && canAutoConnectTakRemote(remoteSettings)) {
        void ensureTakServerManager()
          .then((m) => {
            m.startRemote(remoteSettings);
          })
          .catch((e: unknown) => {
            console.error(
              '[TAK] Remote relay auto-connect failed:',
              sanitizeLogMessage(errorMessageText(e)),
            );
          });
      }
    } catch (e: unknown) {
      console.warn(
        '[TAK] Remote relay settings restore failed:',
        sanitizeLogMessage(errorMessageText(e)),
      );
    }
  }

  return {
    ensure: ensureTakServerManager,
    get: () => takServerManager,
    autoStartFromSavedSettings,
  };
}
