import { describe, expect, it, vi } from 'vitest';

import * as rendererOrigin from '../shared/rendererOrigin';
import * as rendererStorageIntent from '../shared/rendererStorageIntent';

type Handler = (event: unknown, key: unknown, value: unknown) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  },
}));
vi.mock('./validate-ipc-sender', () => ({ validateIpcSender: () => true }));

// The `appSettings:*` handlers live in `ipc/app-settings-handlers.ts` (moved out of `index.ts`).
const { registerAppSettingsIpcHandlers } = await import('./ipc/app-settings-handlers');

const receiptKey = `${rendererOrigin.RENDERER_STORAGE_DELETION_SETTING_PREFIX}mesh-client:lastConnection:meshcore`;

function receiptIpcHarness() {
  handlers.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.fn<(key: string, value: string) => { changes: number }>(() => ({ changes: 1 }));
  const prepare = vi.fn(() => ({ run: write, get: () => undefined }));
  registerAppSettingsIpcHandlers({
    getDatabase: () =>
      ({
        transaction: (operation: () => unknown) => operation,
        prepareOnce: prepare,
        pragma: (_statement: string, options?: { simple?: boolean }) =>
          options?.simple ? 1 : undefined,
      }) as never,
  });
  const handler = handlers.get('appSettings:set');
  expect(handler).toBeTypeOf('function');
  const remove = handlers.get('appSettings:remove');
  expect(remove).toBeTypeOf('function');
  return {
    invoke: (key: unknown, value: unknown) => handler!({}, key, value),
    remove: (key: unknown) => remove!({}, key, undefined),
    write,
  };
}

describe('renderer storage receipt IPC boundary', () => {
  it('cannot erase pinned receipt history through the generic remove IPC', () => {
    const harness = receiptIpcHarness();
    expect(() => harness.remove(receiptKey)).toThrow(/key not allowed/);
    expect(harness.write).not.toHaveBeenCalled();
    expect(harness.remove('locale')).toEqual({ changes: 1 });
    expect(harness.write).toHaveBeenCalledExactlyOnceWith('locale');
  });
  it('writes a complete valid receipt dictionary beyond the ordinary setting limit atomically', () => {
    const harness = receiptIpcHarness();
    const applied = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `http://localhost:${5000 + index}`,
        `intent-${index}-${'x'.repeat(80)}`,
      ]),
    );
    const serialized = JSON.stringify({ deleted: false, applied });
    expect(serialized.length).toBeGreaterThan(256);
    expect(serialized.length).toBeLessThan(
      rendererStorageIntent.RENDERER_STORAGE_DELETION_STATE_MAX_LENGTH,
    );
    expect(harness.invoke(receiptKey, serialized)).toEqual({ changes: 1 });
    expect(harness.write).toHaveBeenCalledOnce();
    expect(harness.write.mock.calls[0]?.[0]).toBe(receiptKey);
    expect(JSON.parse(harness.write.mock.calls[0]?.[1])).toEqual({
      deleted: false,
      applied,
      imported: {},
    });
  });

  it.each([
    '{invalid',
    JSON.stringify({ deleted: 'yes', applied: {} }),
    JSON.stringify({ deleted: false, applied: { 'https://untrusted.example/path': 'id' } }),
    'x'.repeat(rendererStorageIntent.RENDERER_STORAGE_DELETION_STATE_MAX_LENGTH + 1),
  ])('rejects malformed or oversized receipt state %# before writing', (serialized) => {
    const harness = receiptIpcHarness();
    expect(() => harness.invoke(receiptKey, serialized)).toThrow();
    expect(harness.write).not.toHaveBeenCalled();
  });

  it('keeps unrelated keys disallowed and ordinary settings bounded at 256 characters', () => {
    const harness = receiptIpcHarness();
    expect(() =>
      harness.invoke(`${rendererOrigin.RENDERER_STORAGE_DELETION_SETTING_PREFIX}unrelated`, '1'),
    ).toThrow(/key not allowed/);
    expect(() => harness.invoke('locale', 'x'.repeat(257))).toThrow(/under 256 chars/);
    expect(harness.write).not.toHaveBeenCalled();
  });
});
