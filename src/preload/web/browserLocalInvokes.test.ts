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

  function stubNotification(permission: NotificationPermission, requested = permission) {
    const shown: { title: string; body: string | undefined }[] = [];
    const FakeNotification = Object.assign(
      vi.fn(function (title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body });
      }),
      { permission, requestPermission: vi.fn(() => Promise.resolve(requested)) },
    );
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    return { shown, requestPermission: FakeNotification.requestPermission };
  }

  it('shows notify:message on the viewer screen when allowed', async () => {
    const { shown } = stubNotification('granted');
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await local['notify:message']?.('Update ready', 'Version 2 is available');
    expect(shown).toEqual([{ title: 'Update ready', body: 'Version 2 is available' }]);
  });

  it('asks once for permission and shows only when granted', async () => {
    const asked = stubNotification('default', 'granted');
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await local['notify:message']?.('t', 'b');
    await vi.waitFor(() => {
      expect(asked.shown).toHaveLength(1);
    });
    const denied = stubNotification('denied');
    await local['notify:message']?.('t', 'b');
    expect(denied.requestPermission).not.toHaveBeenCalled();
    expect(denied.shown).toHaveLength(0);
  });

  it('applies the desktop field limits', async () => {
    const { shown } = stubNotification('granted');
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await local['notify:message']?.('x'.repeat(129), 'b');
    await local['notify:message']?.('t', 'x'.repeat(513));
    await local['notify:message']?.(1, 'b');
    expect(shown).toHaveLength(0);
  });

  it('does nothing where the browser has no Notification API (plain HTTP)', async () => {
    Object.defineProperty(window, 'Notification', { value: undefined, configurable: true });
    const local = createBrowserLocalInvokes({ win: window, tokenStorageKey: TOKEN_KEY });
    await expect(local['notify:message']?.('t', 'b')).resolves.toBeUndefined();
  });
});
