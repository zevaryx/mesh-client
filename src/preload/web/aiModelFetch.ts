/**
 * Offline AI models in the browser. On the desktop app the renderer fetches model files from the
 * `mesh-ai:` custom protocol; a browser cannot, so `fetch('mesh-ai://<model>/<file>')` is sent to
 * the headless server's `/ai-models/<model>/<file>` with the session token (the route needs it).
 * Every other request goes to the original `fetch` untouched.
 */
import { meshAiUrlToWebPath } from '../../shared/webBridgeProtocol';

type FetchFn = typeof fetch;

function requestUrl(input: Parameters<FetchFn>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** `fetch` that serves `mesh-ai:` from the headless server and passes everything else through. */
export function createHeadlessAiModelFetch(original: FetchFn, token: string | null): FetchFn {
  return (input, init) => {
    const webPath = meshAiUrlToWebPath(requestUrl(input));
    if (webPath === null) return original(input, init);
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return original(webPath, {
      ...init,
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    });
  };
}

export function installHeadlessAiModelFetch(win: Window, token: string | null): void {
  win.fetch = createHeadlessAiModelFetch(win.fetch.bind(win), token);
}
