// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MESHCORE_MUX_REPLY_IDLE_MS, MeshcoreFrameReader, MeshcoreTcpMux } from './meshcoreTcpMux';

const out = (...payload: number[]) => Uint8Array.from([0x3c, payload.length, 0, ...payload]);
const inc = (...payload: number[]) => Uint8Array.from([0x3e, payload.length, 0, ...payload]);

const APP_START = 1;
const GET_CONTACTS = 4;
const SYNC_NEXT = 10;
const OK = 0;
const CONTACTS_START = 2;
const CONTACT = 3;
const END_OF_CONTACTS = 4;
const SELF_INFO = 5;
const NO_MORE = 10;
const MSG_WAITING = 0x83;

function setup() {
  const written: number[][] = [];
  const delivered: { to: number | null; code: number }[] = [];
  const mux = new MeshcoreTcpMux({
    writeToRadio: (frame) => written.push([...frame]),
    deliver: (to, frame) => delivered.push({ to, code: frame[3] ?? -1 }),
  });
  return { mux, written, delivered };
}

describe('MeshcoreFrameReader', () => {
  it('reassembles split frames and skips garbage', () => {
    const reader = new MeshcoreFrameReader(0x3e);
    const bytes = Uint8Array.from([0x00, 0xff, ...inc(5, 1, 2), ...inc(0x83)]);
    expect(reader.push(bytes.subarray(0, 4))).toEqual([]);
    const frames = reader.push(bytes.subarray(4));
    expect(frames.map((f) => [...f])).toEqual([[...inc(5, 1, 2)], [...inc(0x83)]]);
  });
});

describe('MeshcoreTcpMux', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends one command at a time and routes each reply to the tab that asked', () => {
    const t = setup();
    t.mux.fromSession(1, out(APP_START));
    t.mux.fromSession(2, out(APP_START));
    expect(t.written).toHaveLength(1);
    t.mux.fromRadio(inc(SELF_INFO, 9));
    expect(t.delivered).toEqual([{ to: 1, code: SELF_INFO }]);
    expect(t.written).toHaveLength(2);
    t.mux.fromRadio(inc(SELF_INFO, 9));
    expect(t.delivered.at(-1)).toEqual({ to: 2, code: SELF_INFO });
  });

  it('keeps the link for the whole contacts sequence', () => {
    const t = setup();
    t.mux.fromSession(1, out(GET_CONTACTS));
    t.mux.fromSession(2, out(SYNC_NEXT));
    t.mux.fromRadio(
      Uint8Array.from([
        ...inc(CONTACTS_START, 2, 0, 0, 0),
        ...inc(CONTACT, 1),
        ...inc(MSG_WAITING), // a push in the middle goes to everyone
        ...inc(CONTACT, 2),
      ]),
    );
    expect(t.written).toHaveLength(1);
    t.mux.fromRadio(inc(END_OF_CONTACTS, 0, 0, 0, 0));
    expect(t.delivered).toEqual([
      { to: 1, code: CONTACTS_START },
      { to: 1, code: CONTACT },
      { to: null, code: MSG_WAITING },
      { to: 1, code: CONTACT },
      { to: 1, code: END_OF_CONTACTS },
    ]);
    expect(t.written.at(-1)?.[3]).toBe(SYNC_NEXT);
    t.mux.fromRadio(inc(NO_MORE));
    expect(t.delivered.at(-1)).toEqual({ to: 2, code: NO_MORE });
  });

  it('parses several commands in one write and commands split across writes', () => {
    const t = setup();
    const both = Uint8Array.from([...out(APP_START), ...out(SYNC_NEXT)]);
    t.mux.fromSession(1, both.subarray(0, 2));
    expect(t.written).toHaveLength(0);
    t.mux.fromSession(1, both.subarray(2));
    expect(t.written).toHaveLength(1);
    t.mux.fromRadio(inc(SELF_INFO));
    expect(t.written.at(-1)?.[3]).toBe(SYNC_NEXT);
  });

  it('releases the link when a command gets no reply, then sends replies to every tab', () => {
    vi.useFakeTimers();
    const t = setup();
    t.mux.fromSession(1, out(19)); // reboot: no reply
    t.mux.fromSession(2, out(APP_START));
    vi.advanceTimersByTime(MESHCORE_MUX_REPLY_IDLE_MS);
    expect(t.written.at(-1)?.[3]).toBe(APP_START);
    t.mux.fromRadio(inc(SELF_INFO));
    expect(t.delivered.at(-1)).toEqual({ to: 2, code: SELF_INFO });
    t.mux.fromRadio(inc(OK)); // stray late reply: nobody is waiting
    expect(t.delivered.at(-1)).toEqual({ to: null, code: OK });
  });

  it('drops a closed tab: its queued commands, and replies to its in-flight one', () => {
    const t = setup();
    t.mux.fromSession(1, out(APP_START));
    t.mux.fromSession(1, out(SYNC_NEXT));
    t.mux.fromSession(2, out(SYNC_NEXT));
    t.mux.sessionClosed(1);
    t.mux.fromRadio(inc(SELF_INFO));
    expect(t.delivered).toEqual([]);
    expect(t.written.map((f) => f[3])).toEqual([APP_START, SYNC_NEXT]);
    t.mux.fromRadio(inc(NO_MORE));
    expect(t.delivered).toEqual([{ to: 2, code: NO_MORE }]);
  });

  it('forgets everything when the link resets', () => {
    const t = setup();
    t.mux.fromSession(1, out(APP_START));
    t.mux.fromSession(2, out(APP_START));
    t.mux.reset();
    t.mux.fromRadio(inc(SELF_INFO));
    expect(t.delivered).toEqual([{ to: null, code: SELF_INFO }]);
    t.mux.fromSession(2, out(SYNC_NEXT));
    expect(t.written.at(-1)?.[3]).toBe(SYNC_NEXT);
  });
});
