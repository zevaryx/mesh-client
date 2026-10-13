// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TcpBridgeTap } from '../ipc/tcp-bridge';
import type { MeshcoreMessageRowParams } from '../meshcoreMessageChannel';
import {
  MESHCORE_BACKGROUND_START_DELAY_MS,
  MeshcoreBackground,
  meshcoreCommandFrame,
  type MeshcoreStoredContact,
  parseMeshcoreQueuedMessage,
} from './meshcoreBackground';

const NOW = 1_700_000_100_000;
const SENT_SEC = 1_700_000_000;
/** Self public key: XOR-folds to node id 0x40302010. */
const SELF_KEY = [0x10, 0x20, 0x30, 0x40, ...new Array<number>(28).fill(0)];
const SELF_ID = 0x40302010;

const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
const text = (s: string): number[] => [...new TextEncoder().encode(s)];
const fromRadio = (payload: number[]): Uint8Array =>
  new Uint8Array([0x3e, payload.length & 0xff, payload.length >> 8, ...payload]);

/** ContactMsgRecv V3 (code 16): snr, 2 reserved, 6-byte prefix, pathLen, txtType, ts, text. */
const contactMsg = (prefix: number[], txtType: number, body: number[]): number[] => [
  16,
  12,
  0,
  0,
  ...prefix,
  1,
  txtType,
  ...u32(SENT_SEC),
  ...body,
];
/** ChannelMsgRecv (code 8): channel, pathLen, txtType, ts, text. */
const channelMsg = (channel: number, body: string): number[] => [
  8,
  channel,
  0,
  0,
  ...u32(SENT_SEC),
  ...text(body),
];

const BOB_PREFIX = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5];
const ROOM_PREFIX = [0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5];
// Decoded as UTF-8 like meshcore.js does, so the prefix bytes stay below 0x80 here.
const CAROL_PREFIX4 = [0x41, 0x42, 0x43, 0x44];
const CONTACTS: Record<string, MeshcoreStoredContact> = {
  b0b1b2b3b4b5: { nodeId: 0xb0b, name: 'Bob', contactType: 1 },
  d0d1d2d3d4d5: { nodeId: 0xd00, name: 'Board', contactType: 3 },
  41424344: { nodeId: 0xc0c, name: 'Carol', contactType: 1 },
};

/** A companion radio: answers AppStart and hands out its queue on SyncNextMessage. */
function setup(queue: number[][]) {
  const rows: MeshcoreMessageRowParams[] = [];
  const caughtUp: number[] = [];
  const commands: number[] = [];
  const bg = new MeshcoreBackground({
    persist: (row) => {
      rows.push(row);
      return true;
    },
    contactByPrefix: (prefix) =>
      Object.entries(CONTACTS).find(([k]) => k.startsWith(prefix) || prefix.startsWith(k))?.[1] ??
      null,
    onCaughtUp: (count) => caughtUp.push(count),
  });
  const open = (tap: TcpBridgeTap, origin: 'renderer' | 'backend') => {
    tap.onOpen(
      (frame) => {
        const code = frame[3] ?? 0;
        commands.push(code);
        queueMicrotask(() => {
          if (code === 1) tap.onData(fromRadio([5, 1, 22, 22, ...SELF_KEY]));
          else if (code === 10) tap.onData(fromRadio(queue.shift() ?? [10]));
        });
      },
      { origin },
    );
  };
  return { bg, rows, caughtUp, commands, open };
}

describe('MeshCore background session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('frames commands and parses queued messages (v1 and v3)', () => {
    expect(meshcoreCommandFrame([10])).toEqual(new Uint8Array([0x3c, 1, 0, 10]));
    expect(
      parseMeshcoreQueuedMessage(new Uint8Array(contactMsg(BOB_PREFIX, 0, text('hi')))),
    ).toEqual({
      kind: 'contact',
      pubKeyPrefix: 'b0b1b2b3b4b5',
      pathLen: 1,
      txtType: 0,
      senderTimestamp: SENT_SEC,
      text: 'hi',
    });
    expect(parseMeshcoreQueuedMessage(new Uint8Array(channelMsg(255, 'A: x')))).toMatchObject({
      kind: 'channel',
      channelIdx: -1,
      text: 'A: x',
    });
    expect(parseMeshcoreQueuedMessage(new Uint8Array([10]))).toBeNull();
  });

  it('on a link it opened, starts a client session and stores what the radio queued', async () => {
    const t = setup([
      channelMsg(0, 'Alice: hello all'),
      contactMsg(BOB_PREFIX, 0, text('hi there')),
      contactMsg(ROOM_PREFIX, 2, [...CAROL_PREFIX4, ...text('board post')]),
      // Not stored, like the renderer: unknown sender, CLI reply, our own room post echoed back.
      contactMsg([1, 2, 3, 4, 5, 6], 0, text('who?')),
      contactMsg(BOB_PREFIX, 1, text('cli reply')),
      contactMsg(ROOM_PREFIX, 2, [0x10, 0x20, 0x30, 0x40, ...text('mine')]),
    ]);
    // Own key prefix, so the echoed room post resolves to us.
    CONTACTS['10203040'] = { nodeId: SELF_ID, name: 'Me', contactType: 1 };
    try {
      t.open(t.bg.taps.tcp, 'backend');
      await vi.advanceTimersByTimeAsync(MESHCORE_BACKGROUND_START_DELAY_MS);
      // AppStart, then SyncNextMessage until NoMoreMessages.
      expect(t.commands).toEqual([1, 10, 10, 10, 10, 10, 10, 10]);
    } finally {
      delete CONTACTS['10203040'];
    }
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]).toMatchObject({
      sender_name: 'Alice',
      payload: 'hello all',
      channel_idx: 0,
      to_node: null,
      timestamp: SENT_SEC * 1000,
      local_order: null,
      radio_node_id: SELF_ID,
      received_via: 'rf',
    });
    expect(t.rows[1]).toMatchObject({
      sender_id: 0xb0b,
      sender_name: 'Bob',
      payload: 'hi there',
      channel_idx: -1,
      to_node: SELF_ID,
      radio_node_id: SELF_ID,
    });
    expect(t.rows[1]?.local_order).toBeGreaterThanOrEqual(NOW * 1000);
    expect(t.rows[2]).toMatchObject({
      sender_id: 0xc0c,
      sender_name: 'Carol',
      payload: 'board post',
      channel_idx: -2,
      room_server_id: 0xd00,
    });
    // The next tab reloads what was stored meanwhile.
    t.bg.setRendererPresent(true);
    expect(t.caughtUp).toEqual([3]);
  });

  it('leaves the radio to the tabs, and drains when the last one leaves or a message waits', async () => {
    const t = setup([channelMsg(1, 'Dan: one')]);
    t.bg.setRendererPresent(true);
    t.open(t.bg.taps.serial, 'renderer');
    t.bg.taps.serial.onData(fromRadio([0x83]));
    await vi.advanceTimersByTimeAsync(MESHCORE_BACKGROUND_START_DELAY_MS * 2);
    expect(t.commands).toEqual([]);

    t.bg.setRendererPresent(false);
    await vi.advanceTimersByTimeAsync(MESHCORE_BACKGROUND_START_DELAY_MS);
    expect(t.commands).toEqual([1, 10, 10]);
    expect(t.rows).toHaveLength(1);

    // MsgWaiting while no tab is present: pull again (self already known: no AppStart).
    t.bg.taps.serial.onData(fromRadio([0x83]));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.commands).toEqual([1, 10, 10, 10]);

    // A tab arriving cancels a pending start.
    t.bg.setRendererPresent(true);
    expect(t.caughtUp).toEqual([1]);
    t.bg.setRendererPresent(false);
    t.bg.setRendererPresent(true);
    await vi.advanceTimersByTimeAsync(MESHCORE_BACKGROUND_START_DELAY_MS);
    expect(t.commands).toHaveLength(4);
  });

  it('gives up on a command the radio does not answer and stops when the link closes', async () => {
    const t = setup([]);
    const writes: Uint8Array[] = [];
    t.bg.taps.tcp.onOpen((frame) => writes.push(frame), { origin: 'backend' });
    await vi.advanceTimersByTimeAsync(MESHCORE_BACKGROUND_START_DELAY_MS);
    expect(writes).toHaveLength(1);
    t.bg.taps.tcp.onClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(1);
    expect(t.rows).toEqual([]);
  });
});
