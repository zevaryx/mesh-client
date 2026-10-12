// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WEB_BRIDGE_DOWNLOAD_EVENT,
  WEB_BRIDGE_PICK_FILES_EVENT,
} from '../../shared/webBridgeProtocol';
import { installHeadlessFileTransfer } from './headlessFileTransfer';

type Listener = (event: unknown, ...args: unknown[]) => void;

function setup(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return fetchImpl ? fetchImpl(url, init) : Promise.resolve(new Response(null, { status: 204 }));
  });
  const createObjectURL = vi.fn(() => 'blob:mock');
  installHeadlessFileTransfer({
    on: (channel, listener) => listeners.set(channel, listener),
    token: 'tok-1234567890abcdef',
    doc: document,
    fetchFn: fetchFn as unknown as typeof fetch,
    createObjectURL,
    revokeObjectURL: vi.fn(),
  });
  const emit = (channel: string, payload: unknown): void => {
    listeners.get(channel)?.({}, payload);
  };
  return { emit, calls, fetchFn, createObjectURL };
}

/** jsdom has no showPicker(), so requests fall back to the gesture prompt. */
function prompt(): HTMLElement | null {
  return document.getElementById('mesh-client-headless-file-prompt');
}

function pickInto(files: File[]): void {
  const input = document.querySelector<HTMLInputElement>('input[type=file]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: files });
  input.dispatchEvent(new Event('change'));
}

/** Completion requests carry a JSON string body. */
function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body);
}

const REQUEST = {
  requestId: 'a'.repeat(32),
  title: 'Import identity',
  multiple: false,
  accept: '.json',
};

describe('installHeadlessFileTransfer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows an accessible prompt when the chooser needs a gesture, then uploads and completes', async () => {
    const t = setup();
    t.emit(WEB_BRIDGE_PICK_FILES_EVENT, REQUEST);
    const box = prompt();
    expect(box?.getAttribute('role')).toBe('dialog');
    expect(box?.getAttribute('aria-label')).toBe('Import identity');
    const choose = box?.querySelector<HTMLButtonElement>('button[aria-label="Choose file…"]');
    expect(document.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.json');
    choose?.click();
    expect(prompt()).toBeNull();
    pickInto([new File(['{"k":1}'], 'id.json')]);

    await vi.waitFor(() => {
      expect(t.calls).toHaveLength(2);
    });
    expect(t.calls[0]?.url).toBe(`/files/upload/${REQUEST.requestId}?name=id.json`);
    expect(t.calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer tok-1234567890abcdef',
    });
    expect(t.calls[1]?.url).toBe(`/files/complete/${REQUEST.requestId}`);
    expect(jsonBody(t.calls[1]?.init)).toEqual({ canceled: false });
  });

  it('completes as cancelled from the prompt', async () => {
    const t = setup();
    t.emit(WEB_BRIDGE_PICK_FILES_EVENT, REQUEST);
    prompt()
      ?.querySelector<HTMLButtonElement>('button[aria-label="Cancel file selection"]')
      ?.click();
    await vi.waitFor(() => {
      expect(t.calls).toHaveLength(1);
    });
    expect(jsonBody(t.calls[0]?.init)).toEqual({ canceled: true });
    expect(document.querySelector('input[type=file]')).toBeNull();
  });

  it('reports an upload failure so the server-side dialog rejects', async () => {
    const t = setup((url) =>
      Promise.resolve(
        url.includes('/upload/')
          ? new Response(JSON.stringify({ error: 'upload exceeds 1024 bytes' }), { status: 413 })
          : new Response(null, { status: 204 }),
      ),
    );
    t.emit(WEB_BRIDGE_PICK_FILES_EVENT, REQUEST);
    prompt()?.querySelector<HTMLButtonElement>('button[aria-label="Choose file…"]')?.click();
    pickInto([new File(['x'], 'big.bin')]);
    await vi.waitFor(() => {
      expect(t.calls).toHaveLength(2);
    });
    expect(jsonBody(t.calls[1]?.init)).toEqual({
      canceled: true,
      error: 'upload exceeds 1024 bytes',
    });
  });

  it('downloads announced files with the token header and the server file name', async () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    const t = setup(() => Promise.resolve(new Response('data', { status: 200 })));
    t.emit(WEB_BRIDGE_DOWNLOAD_EVENT, { id: 'b'.repeat(32), fileName: 'export.db', size: 4 });
    await vi.waitFor(() => {
      expect(clicks).toEqual(['export.db']);
    });
    expect(t.calls[0]?.url).toBe(`/files/download/${'b'.repeat(32)}`);
    expect(t.calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer tok-1234567890abcdef',
    });
    expect(t.createObjectURL).toHaveBeenCalled();
  });

  it('ignores malformed events', () => {
    const t = setup();
    t.emit(WEB_BRIDGE_PICK_FILES_EVENT, { requestId: 1 });
    t.emit(WEB_BRIDGE_DOWNLOAD_EVENT, null);
    expect(prompt()).toBeNull();
    expect(t.fetchFn).not.toHaveBeenCalled();
  });
});
