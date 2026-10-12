// @vitest-environment node
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Mesh, Portnums } from '@meshtastic/protobufs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeChannelIdentityKey } from '../../shared/channelIdentityKey';
import {
  MESHTASTIC_BACKEND_HEARTBEAT_MS,
  MeshtasticBackendIngest,
  type MeshtasticBackendMessageRow,
} from './meshtasticBackendIngest';
import {
  ALICE,
  BROADCAST,
  configDump,
  frame,
  ME,
  PSK,
  textPacket,
} from './meshtasticFrames.testUtil';

const { PortNum } = Portnums;
function setup() {
  const rows: MeshtasticBackendMessageRow[] = [];
  const writes: Uint8Array[] = [];
  const caughtUp: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const ingest = new MeshtasticBackendIngest(
    {
      persistMessage: (row) => rows.push(row),
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
  return { ingest, rows, writes, caughtUp, feed, activeTimers };
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
    expect(t.caughtUp).toEqual([2]);
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
});
