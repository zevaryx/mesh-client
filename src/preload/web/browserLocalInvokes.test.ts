// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserLocalInvokes } from './browserLocalInvokes';

const TOKEN_KEY = 'mesh-client.headless.token';

describe('createBrowserLocalInvokes', () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('writes the viewer clipboard and focuses the tab', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await local['clipboard:writeText']?.('copied text');
    expect(writeText).toHaveBeenCalledWith('copied text');
    await local['app:focusWindow']?.();
    expect(focus).toHaveBeenCalled();
  });

  it('clears browser storage but keeps the headless access token', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok-1234567890abcdef');
    localStorage.setItem('mesh-client:someSetting', '1');
    sessionStorage.setItem('draft', 'x');
    const deleted: string[] = [];
    Object.defineProperty(window, 'caches', {
      value: {
        keys: () => Promise.resolve(['a', 'b']),
        delete: (k: string) => {
          deleted.push(k);
          return Promise.resolve(true);
        },
      },
      configurable: true,
    });
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await local['session:clearData']?.();
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok-1234567890abcdef');
    expect(localStorage.getItem('mesh-client:someSetting')).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(deleted).toEqual(['a', 'b']);
  });
});
