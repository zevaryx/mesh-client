// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeMeshtasticBackendCatchUp } from './meshtasticBackendCatchUp';

describe('subscribeMeshtasticBackendCatchUp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reloads messages on each caught-up push and unsubscribes cleanly', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unsub = vi.fn();
    let push: ((p: { count: number }) => void) | undefined;
    const api = {
      onBackendCaughtUp: (cb: (p: { count: number }) => void) => {
        push = cb;
        return unsub;
      },
    };
    const reload = vi.fn();
    const reloadHistories = vi.fn(() => Promise.resolve());
    const stop = subscribeMeshtasticBackendCatchUp(reload, api, reloadHistories);
    push?.({ count: 3 });
    push?.({ count: 1 });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reloadHistories).toHaveBeenCalledTimes(2);
    stop();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
