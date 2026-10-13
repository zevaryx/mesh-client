/**
 * Keeps the Meshtastic radio connected while no renderer is around (main process).
 *
 * The renderer owns the connection whenever it is present: it decides when to connect, and its
 * runtime reconnects on drops. This keeper only acts when no renderer is present: after a server
 * restart, or when the link drops while every tab / window is gone. It reconnects to the last
 * target a renderer connected to; an explicit renderer disconnect clears that target, so a user
 * who disconnected stays disconnected.
 *
 * Failure behavior: connect failures back off from 5 s to 60 s and keep retrying while the
 * conditions hold. Store errors are logged; the keeper then works from memory.
 */
import { MS_PER_SECOND } from '../../shared/timeConstants';
import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import { sanitizeLogMessage } from '../sanitize-log-message';
import type { MeshtasticLinkTarget } from './linkTarget';

export const MESHTASTIC_LINK_KEEPER_STARTUP_DELAY_MS = 15 * MS_PER_SECOND;
export const MESHTASTIC_LINK_KEEPER_MIN_RETRY_MS = 5 * MS_PER_SECOND;
export const MESHTASTIC_LINK_KEEPER_MAX_RETRY_MS = 60 * MS_PER_SECOND;

export interface MeshtasticLinkKeeperDeps {
  connect: (target: MeshtasticLinkTarget) => Promise<void>;
  /** Log prefix; the MeshCore background keeps its links with this class too. */
  logTag?: string;
  loadTarget: () => MeshtasticLinkTarget | null;
  saveTarget: (target: MeshtasticLinkTarget | null) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

function describeTarget(t: MeshtasticLinkTarget): string {
  if (t.kind === 'serial') return `serial ${sanitizeLogMessage(t.portId)}`;
  const host = sanitizeLogMessage(t.host);
  return t.kind === 'tcp' ? `tcp ${host}:${String(t.port)}` : `http ${host}`;
}

export class MeshtasticLinkKeeper {
  private target: MeshtasticLinkTarget | null = null;
  private rendererPresent = false;
  private linkUp = false;
  private connecting = false;
  private timer: unknown = null;
  private retryMs = MESHTASTIC_LINK_KEEPER_MIN_RETRY_MS;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly tag: string;

  constructor(private readonly deps: MeshtasticLinkKeeperDeps) {
    this.tag = deps.logTag ?? 'meshtastic-backend';
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimeout ??
      ((h) => {
        clearTimeout(h as ReturnType<typeof setTimeout>);
      });
    try {
      this.target = deps.loadTarget();
    } catch (err) {
      console.warn(`[${this.tag}] could not load the saved radio link`, err);
    }
  }

  /** Begin keeping the link; the first attempt waits so a renderer can connect first. */
  start(): void {
    this.schedule(MESHTASTIC_LINK_KEEPER_STARTUP_DELAY_MS);
  }

  setRendererPresent(present: boolean): void {
    this.rendererPresent = present;
    if (present) this.cancel();
    else this.schedule(this.retryMs);
  }

  /** Wrap a link tap so the keeper sees opens, closes and explicit disconnects. */
  wrap(tap: TcpBridgeTap): TcpBridgeTap {
    return {
      onOpen: (write, info) => {
        this.linkUp = true;
        this.retryMs = MESHTASTIC_LINK_KEEPER_MIN_RETRY_MS;
        this.cancel();
        if (info?.origin === 'renderer' && info.target) this.remember(info.target);
        tap.onOpen(write, info);
      },
      onData: (chunk) => {
        tap.onData(chunk);
      },
      onClose: () => {
        this.linkUp = false;
        tap.onClose();
        this.schedule(this.retryMs);
      },
      onUserDisconnect: () => {
        this.cancel();
        this.remember(null);
        tap.onUserDisconnect?.();
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private wanted(): boolean {
    return !this.disposed && !this.rendererPresent && !this.linkUp && this.target !== null;
  }

  private remember(target: MeshtasticLinkTarget | null): void {
    this.target = target;
    try {
      this.deps.saveTarget(target);
    } catch (err) {
      console.warn(`[${this.tag}] could not save the radio link`, err);
    }
  }

  private schedule(ms: number): void {
    if (this.timer != null || this.connecting || !this.wanted()) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.attempt();
    }, ms);
  }

  private cancel(): void {
    if (this.timer == null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private async attempt(): Promise<void> {
    const target = this.target;
    if (!target || !this.wanted()) return;
    this.connecting = true;
    console.debug(`[${this.tag}] no renderer attached; connecting ${describeTarget(target)}`);
    try {
      await this.deps.connect(target);
    } catch (err) {
      console.debug(
        `[${this.tag}] connect failed; retrying in ${String(this.retryMs)} ms`,
        err instanceof Error ? err.message : String(err),
      );
      this.retryMs = Math.min(this.retryMs * 2, MESHTASTIC_LINK_KEEPER_MAX_RETRY_MS);
    } finally {
      this.connecting = false;
    }
    this.schedule(this.retryMs);
  }
}
