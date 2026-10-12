/**
 * Per-client lockout after repeated bad tokens on the headless server.
 *
 * Generated tokens (192 bits) cannot be guessed over the network, but an operator-chosen
 * `MESH_CLIENT_WEB_TOKEN` can be weak; this caps guessing to a few attempts per minute per client.
 * While a client is locked out its requests are refused before the token is checked, so a guess
 * made then cannot succeed.
 *
 * Clients are keyed by remote address. Behind a reverse proxy every browser shares the proxy's
 * address unless `MESH_CLIENT_WEB_TRUST_PROXY=1` makes the server key on `X-Forwarded-For`
 * (only safe when the proxy is the only way in, since clients can set that header themselves).
 */
import type http from 'node:http';

import { MS_PER_MINUTE } from '../../shared/timeConstants';

/**
 * Above what a tab left open across a token change produces: its bridge retries with the old
 * token at most every 10 s (about 10 tries in the first minute, 6 after), so it never locks its
 * own client out of the new token.
 */
export const HEADLESS_AUTH_MAX_FAILURES = 20;
export const HEADLESS_AUTH_FAILURE_WINDOW_MS = MS_PER_MINUTE;
export const HEADLESS_AUTH_LOCKOUT_MS = 5 * MS_PER_MINUTE;
/** Tracked clients; the oldest entry is dropped beyond this (lazy cleanup, bounded memory). */
const MAX_TRACKED_CLIENTS = 4096;

interface ClientState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export class HeadlessAuthThrottle {
  private readonly clients = new Map<string, ClientState>();

  constructor(private readonly now: () => number = Date.now) {}

  /** True while `client` is locked out. */
  isLocked(client: string): boolean {
    const state = this.clients.get(client);
    if (!state) return false;
    if (state.lockedUntil > this.now()) return true;
    if (state.lockedUntil !== 0) this.clients.delete(client);
    return false;
  }

  /** Count one bad token; returns true when this failure starts a lockout. */
  recordFailure(client: string): boolean {
    const t = this.now();
    let state = this.clients.get(client);
    if (!state || t - state.windowStart > HEADLESS_AUTH_FAILURE_WINDOW_MS) {
      state = { failures: 0, windowStart: t, lockedUntil: 0 };
    }
    state.failures += 1;
    // Re-insert so Map order tracks recency for the size cap below.
    this.clients.delete(client);
    this.clients.set(client, state);
    if (this.clients.size > MAX_TRACKED_CLIENTS) {
      const oldest = this.clients.keys().next();
      if (!oldest.done) this.clients.delete(oldest.value);
    }
    if (state.failures >= HEADLESS_AUTH_MAX_FAILURES && state.lockedUntil === 0) {
      state.lockedUntil = t + HEADLESS_AUTH_LOCKOUT_MS;
      return true;
    }
    return false;
  }

  /** A good token clears the client's failure count. */
  recordSuccess(client: string): void {
    this.clients.delete(client);
  }
}

/** Client key for throttling: remote address, or the first `X-Forwarded-For` hop if trusted. */
export function headlessClientKey(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers['x-forwarded-for'];
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
