/**
 * IPC channels the browser bridge answers in the page instead of on the server: they act on the
 * viewer's own browser, not on the machine running mesh-client.
 *
 * - `clipboard:writeText`: the viewer's clipboard (the server's clipboard would be wrong, and a
 *   container has none).
 * - `app:focusWindow`: focus this tab (notification click).
 * - `session:clearData`: clear this browser's storage, like the desktop app clears its renderer
 *   session. The headless access token is kept so the tab stays signed in.
 * - `notify:message`: a notification on the viewer's screen (Web Notifications), with the same
 *   field limits as the desktop handler. Browsers offer the API only on HTTPS or `localhost`, and
 *   only after the viewer allows it; otherwise the call does nothing, like an unsupported OS.
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

/** Same limits as the desktop `notify:message` handler. */
const NOTIFY_TITLE_MAX = 128;
const NOTIFY_BODY_MAX = 512;

function showBrowserNotification(win: Window, title: unknown, body: unknown): void {
  if (typeof title !== 'string' || title.length > NOTIFY_TITLE_MAX) return;
  if (typeof body !== 'string' || body.length > NOTIFY_BODY_MAX) return;
  const Notify = (win as Window & { Notification?: typeof Notification }).Notification;
  if (!Notify) return;
  const show = (): void => {
    new Notify(title, { body });
  };
  try {
    if (Notify.permission === 'granted') show();
    else if (Notify.permission === 'default') {
      void Notify.requestPermission().then(
        (perm) => {
          if (perm === 'granted') show();
        },
        (err: unknown) => {
          console.warn('[web-bridge] notification permission request failed', err);
        },
      );
    }
  } catch (err) {
    console.warn('[web-bridge] notification failed', err);
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
    'notify:message': (title, body) => {
      showBrowserNotification(env.win, title, body);
      return Promise.resolve();
    },
  };
}
