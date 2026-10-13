#!/usr/bin/env node
/**
 * Minimal fake MeshCore companion radio on TCP, for exercising the headless web UI (and the
 * desktop app's MeshCore TCP connect) without hardware:
 *
 *   node scripts/fake-meshcore-radio.mjs [--port 5000] [--chatter-ms 5000]
 *
 * Frames are `<` / `>` + little-endian 16-bit length + payload, payload[0] = command / reply code
 * (layouts as parsed by @liamcottle/meshcore.js). It answers app start (self info), device query,
 * contacts (two peers), channel 0, battery, time, message sync and sends; private-key export is
 * disabled, and any other command gets an "unsupported" error.
 * Every `--chatter-ms` (0 disables) a peer posts a channel message: it is queued and announced
 * with a MsgWaiting push, and handed out by SyncNextMessage, like real firmware.
 *
 * Like real firmware it serves one client at a time: a new connection closes the previous one.
 */
import net from 'node:net';

const CMD = {
  AppStart: 1,
  SendTxtMsg: 2,
  SendChannelTxtMsg: 3,
  GetContacts: 4,
  GetDeviceTime: 5,
  SyncNextMessage: 10,
  GetBatteryVoltage: 20,
  DeviceQuery: 22,
  GetChannel: 31,
  ExportPrivateKey: 23,
  SetDeviceTime: 6,
  SendSelfAdvert: 7,
};
const RESP = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  CurrTime: 9,
  NoMoreMessages: 10,
  BatteryVoltage: 12,
  DeviceInfo: 13,
  ChannelMsgRecvV3: 17,
  ChannelInfo: 18,
  Disabled: 15,
};
const PUSH_MSG_WAITING = 0x83;
const ERR_UNSUPPORTED = 1;
const ERR_NOT_FOUND = 2;

class Writer {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  i8(v) {
    return this.u8(v < 0 ? v + 256 : v);
  }
  u16(v) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  i32(v) {
    return this.u32(v >>> 0);
  }
  raw(arr) {
    for (const b of arr) this.u8(b);
    return this;
  }
  /** Fixed-size, NUL-padded string. */
  cstr(s, size) {
    const enc = new TextEncoder().encode(s).slice(0, size - 1);
    this.raw(enc);
    for (let i = enc.length; i < size; i++) this.u8(0);
    return this;
  }
  str(s) {
    return this.raw(new TextEncoder().encode(s));
  }
}

const key = (seed) => Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) & 0xff);
export const FAKE_MESHCORE_SELF_KEY = key(1);
export const FAKE_MESHCORE_PEERS = [
  { name: 'Fake Peer One', key: key(2) },
  { name: 'Fake Peer Two', key: key(3) },
];

/** Wrap a reply payload in an incoming (`>`) frame. */
export function incomingFrame(payload) {
  return Buffer.from([0x3e, payload.length & 0xff, payload.length >> 8, ...payload]);
}

/**
 * Start the fake radio. Returns its server and what it saw, for tests and scripts.
 * @param {{ port?: number, host?: string, chatterMs?: number, log?: (line: string) => void }} [opts]
 */
export function startFakeMeshcoreRadio(opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {{ commands: number[], sent: string[], connections: number }} */
  const seen = { commands: [], sent: [], connections: 0 };
  /** @type {string[]} queued channel messages waiting for SyncNextMessage */
  const waiting = [];
  /** @type {net.Socket | null} */
  let client = null;
  let chatterCount = 0;

  const reply = (socket, w) => socket.write(incomingFrame(w.bytes));

  const handle = (socket, payload) => {
    const code = payload[0];
    seen.commands.push(code);
    switch (code) {
      case CMD.AppStart: {
        const w = new Writer().u8(RESP.SelfInfo).u8(1).u8(20).u8(22).raw(FAKE_MESHCORE_SELF_KEY);
        w.i32(0)
          .i32(0)
          .raw([0, 0, 0])
          .u8(0)
          .u32(910525)
          .u32(62500)
          .u8(7)
          .u8(5)
          .str('Fake MeshCore');
        reply(socket, w);
        return;
      }
      case CMD.DeviceQuery: {
        const w = new Writer().u8(RESP.DeviceInfo).i8(8).raw([175, 8, 0, 0, 0, 0]);
        w.cstr('01 Jan 2026', 12).cstr('Fake Companion', 40).cstr('v1.9.0', 20).u8(0).u8(0);
        reply(socket, w);
        return;
      }
      case CMD.GetContacts: {
        reply(socket, new Writer().u8(RESP.ContactsStart).u32(FAKE_MESHCORE_PEERS.length));
        const now = Math.floor(Date.now() / 1000);
        for (const peer of FAKE_MESHCORE_PEERS) {
          const w = new Writer().u8(RESP.Contact).raw(peer.key).u8(1).u8(0).i8(-1);
          w.raw(new Array(64).fill(0)).cstr(peer.name, 32).u32(now).i32(0).i32(0).u32(now);
          reply(socket, w);
        }
        reply(socket, new Writer().u8(RESP.EndOfContacts).u32(now));
        return;
      }
      case CMD.GetChannel: {
        const idx = payload[1] ?? 0;
        if (idx !== 0) {
          reply(socket, new Writer().u8(RESP.Err).u8(ERR_NOT_FOUND));
          return;
        }
        const secret = [
          0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a, 0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd,
          0x72,
        ];
        reply(socket, new Writer().u8(RESP.ChannelInfo).u8(0).cstr('Public', 32).raw(secret));
        return;
      }
      case CMD.SyncNextMessage: {
        const text = waiting.shift();
        if (text === undefined) {
          reply(socket, new Writer().u8(RESP.NoMoreMessages));
          return;
        }
        const w = new Writer().u8(RESP.ChannelMsgRecvV3).i8(24).u8(0).u8(0);
        w.i8(0)
          .u8(1)
          .u8(0)
          .u32(Math.floor(Date.now() / 1000))
          .str(text);
        reply(socket, w);
        return;
      }
      case CMD.SendChannelTxtMsg: {
        // [code, txtType, channelIdx, timestamp(4), text...]
        const text = new TextDecoder().decode(Uint8Array.from(payload.slice(7)));
        seen.sent.push(text);
        log(`channel text from client: ${JSON.stringify(text)}`);
        reply(socket, new Writer().u8(RESP.Ok));
        return;
      }
      case CMD.SendTxtMsg: {
        seen.sent.push('(direct message)');
        reply(socket, new Writer().u8(RESP.Sent).i8(0).u32(0x1234).u32(5000));
        return;
      }
      case CMD.GetBatteryVoltage:
        reply(socket, new Writer().u8(RESP.BatteryVoltage).u16(4100));
        return;
      case CMD.GetDeviceTime:
        reply(socket, new Writer().u8(RESP.CurrTime).u32(Math.floor(Date.now() / 1000)));
        return;
      case CMD.ExportPrivateKey:
        reply(socket, new Writer().u8(RESP.Disabled));
        return;
      case CMD.SetDeviceTime:
      case CMD.SendSelfAdvert:
        reply(socket, new Writer().u8(RESP.Ok));
        return;
      default:
        // Like firmware without that command: an error reply, so the client does not wait.
        reply(socket, new Writer().u8(RESP.Err).u8(ERR_UNSUPPORTED));
    }
  };

  const server = net.createServer((socket) => {
    seen.connections += 1;
    if (client) {
      log('new client; closing the previous one (one client at a time, like firmware)');
      client.destroy();
    }
    client = socket;
    let buf = Buffer.alloc(0);
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 3) {
        if (buf[0] !== 0x3c) {
          buf = buf.subarray(1);
          continue;
        }
        const len = buf[1] | (buf[2] << 8);
        if (buf.length < 3 + len) break;
        const payload = [...buf.subarray(3, 3 + len)];
        buf = buf.subarray(3 + len);
        if (payload.length > 0) handle(socket, payload);
      }
    });
    socket.on('close', () => {
      if (client === socket) client = null;
    });
    socket.on('error', () => {
      // a client reset is normal when the bridge replaces its socket
    });
  });

  const queueChannelMessage = (text) => {
    waiting.push(text);
    client?.write(incomingFrame([PUSH_MSG_WAITING]));
  };
  const chatter =
    opts.chatterMs && opts.chatterMs > 0
      ? setInterval(() => {
          if (!client) return;
          chatterCount += 1;
          queueChannelMessage(`Fake Peer One: fake chatter #${chatterCount}`);
        }, opts.chatterMs)
      : null;

  return new Promise((resolve) => {
    server.listen(opts.port ?? 5000, opts.host ?? '127.0.0.1', () => {
      resolve({
        server,
        seen,
        port: /** @type {net.AddressInfo} */ (server.address()).port,
        /** Queue a channel message from a peer and announce it (MsgWaiting push). */
        say: (text) => {
          queueChannelMessage(`Fake Peer One: ${text}`);
        },
        close: () => {
          if (chatter) clearInterval(chatter);
          client?.destroy();
          return new Promise((done) => server.close(() => done(undefined)));
        },
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const radio = await startFakeMeshcoreRadio({
    port: arg('--port', 5000),
    chatterMs: arg('--chatter-ms', 5000),
    log: (line) => console.info(`[fake-meshcore] ${line}`),
  });
  console.info(`[fake-meshcore] listening on 127.0.0.1:${radio.port}`);
}
