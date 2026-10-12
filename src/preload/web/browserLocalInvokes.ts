/**
 * IPC channels the browser bridge answers in the page instead of on the server: they act on the
 * viewer's own browser, not on the machine running mesh-client.
 *
 * - `clipboard:writeText`: the viewer's clipboard (the server's clipboard would be wrong, and a
 *   container has none).
 * - `app:focusWindow`: focus this tab (notification click).
 * - `session:clearData`: clear this browser's storage, like the desktop app clears its renderer
 *   session. The headless access token is kept so the tab stays signed in.
 *
 * Failure behavior: storage APIs blocked by the browser (private mode, permissions) are logged and
 * skipped; clearing continues with the next store.
 */
export type BrowserLocalInvoke = (...args: unknown[]) => Promise<unknown>;

export interface BrowserLocalInvokeEnv {
  win: Window;
  /** localStorage key of the headless access token (preserved by `session:clearData`). */
  tokenStorageKey: string;
}

async function clearBrowserSessionData({ win, tokenStorageKey }: BrowserLocalInvokeEnv) {
  try {
    const savedAccess = win.localStorage.getItem(tokenStorageKey);
    win.localStorage.clear();
    if (savedAccess) win.localStorage.setItem(tokenStorageKey, savedAccess);
  } catch (err) {
    console.warn('[web-bridge] could not clear localStorage', err);
  }
  try {
    win.sessionStorage.clear();
  } catch (err) {
    console.warn('[web-bridge] could not clear sessionStorage', err);
  }
  try {
    if ('caches' in win) {
      for (const key of await win.caches.keys()) await win.caches.delete(key);
    }
  } catch (err) {
    console.warn('[web-bridge] could not clear Cache Storage', err);
  }
  try {
    const registrations = (await win.navigator.serviceWorker?.getRegistrations()) ?? [];
    for (const r of registrations) await r.unregister();
  } catch (err) {
    console.warn('[web-bridge] could not unregister service workers', err);
  }
}

export function createBrowserLocalInvokes(
  env: BrowserLocalInvokeEnv,
): Record<string, BrowserLocalInvoke> {
  return {
    'clipboard:writeText': async (text) => {
      await env.win.navigator.clipboard.writeText(typeof text === 'string' ? text : '');
    },
    'app:focusWindow': () => {
      env.win.focus();
      return Promise.resolve();
    },
    'session:clearData': () => clearBrowserSessionData(env),
  };
}
