import { describe, expect, it } from 'vitest';

import {
  decodeWireValue,
  encodeWireValue,
  formatWebBridgeInvokeError,
  normalizeHeadlessHostPlatform,
  parseWebBridgeClientFrame,
  parseWebBridgeServerFrame,
  serializeWebBridgeFrame,
} from './webBridgeProtocol';

function roundTrip(value: unknown): unknown {
  return decodeWireValue(JSON.parse(JSON.stringify(encodeWireValue(value))));
}

describe('webBridgeProtocol value codec', () => {
  it('round-trips JSON primitives and nested plain data', () => {
    const value = { a: 1, b: 'x', c: [true, null, { d: 2.5 }], e: {} };
    expect(roundTrip(value)).toEqual(value);
  });

  it('round-trips Uint8Array and turns Buffer / other views into Uint8Array', () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const out = roundTrip(bytes);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([0, 1, 254, 255]);

    const buf = Buffer.from([9, 8, 7]);
    const fromBuf = roundTrip(buf);
    expect(fromBuf).toBeInstanceOf(Uint8Array);
    expect(Array.from(fromBuf as Uint8Array)).toEqual([9, 8, 7]);

    const offsetView = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 3);
    expect(Array.from(roundTrip(offsetView) as Uint8Array)).toEqual([2, 3]);
  });

  it('round-trips large byte payloads (chunked base64)', () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    const out = roundTrip(big) as Uint8Array;
    expect(out.length).toBe(big.length);
    expect(out[199_999]).toBe(199_999 % 256);
  });

  it('round-trips ArrayBuffer, Date, Map, Set, bigint and undefined in arrays', () => {
    const ab = new Uint8Array([5, 6]).buffer;
    const outAb = roundTrip(ab);
    expect(outAb).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(outAb as ArrayBuffer))).toEqual([5, 6]);

    expect(roundTrip(new Date(1_700_000_000_000))).toEqual(new Date(1_700_000_000_000));
    expect(roundTrip(new Map([['k', new Uint8Array([1])]]))).toEqual(
      new Map([['k', new Uint8Array([1])]]),
    );
    expect(roundTrip(new Set([1, 'a']))).toEqual(new Set([1, 'a']));
    expect(roundTrip(12345678901234567890n)).toBe(12345678901234567890n);
    expect(roundTrip([1, undefined, 3])).toEqual([1, undefined, 3]);
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it('omits undefined object properties like JSON does', () => {
    expect(roundTrip({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('keeps user objects that own the tag key intact', () => {
    const tricky = { __mcwb: 'u8', b64: 'not-really' };
    expect(roundTrip(tricky)).toEqual(tricky);
  });

  it('encodes Errors as { name, message }', () => {
    expect(roundTrip(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
  });

  it('refuses functions and symbols (structured clone would too)', () => {
    expect(() => encodeWireValue(() => 1)).toThrow(TypeError);
    expect(() => encodeWireValue({ f: Symbol('x') })).toThrow(TypeError);
  });
});

describe('webBridgeProtocol frames', () => {
  it('serializes and parses client invoke / send frames', () => {
    const invoke = serializeWebBridgeFrame({
      t: 'invoke',
      id: 7,
      channel: 'meshtastic:tcp-write',
      args: [new Uint8Array([1, 2])],
    });
    const parsed = parseWebBridgeClientFrame(invoke);
    expect(parsed).toMatchObject({ t: 'invoke', id: 7, channel: 'meshtastic:tcp-write' });
    expect(Array.from((parsed?.args[0] as Uint8Array | undefined) ?? [])).toEqual([1, 2]);

    expect(
      parseWebBridgeClientFrame(serializeWebBridgeFrame({ t: 'send', channel: 'x', args: [1] })),
    ).toEqual({ t: 'send', channel: 'x', args: [1] });
  });

  it('serializes and parses server result / error / event frames', () => {
    expect(
      parseWebBridgeServerFrame(serializeWebBridgeFrame({ t: 'result', id: 1, value: undefined })),
    ).toEqual({ t: 'result', id: 1, value: undefined });
    expect(
      parseWebBridgeServerFrame(serializeWebBridgeFrame({ t: 'error', id: 2, message: 'nope' })),
    ).toEqual({ t: 'error', id: 2, message: 'nope' });
    const ev = parseWebBridgeServerFrame(
      serializeWebBridgeFrame({ t: 'event', channel: 'tcp-data', args: [new Uint8Array([3])] }),
    );
    expect(ev).toMatchObject({ t: 'event', channel: 'tcp-data' });
  });

  it('rejects malformed frames', () => {
    expect(parseWebBridgeClientFrame('not json')).toBeNull();
    expect(parseWebBridgeClientFrame('[]')).toBeNull();
    expect(parseWebBridgeClientFrame('{"t":"invoke","channel":"x","args":[]}')).toBeNull();
    expect(parseWebBridgeClientFrame('{"t":"invoke","id":1.5,"channel":"x","args":[]}')).toBeNull();
    expect(parseWebBridgeClientFrame('{"t":"invoke","id":1,"channel":"x","args":{}}')).toBeNull();
    expect(parseWebBridgeClientFrame('{"t":"result","id":1,"channel":"x","args":[]}')).toBeNull();
    expect(parseWebBridgeServerFrame('{"t":"error","id":1}')).toBeNull();
    expect(parseWebBridgeServerFrame('{"t":"event","channel":"x"}')).toBeNull();
    expect(parseWebBridgeServerFrame('{"t":"other","id":1}')).toBeNull();
  });

  it('formats invoke errors like Electron', () => {
    expect(formatWebBridgeInvokeError('db:getNodes', 'boom')).toBe(
      "Error invoking remote method 'db:getNodes': Error: boom",
    );
  });
});

describe('normalizeHeadlessHostPlatform', () => {
  it.each(['linux', 'darwin', 'win32'])('keeps %s', (os) => {
    expect(normalizeHeadlessHostPlatform(os)).toBe(os);
  });

  it('maps anything else to linux', () => {
    for (const v of ['freebsd', 'openbsd', '', null, undefined, 42]) {
      expect(normalizeHeadlessHostPlatform(v)).toBe('linux');
    }
  });
});

describe('webBridgeProtocol hostile frames', () => {
  const invoke = (args: unknown): string =>
    JSON.stringify({ t: 'invoke', id: 1, channel: 'x:y', args });

  it.each([
    ['bad base64', { __mcwb: 'u8', b64: '%%%' }],
    ['map without entries', { __mcwb: 'map' }],
    ['set without values', { __mcwb: 'set', values: 5 }],
    ['invalid bigint', { __mcwb: 'bigint', s: 'not-a-number' }],
  ])('drops a frame with a malformed tag (%s) instead of throwing', (_label, tagged) => {
    expect(() => parseWebBridgeClientFrame(invoke([tagged]))).not.toThrow();
    expect(parseWebBridgeClientFrame(invoke([tagged]))).toBeNull();
    const result = JSON.stringify({ t: 'result', id: 2, value: tagged });
    expect(parseWebBridgeServerFrame(result)).toBeNull();
  });

  it('drops nesting deep enough to overflow the decoder', () => {
    const deep = `${'['.repeat(200_000)}${']'.repeat(200_000)}`;
    const raw = `{"t":"invoke","id":1,"channel":"x:y","args":[${deep}]}`;
    expect(parseWebBridgeClientFrame(raw)).toBeNull();
  });

  it('keeps "__proto__" as a plain field instead of a prototype', () => {
    const frame = parseWebBridgeClientFrame(invoke([JSON.parse('{"__proto__":{"admin":true}}')]));
    const arg = frame?.t === 'invoke' ? (frame.args[0] as Record<string, unknown>) : null;
    expect(Object.getPrototypeOf(arg)).toBe(Object.prototype);
    expect((arg as { admin?: boolean } | null)?.admin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(arg, '__proto__')).toBe(true);
  });

  it('still decodes a legitimate null result', () => {
    expect(parseWebBridgeServerFrame(JSON.stringify({ t: 'result', id: 3, value: null }))).toEqual({
      t: 'result',
      id: 3,
      value: null,
    });
  });
});
