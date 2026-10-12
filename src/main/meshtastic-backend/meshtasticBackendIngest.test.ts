// @vitest-environment node
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Config, Mesh, Portnums, Telemetry } from '@meshtastic/protobufs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeChannelIdentityKey } from '../../shared/channelIdentityKey';
import {
  MESHTASTIC_BACKEND_HEARTBEAT_MS,
  MeshtasticBackendIngest,
  type MeshtasticBackendMessageRow,
} from './meshtasticBackendIngest';
import type { MeshtasticBackendRecord } from './meshtasticBackendRecords';
import {
  ALICE,
  BROADCAST,
  configDump,
  dataPacket,
  frame,
  ME,
  PSK,
  textPacket,
} from './meshtasticFrames.testUtil';

const { PortNum } = Portnums;
function setup() {
  const rows: MeshtasticBackendMessageRow[] = [];
  const records: MeshtasticBackendRecord[] = [];
  const writes: Uint8Array[] = [];
  const caughtUp: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const ingest = new MeshtasticBackendIngest(
    {
      persist: (record) => {
        records.push(record);
        if (record.kind === 'message') rows.push(record.row);
      },
      writeToRadio: (f) => writes.push(f),
      onCaughtUp: (n) => caughtUp.push(n),
    },
    {
      setInterval: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearInterval: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    },
  );
  const feed = (...frames: Uint8Array[]): void => {
    for (const f of frames) ingest.pushBytes(f);
  };
  const activeTimers = () => timers.filter((t) => !t.cleared);
  const ofKind = <K extends MeshtasticBackendRecord['kind']>(kind: K) =>
    records.filter((r): r is Extract<MeshtasticBackendRecord, { kind: K }> => r.kind === kind);
  return { ingest, rows, records, ofKind, writes, caughtUp, feed, activeTimers };
}

describe('MeshtasticBackendIngest', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists nothing while a present renderer owns the socket it opened', async () => {
    const t = setup();
    t.ingest.setRendererPresent(true);
    t.ingest.linkOpened();
    expect(t.ingest.isPersisting()).toBe(false);
    t.feed(...configDump(), textPacket({ from: ALICE, to: BROADCAST, id: 1, text: 'hi' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(t.rows).toEqual([]);
    expect(t.activeTimers()).toEqual([]);
  });

  it('persists channel and DM text with names, channel key and radio id while detached', async () => {
    const t = setup();
    t.ingest.linkOpened();
    t.feed(...configDump());
    const bytes = new Uint8Array([
      ...textPacket({ from: ALICE, to: BROADCAST, id: 101, text: 'channel hello' }),
      ...textPacket({ from: ALICE, to: ME, id: 102, text: 'dm hello', replyId: 101 }),
    ]);
    // Split mid-frame: the stream framer must reassemble across chunks.
    t.ingest.pushBytes(bytes.subarray(0, 7));
    t.ingest.pushBytes(bytes.subarray(7));
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(2);
    });
    expect(t.rows[0]).toEqual({
      sender_id: ALICE,
      sender_name: 'ALI',
      payload: 'channel hello',
      channel: 0,
      timestamp: 1_700_000_000_000,
      packetId: 101,
      rxHops: 2,
      receivedVia: 'rf',
      radioNodeId: ME,
      channelKey: computeChannelIdentityKey('meshtastic', 'Ops', PSK),
    });
    expect(t.rows[1]).toMatchObject({ payload: 'dm hello', to: ME, replyId: 101 });
    expect(t.rows[1]?.channelKey).toBeUndefined();
  });

  it('maps tapbacks to an emoji code point and skips the radio echo of our own sends', async () => {
    const t = setup();
    t.ingest.linkOpened();
    t.feed(...configDump());
    t.feed(
      textPacket({ from: ME, to: BROADCAST, id: 5, text: 'my own send' }),
      textPacket({ from: ALICE, to: BROADCAST, id: 6, text: '👍', emoji: 1, replyId: 4 }),
    );
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(1);
    });
    expect(t.rows[0]).toMatchObject({ emoji: 0x1f44d, replyId: 4, packetId: 6 });
  });

  it('falls back to the node id for unknown senders and learns names from NODEINFO_APP', async () => {
    const t = setup();
    t.ingest.linkOpened();
    const bob = 0x0000beef;
    t.feed(textPacket({ from: bob, to: BROADCAST, id: 7, text: 'who am i' }));
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(1);
    });
    expect(t.rows[0]?.sender_name).toBe('!0000beef');
    t.feed(
      frame({
        case: 'packet',
        value: create(Mesh.MeshPacketSchema, {
          from: bob,
          to: BROADCAST,
          payloadVariant: {
            case: 'decoded',
            value: create(Mesh.DataSchema, {
              portnum: PortNum.NODEINFO_APP,
              payload: toBinary(
                Mesh.UserSchema,
                create(Mesh.UserSchema, { longName: 'Bobby Tables', shortName: '' }),
              ),
            }),
          },
        }),
      }),
      textPacket({ from: bob, to: BROADCAST, id: 8, text: 'now named' }),
    );
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(2);
    });
    expect(t.rows[1]?.sender_name).toBe('Bobby T');
  });

  it('heartbeats only while it owns a live link', () => {
    const t = setup();
    expect(t.activeTimers()).toEqual([]); // no link yet
    t.ingest.linkOpened();
    const [hb] = t.activeTimers();
    expect(hb?.ms).toBe(MESHTASTIC_BACKEND_HEARTBEAT_MS);
    hb?.fn();
    const sent = t.writes[0];
    expect(sent?.subarray(0, 2)).toEqual(new Uint8Array([0x94, 0xc3]));
    const toRadio = fromBinary(Mesh.ToRadioSchema, sent?.subarray(4) ?? new Uint8Array());
    expect(toRadio.payloadVariant.case).toBe('heartbeat');

    t.ingest.linkClosed();
    expect(t.activeTimers()).toEqual([]);
    t.ingest.setRendererPresent(true);
    t.ingest.linkOpened(); // a renderer reconnected: it owns the link and its heartbeat
    expect(t.activeTimers()).toEqual([]);
    t.ingest.setRendererPresent(false); // last renderer left with the socket still open
    expect(t.activeTimers()).toHaveLength(1);
  });

  it('keeps persisting until a present renderer reopens the socket, then reports the backlog', async () => {
    const t = setup();
    t.ingest.setRendererPresent(true);
    t.ingest.linkOpened();
    t.feed(...configDump());
    t.ingest.setRendererPresent(false);
    t.feed(textPacket({ from: ALICE, to: BROADCAST, id: 20, text: 'while away' }));
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(1);
    });
    // A tab is back but its runtime has not reconnected yet: it is not decoding, so keep going.
    t.ingest.setRendererPresent(true);
    expect(t.ingest.isPersisting()).toBe(true);
    t.feed(textPacket({ from: ALICE, to: BROADCAST, id: 21, text: 'during page load' }));
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(2);
    });
    expect(t.caughtUp).toEqual([]);
    t.ingest.linkOpened(); // the renderer's tcp-connect replaces the socket
    expect(t.ingest.isPersisting()).toBe(false);
    // Two messages, each with a last-heard bump for its sender.
    expect(t.caughtUp).toEqual([4]);
  });

  it('survives junk bytes on the stream', async () => {
    const t = setup();
    t.ingest.linkOpened();
    t.feed(
      new Uint8Array([0x94, 0xc3, 0x00, 0x03, 0xff, 0xff, 0xff]), // undecodable FromRadio
      new TextEncoder().encode('DEBUG log line\n'),
      textPacket({ from: ALICE, to: BROADCAST, id: 9, text: 'after junk' }),
    );
    await vi.waitFor(() => {
      expect(t.rows).toHaveLength(1);
    });
  });

  describe('node identity, position and telemetry', () => {
    const BOB = 0x0000beef;
    const positionFrame = (from: number, latitudeI: number, longitudeI: number) =>
      dataPacket({
        from,
        portnum: PortNum.POSITION_APP,
        payload: toBinary(
          Mesh.PositionSchema,
          create(Mesh.PositionSchema, { latitudeI, longitudeI, altitude: 1600 }),
        ),
      });
    const telemetryFrame = (from: number, variant: Telemetry.Telemetry['variant']) =>
      dataPacket({
        from,
        portnum: PortNum.TELEMETRY_APP,
        payload: toBinary(
          Telemetry.TelemetrySchema,
          create(Telemetry.TelemetrySchema, { variant }),
        ),
      });

    it('stores a live NODEINFO_APP user as a node patch (default short name cleared)', async () => {
      const t = setup();
      t.ingest.linkOpened();
      const publicKey = new Uint8Array(32).fill(0xab);
      t.feed(
        dataPacket({
          from: BOB,
          portnum: PortNum.NODEINFO_APP,
          payload: toBinary(
            Mesh.UserSchema,
            create(Mesh.UserSchema, {
              longName: 'Bob Base',
              shortName: 'beef', // firmware default: last 4 hex of the node id
              hwModel: Mesh.HardwareModel.RAK4631,
              role: Config.Config_DeviceConfig_Role.ROUTER,
              publicKey,
            }),
          ),
        }),
      );
      await vi.waitFor(() => {
        expect(t.ofKind('node')).toHaveLength(1);
      });
      expect(t.ofKind('node')[0]?.node).toEqual({
        node_id: BOB,
        long_name: 'Bob Base',
        hw_model: expect.any(String) as string,
        role: 2,
        public_key_hex: 'ab'.repeat(32),
        last_heard: 1_700_000_000_000,
        source: 'rf',
        via_mqtt: false,
      });
    });

    it("stores peer positions with a history point, but never the radio's own position", async () => {
      const t = setup();
      t.ingest.linkOpened();
      t.feed(...configDump()); // learns ME as the connected radio
      t.feed(
        positionFrame(BOB, 397_392_000, -1_049_903_000),
        positionFrame(ME, 400_000_000, -1_050_000_000),
        positionFrame(ALICE, 0, 0), // no fix: last-heard only
      );
      await vi.waitFor(() => {
        expect(t.ofKind('node')).toHaveLength(2);
      });
      expect(t.ofKind('node').map((r) => r.node)).toEqual([
        expect.objectContaining({ node_id: BOB, latitude: 39.7392, longitude: -104.9903 }),
        { node_id: ALICE, last_heard: 1_700_000_000_000, source: 'rf', via_mqtt: false },
      ]);
      expect(t.ofKind('position')).toEqual([
        {
          kind: 'position',
          nodeId: BOB,
          latitude: 39.7392,
          longitude: -104.9903,
          recordedAt: 1_700_000_000_000,
        },
      ]);
    });

    it('stores battery, own radio stats and environment readings (deduplicated)', async () => {
      const t = setup();
      t.ingest.linkOpened();
      t.feed(...configDump());
      const env = create(Telemetry.EnvironmentMetricsSchema, { temperature: 21.5 });
      t.feed(
        telemetryFrame(BOB, {
          case: 'deviceMetrics',
          value: create(Telemetry.DeviceMetricsSchema, { batteryLevel: 87, voltage: 4.1 }),
        }),
        telemetryFrame(ME, {
          case: 'localStats',
          value: create(Telemetry.LocalStatsSchema, { channelUtilization: 12.5, numPacketsRx: 40 }),
        }),
        telemetryFrame(BOB, { case: 'environmentMetrics', value: env }),
        telemetryFrame(BOB, { case: 'environmentMetrics', value: env }), // same reading: dropped
      );
      await vi.waitFor(() => {
        expect(t.ofKind('environment')).toHaveLength(1);
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(t.ofKind('environment')).toHaveLength(1);
      expect(t.ofKind('environment')[0]?.reading).toEqual({ temperature: 21.5 });
      const nodes = t.ofKind('node').map((r) => r.node);
      expect(nodes[0]).toMatchObject({ node_id: BOB, battery: 87 });
      expect(nodes[0]).not.toHaveProperty('voltage'); // renderer stores battery only
      expect(nodes[1]).toMatchObject({
        node_id: ME,
        channel_utilization: 12.5,
        num_packets_rx: 40,
      });
    });

    it('stores nothing for these packets while a renderer owns the link', async () => {
      const t = setup();
      t.ingest.setRendererPresent(true);
      t.ingest.linkOpened();
      t.feed(positionFrame(BOB, 397_392_000, -1_049_903_000));
      await new Promise((r) => setTimeout(r, 10));
      expect(t.records).toEqual([]);
    });
  });

  describe('packet links (HTTP, BLE)', () => {
    /** HTTP polls and BLE notifications carry one bare FromRadio, without stream framing. */
    const raw = (framed: Uint8Array) => framed.subarray(4);

    it('decodes one FromRadio per push on HTTP and sends no heartbeat', async () => {
      const t = setup();
      t.ingest.linkOpened('http');
      for (const f of configDump()) t.ingest.pushBytes(raw(f));
      t.ingest.pushBytes(
        raw(textPacket({ from: ALICE, to: BROADCAST, id: 400, text: 'over http' })),
      );
      await vi.waitFor(() => {
        expect(t.rows).toHaveLength(1);
      });
      expect(t.rows[0]).toMatchObject({ sender_name: 'ALI', radioNodeId: ME, packetId: 400 });
      expect(t.activeTimers()).toEqual([]);
    });

    it('sends raw (unframed) heartbeats on BLE and switches format when the link changes', () => {
      const t = setup();
      t.ingest.linkOpened('ble');
      t.activeTimers()[0]?.fn();
      const bleBeat = t.writes[0];
      expect(fromBinary(Mesh.ToRadioSchema, bleBeat ?? new Uint8Array()).payloadVariant.case).toBe(
        'heartbeat',
      );
      t.ingest.linkClosed('tcp'); // late close from a link that is no longer current: ignored
      expect(t.activeTimers()).toHaveLength(1);
      t.ingest.linkOpened('tcp');
      t.activeTimers()[0]?.fn();
      expect(t.writes[1]?.subarray(0, 2)).toEqual(new Uint8Array([0x94, 0xc3]));
      t.ingest.linkClosed('tcp');
      expect(t.activeTimers()).toEqual([]);
    });
  });

  describe('links the backend opens itself', () => {
    it('requests the config dump in the link format and keeps ownership with a tab present', () => {
      const t = setup();
      t.ingest.setRendererPresent(true);
      t.ingest.linkOpened('tcp', 'backend');
      expect(t.ingest.isPersisting()).toBe(true); // the tab is not decoding this socket
      const framed = t.writes[0];
      expect(framed?.subarray(0, 2)).toEqual(new Uint8Array([0x94, 0xc3]));
      const toRadio = fromBinary(Mesh.ToRadioSchema, framed?.subarray(4) ?? new Uint8Array());
      expect(toRadio.payloadVariant.case).toBe('wantConfigId');
      expect(t.activeTimers()).toHaveLength(1); // and keeps it alive

      t.ingest.linkOpened('http', 'backend');
      const raw = fromBinary(Mesh.ToRadioSchema, t.writes[1] ?? new Uint8Array());
      expect(raw.payloadVariant.case).toBe('wantConfigId');

      t.ingest.linkOpened('tcp', 'renderer'); // the tab's runtime connects: hand over
      expect(t.ingest.isPersisting()).toBe(false);
      expect(t.writes).toHaveLength(2);
    });
  });
});
