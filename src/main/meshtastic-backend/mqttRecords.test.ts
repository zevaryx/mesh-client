// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ENVIRONMENT_NODE_UPDATE_MARKER } from '../../shared/environmentTelemetry';
import type { MeshtasticBackendRecord } from './meshtasticBackendRecords';
import {
  createMeshtasticMqttBackground,
  recordsForMqttMessage,
  recordsForMqttNodeUpdate,
} from './mqttRecords';

const ALICE = 0x22222222;
const ME = 0x11111111;
const T0 = 1_700_000_000_000;

const identity = (index: number) =>
  index === 0 ? { channelKey: 'meshtastic:ops-key', radioNodeId: ME } : { radioNodeId: ME };

describe('recordsForMqttMessage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores channel chat as MQTT on the radio channel, with a sender last-heard bump', () => {
    const records = recordsForMqttMessage(
      {
        sender_id: ALICE,
        sender_name: '!22222222',
        payload: 'over mqtt',
        channel: 0,
        timestamp: T0,
        packetId: 77,
        replyId: 5,
        from_mqtt: true,
      },
      identity,
    );
    expect(records).toEqual([
      {
        kind: 'node',
        node: { node_id: ALICE, source: 'mqtt', via_mqtt: true, last_heard: T0 },
      },
      {
        kind: 'message',
        row: {
          sender_id: ALICE,
          sender_name: '!22222222',
          payload: 'over mqtt',
          channel: 0,
          timestamp: T0,
          packetId: 77,
          replyId: 5,
          receivedVia: 'mqtt',
          radioNodeId: ME,
          channelKey: 'meshtastic:ops-key',
        },
      },
    ]);
  });

  it('keeps DMs out of channel identity and drops malformed payloads', () => {
    const dm = recordsForMqttMessage(
      { sender_id: ALICE, payload: 'dm', channel: 0, timestamp: T0, to: ME, packetId: 9 },
      identity,
    );
    expect(dm[1]).toMatchObject({ kind: 'message', row: { to: ME } });
    expect(dm[1]?.kind === 'message' && dm[1].row.channelKey).toBeUndefined();
    expect(recordsForMqttMessage({ sender_id: 0, payload: 'x', timestamp: T0 }, identity)).toEqual(
      [],
    );
    expect(recordsForMqttMessage('junk', identity)).toEqual([]);
  });
});

describe('recordsForMqttNodeUpdate', () => {
  it('maps names, hops, position and environment readings; skips MeshCore patches', () => {
    const records = recordsForMqttNodeUpdate(
      {
        node_id: ALICE,
        long_name: 'Alice Base',
        short_name: 'ALI',
        hw_model: 'TBEAM',
        hops_away: 2,
        latitude: 39.7,
        longitude: -105,
        last_heard: T0,
        snr: 9,
        env_temperature: 21.5,
        [ENVIRONMENT_NODE_UPDATE_MARKER]: T0,
        protocol: 'meshtastic',
      },
      T0 + 5,
    );
    expect(records[0]).toEqual({
      kind: 'node',
      node: {
        node_id: ALICE,
        source: 'mqtt',
        via_mqtt: true,
        long_name: 'Alice Base',
        short_name: 'ALI',
        hw_model: 'TBEAM',
        hops_away: 2,
        last_heard: T0,
        latitude: 39.7,
        longitude: -105,
      },
    });
    expect(records.slice(1).map((r) => r.kind)).toEqual(['position', 'environment']);
    expect(recordsForMqttNodeUpdate({ node_id: ALICE, protocol: 'meshcore' })).toEqual([]);
  });

  it('ignores invalid fixes and leaves the caller object untouched', () => {
    const update = {
      node_id: ALICE,
      latitude: 0,
      longitude: 0,
      [ENVIRONMENT_NODE_UPDATE_MARKER]: 1,
    };
    const records = recordsForMqttNodeUpdate(update, T0);
    expect(records.map((r) => r.kind)).toEqual(['node']);
    expect(update[ENVIRONMENT_NODE_UPDATE_MARKER]).toBe(1);
  });
});

describe('createMeshtasticMqttBackground', () => {
  it('stores only while no renderer is attached and survives a failing store', () => {
    const stored: MeshtasticBackendRecord[] = [];
    let present = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createMeshtasticMqttBackground({
      isRendererPresent: () => present,
      persist: (record) => {
        if (record.kind === 'position') throw new Error('disk full');
        stored.push(record);
      },
      channelIdentity: identity,
    });
    const msg = { sender_id: ALICE, payload: 'hi', channel: 0, timestamp: T0, packetId: 1 };
    sink.message(msg);
    expect(stored).toEqual([]);
    present = false;
    sink.message(msg);
    sink.nodeUpdate({ node_id: ALICE, latitude: 39.7, longitude: -105 });
    expect(stored.map((r) => r.kind)).toEqual(['node', 'message', 'node']);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
