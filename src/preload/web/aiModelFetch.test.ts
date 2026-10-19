// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createHeadlessAiModelFetch } from './aiModelFetch';

function setup(token: string | null = 'tok-0123456789abcdef') {
  const original = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));
  return { original, fetchFn: createHeadlessAiModelFetch(original, token) };
}

describe('offline AI model fetch (web bridge)', () => {
  it('sends mesh-ai: requests to the server route with the session token', async () => {
    const { original, fetchFn } = setup();
    const controller = new AbortController();
    await fetchFn('mesh-ai://tiny/model.gguf', { signal: controller.signal });
    const [url, init] = original.mock.calls[0] ?? [];
    expect(url).toBe('/ai-models/tiny/model.gguf');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-0123456789abcdef');
    expect(init?.signal).toBe(controller.signal);
    expect(init?.credentials).toBe('same-origin');
  });

  it('accepts URL and Request inputs and sends no token when auth is off', async () => {
    const { original, fetchFn } = setup(null);
    await fetchFn(new URL('mesh-ai://tiny/a.gguf'));
    await fetchFn(new Request('mesh-ai://tiny/b.gguf'));
    expect(original.mock.calls.map((c) => c[0])).toEqual([
      '/ai-models/tiny/a.gguf',
      '/ai-models/tiny/b.gguf',
    ]);
    expect(new Headers(original.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
  });

  it('passes every other request through untouched', async () => {
    const { original, fetchFn } = setup();
    const init = { method: 'POST', body: 'x' };
    await fetchFn('/session/tiles', init);
    expect(original).toHaveBeenCalledWith('/session/tiles', init);
  });
});
