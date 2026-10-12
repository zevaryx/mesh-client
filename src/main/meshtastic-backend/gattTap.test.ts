// @vitest-environment node
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { attachMeshtasticGattTap } from './gattTap';

describe('attachMeshtasticGattTap', () => {
  it('feeds only the Meshtastic BLE session and writes keep-alives back to it', async () => {
    const toRadio = vi.fn(() => Promise.resolve());
    const proxy = Object.assign(new EventEmitter(), { toRadio });
    const tap = { onOpen: vi.fn(), onData: vi.fn(), onClose: vi.fn() };
    attachMeshtasticGattTap(proxy, tap);

    proxy.emit('connected', { sessionId: 'meshcore' });
    proxy.emit('fromRadio', { sessionId: 'meshcore', bytes: new Uint8Array([1]) });
    expect(tap.onOpen).not.toHaveBeenCalled();
    expect(tap.onData).not.toHaveBeenCalled();

    proxy.emit('connected', { sessionId: 'meshtastic' });
    proxy.emit('fromRadio', { sessionId: 'meshtastic', bytes: new Uint8Array([2]) });
    expect(tap.onData).toHaveBeenCalledWith(new Uint8Array([2]));
    const write = tap.onOpen.mock.calls[0]?.[0] as (bytes: Uint8Array) => void;
    write(new Uint8Array([9]));
    await Promise.resolve();
    expect(toRadio).toHaveBeenCalledWith('meshtastic', new Uint8Array([9]));

    proxy.emit('disconnected', { sessionId: 'meshcore' });
    expect(tap.onClose).not.toHaveBeenCalled();
    proxy.emit('disconnected', { sessionId: 'meshtastic' });
    expect(tap.onClose).toHaveBeenCalledTimes(1);
  });
});
