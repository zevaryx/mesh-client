// @vitest-environment node
import type http from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  HEADLESS_AUTH_FAILURE_WINDOW_MS,
  HEADLESS_AUTH_LOCKOUT_MS,
  HEADLESS_AUTH_MAX_FAILURES,
  HeadlessAuthThrottle,
  headlessClientKey,
} from './authThrottle';

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('HeadlessAuthThrottle', () => {
  it('locks a client out after too many failures in the window, then lets it retry', () => {
    const c = clock();
    const throttle = new HeadlessAuthThrottle(c.now);
    for (let i = 1; i < HEADLESS_AUTH_MAX_FAILURES; i++) {
      expect(throttle.recordFailure('a')).toBe(false);
    }
    expect(throttle.isLocked('a')).toBe(false);
    expect(throttle.recordFailure('a')).toBe(true);
    expect(throttle.isLocked('a')).toBe(true);
    expect(throttle.isLocked('b')).toBe(false);
    c.advance(HEADLESS_AUTH_LOCKOUT_MS + 1);
    expect(throttle.isLocked('a')).toBe(false);
    expect(throttle.recordFailure('a')).toBe(false);
  });

  it('forgets failures outside the window and on success', () => {
    const c = clock();
    const throttle = new HeadlessAuthThrottle(c.now);
    for (let i = 1; i < HEADLESS_AUTH_MAX_FAILURES; i++) throttle.recordFailure('a');
    c.advance(HEADLESS_AUTH_FAILURE_WINDOW_MS + 1);
    expect(throttle.recordFailure('a')).toBe(false);
    for (let i = 1; i < HEADLESS_AUTH_MAX_FAILURES - 1; i++) throttle.recordFailure('a');
    throttle.recordSuccess('a');
    expect(throttle.recordFailure('a')).toBe(false);
  });

  it('never locks out a tab retrying a stale token every 10 s', () => {
    const c = clock();
    const throttle = new HeadlessAuthThrottle(c.now);
    // The bridge backs off 0.5 s → 10 s; worst case is the first minute.
    for (const delay of [500, 1000, 2000, 4000, 8000, ...Array<number>(60).fill(10_000)]) {
      c.advance(delay);
      throttle.recordFailure('tab');
      expect(throttle.isLocked('tab')).toBe(false);
    }
  });
});

describe('headlessClientKey', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({
      socket: { remoteAddress },
      headers: xff ? { 'x-forwarded-for': xff } : {},
    }) as unknown as http.IncomingMessage;

  it('uses the remote address unless the proxy is trusted', () => {
    expect(headlessClientKey(req('10.0.0.5', '1.2.3.4'), false)).toBe('10.0.0.5');
    expect(headlessClientKey(req('10.0.0.5', ' 1.2.3.4 , 10.0.0.5'), true)).toBe('1.2.3.4');
    expect(headlessClientKey(req('10.0.0.5'), true)).toBe('10.0.0.5');
  });
});
