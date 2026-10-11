// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HEADLESS_SENDER_URL, type HeadlessIpcEvent, HeadlessIpcRegistry } from './ipcRegistry';

const event: HeadlessIpcEvent = {
  senderFrame: { url: HEADLESS_SENDER_URL },
  sender: { id: 1 },
  reply: () => {},
};

describe('HeadlessIpcRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches invokes to the registered handler with the event and args', async () => {
    const registry = new HeadlessIpcRegistry();
    const handler = vi.fn(
      (_e: HeadlessIpcEvent, a: unknown, b: unknown) => `${String(a)}-${String(b)}`,
    );
    registry.handle('x:y', handler);
    await expect(registry.invoke('x:y', event, ['a', 'b'])).resolves.toBe('a-b');
    expect(handler).toHaveBeenCalledWith(event, 'a', 'b');
    expect(registry.invokeChannels()).toEqual(['x:y']);
  });

  it('rejects unknown channels with a not-ported message', async () => {
    const registry = new HeadlessIpcRegistry();
    await expect(registry.invoke('db:getNodes', event, [])).rejects.toThrow(
      "No handler registered for 'db:getNodes' (not available in headless mode)",
    );
  });

  it('turns a throwing sync handler into a rejection', async () => {
    const registry = new HeadlessIpcRegistry();
    registry.handle('bad', () => {
      throw new Error('boom');
    });
    await expect(registry.invoke('bad', event, [])).rejects.toThrow('boom');
  });

  it('refuses a second handler for one channel, like Electron', () => {
    const registry = new HeadlessIpcRegistry();
    registry.handle('dup', () => 1);
    expect(() => {
      registry.handle('dup', () => 2);
    }).toThrow("second handler for 'dup'");
    registry.removeHandler('dup');
    expect(registry.hasHandler('dup')).toBe(false);
  });

  it('fans sends out to listeners and isolates a throwing listener', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new HeadlessIpcRegistry();
    const first = vi.fn(() => {
      throw new Error('listener boom');
    });
    const second = vi.fn();
    registry.on('ping', first);
    registry.on('ping', second);
    expect(registry.emit('ping', event, [1])).toBe(true);
    expect(second).toHaveBeenCalledWith(event, 1);
    expect(console.error).toHaveBeenCalled();

    registry.removeListener('ping', first);
    registry.removeListener('ping', second);
    expect(registry.emit('ping', event, [])).toBe(false);
  });

  it('removeAllListeners clears one channel or all', () => {
    const registry = new HeadlessIpcRegistry();
    registry.on('a', vi.fn());
    registry.on('b', vi.fn());
    registry.removeAllListeners('a');
    expect(registry.emit('a', event, [])).toBe(false);
    expect(registry.emit('b', event, [])).toBe(true);
    registry.removeAllListeners();
    expect(registry.emit('b', event, [])).toBe(false);
  });
});
