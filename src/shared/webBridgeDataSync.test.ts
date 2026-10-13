import { describe, expect, it } from 'vitest';

import {
  isWebBridgeDataChange,
  isWebBridgeLinkChange,
  webBridgeDataChangeFor,
  webBridgeResultChangedRows,
} from './webBridgeDataSync';

describe('webBridgeDataSync', () => {
  it('announces what a tab writes on its own, not what every tab repeats from the stream', () => {
    expect(webBridgeDataChangeFor('db:saveMessage')).toEqual({
      protocol: 'meshtastic',
      kind: 'messages',
    });
    expect(webBridgeDataChangeFor('db:saveMeshcoreContactsBatch')).toEqual({
      protocol: 'meshcore',
      kind: 'nodes',
    });
    expect(webBridgeDataChangeFor('db:saveReticulumMessage')?.protocol).toBe('reticulum');
    for (const channel of [
      'db:saveNode',
      'db:savePositionHistory',
      'db:updateMessageReceivedVia',
    ]) {
      expect(webBridgeDataChangeFor(channel)).toBeNull();
    }
    expect(webBridgeDataChangeFor('toString')).toBeNull();
  });

  it('skips writes that changed no rows', () => {
    expect(webBridgeResultChangedRows({ changes: 0 })).toBe(false);
    expect(webBridgeResultChangedRows({ changes: 2 })).toBe(true);
    expect(webBridgeResultChangedRows(undefined)).toBe(true);
    expect(webBridgeResultChangedRows({ ok: true })).toBe(true);
  });

  it('validates pushed payloads', () => {
    expect(isWebBridgeDataChange({ protocol: 'meshcore', kind: 'nodes' })).toBe(true);
    expect(isWebBridgeDataChange({ protocol: 'x', kind: 'nodes' })).toBe(false);
    expect(
      isWebBridgeLinkChange({
        protocol: 'meshtastic',
        transport: 'tcp',
        state: 'connected',
        host: '10.0.0.5',
        port: 4403,
      }),
    ).toBe(true);
    expect(
      isWebBridgeLinkChange({ protocol: 'meshtastic', transport: 'tcp', state: 'connected' }),
    ).toBe(false);
    expect(
      isWebBridgeLinkChange({ protocol: 'meshcore', transport: 'tcp', state: 'disconnected' }),
    ).toBe(true);
    expect(
      isWebBridgeLinkChange({
        protocol: 'meshtastic',
        transport: 'http',
        state: 'connected',
        host: 'r.lan',
        tls: false,
      }),
    ).toBe(true);
    expect(
      isWebBridgeLinkChange({
        protocol: 'meshtastic',
        transport: 'http',
        state: 'connected',
        host: 'r.lan',
      }),
    ).toBe(false);
  });
});
