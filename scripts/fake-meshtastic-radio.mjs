#!/usr/bin/env node
/**
 * Minimal fake Meshtastic radio on the TCP stream API, for exercising the headless web UI (and the
 * desktop app's TCP connect) without hardware:
 *
 *   node scripts/fake-meshtastic-radio.mjs [--port 4403] [--chatter-ms 5000]
 *
 * - Answers `want_config_id` with a small config dump: its own node, one named peer, a primary
 *   channel, then `config_complete_id` with the same nonce.
 * - Acknowledges every packet a client sends with a Routing ACK (so sends show as delivered) and
 *   logs its text.
 * - Every `--chatter-ms` (0 disables) the peer posts a numbered channel message.
 *
 * Like real firmware it serves one client at a time: a new connection closes the previous one.
 * Not a protocol reference; just enough for the renderer to configure and chat.
 */
import net from 'node:net';

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Channel, Mesh, Portnums } from '@meshtastic/protobufs';

export const FAKE_RADIO_NODE = 0x1a2b3c4d;
export const FAKE_PEER_NODE = 0x5e6f7a8b;
const BROADCAST = 0xffffffff;

/** @param {Mesh.FromRadio['payloadVariant']} variant */
export function fromRadioFrame(variant) {
  const bytes = toBinary(
    Mesh.FromRadioSchema,
    create(Mesh.FromRadioSchema, { payloadVariant: variant }),
  );
  const out = new Uint8Array(4 + bytes.length);
  out.set([0x94, 0xc3, (bytes.length >> 8) & 0xff, bytes.length & 0xff]);
  out.set(bytes, 4);
  return out;
}

/** @param {number} nonce */
export function configDumpFrames(nonce) {
  const user = (longName, shortName) => create(Mesh.UserSchema, { longName, shortName });
  return [
    fromRadioFrame({
      case: 'myInfo',
      value: create(Mesh.MyNodeInfoSchema, { myNodeNum: FAKE_RADIO_NODE }),
    }),
    fromRadioFrame({
      case: 'nodeInfo',
      value: create(Mesh.NodeInfoSchema, {
        num: FAKE_RADIO_NODE,
        user: user('Fake Radio', 'FAKE'),
      }),
    }),
    fromRadioFrame({
      case: 'nodeInfo',
      value: create(Mesh.NodeInfoSchema, {
        num: FAKE_PEER_NODE,
        lastHeard: Math.floor(Date.now() / 1000),
        user: user('Fake Peer', 'PEER'),
      }),
    }),
    fromRadioFrame({
      case: 'channel',
      value: create(Channel.ChannelSchema, {
        index: 0,
        role: Channel.Channel_Role.PRIMARY,
        settings: create(Channel.ChannelSettingsSchema, { name: '', psk: new Uint8Array([1]) }),
      }),
    }),
    fromRadioFrame({ case: 'configCompleteId', value: nonce }),
  ];
}

/** @param {number} from @param {number} to @param {string} text @param {number} id */
export function textPacketFrame(from, to, text, id) {
  return fromRadioFrame({
    case: 'packet',
    value: create(Mesh.MeshPacketSchema, {
      from,
      to,
      id,
      channel: 0,
      rxTime: Math.floor(Date.now() / 1000),
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
          payload: new TextEncoder().encode(text),
        }),
      },
    }),
  });
}

/** Routing ACK for a packet the client sent (`request_id` = its id). */
export function ackFrame(requestId, to) {
  return fromRadioFrame({
    case: 'packet',
    value: create(Mesh.MeshPacketSchema, {
      from: FAKE_RADIO_NODE,
      to,
      id: (Math.random() * 0xffffffff) >>> 0,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.ROUTING_APP,
          requestId,
          payload: toBinary(
            Mesh.RoutingSchema,
            create(Mesh.RoutingSchema, {
              variant: { case: 'errorReason', value: Mesh.Routing_Error.NONE },
            }),
          ),
        }),
      },
    }),
  });
}

/**
 * Start the fake radio. Returns its server and the events it saw, for tests and scripts.
 * @param {{ port?: number, host?: string, chatterMs?: number, log?: (line: string) => void }} [opts]
 */
export function startFakeMeshtasticRadio(opts = {}) {
  const log = opts.log ?? (() => {});
  /** @type {{ wantConfigs: number, texts: string[], connections: number }} */
  const seen = { wantConfigs: 0, texts: [], connections: 0 };
  /** @type {net.Socket | null} */
  let client = null;
  let chatterCount = 0;
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
      while (buf.length >= 4 && buf[0] === 0x94 && buf[1] === 0xc3) {
        const len = (buf[2] << 8) | buf[3];
        if (buf.length < 4 + len) break;
        const toRadio = fromBinary(Mesh.ToRadioSchema, buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
        const v = toRadio.payloadVariant;
        if (v.case === 'wantConfigId') {
          seen.wantConfigs += 1;
          log(`want_config ${v.value}`);
          for (const f of configDumpFrames(v.value)) socket.write(f);
        } else if (v.case === 'packet') {
          const p = v.value;
          if (p.payloadVariant.case === 'decoded') {
            const d = p.payloadVariant.value;
            if (d.portnum === Portnums.PortNum.TEXT_MESSAGE_APP) {
              const text = new TextDecoder().decode(d.payload);
              seen.texts.push(text);
              log(`text from client: ${JSON.stringify(text)}`);
            }
          }
          if (p.wantAck || p.id) socket.write(ackFrame(p.id, FAKE_RADIO_NODE));
        }
      }
      // Resync on junk: drop bytes up to the next frame header.
      const next = buf.indexOf(Buffer.from([0x94, 0xc3]));
      if (next > 0) buf = buf.subarray(next);
      else if (next === -1 && buf.length > 1) buf = Buffer.alloc(0);
    });
    socket.on('close', () => {
      if (client === socket) client = null;
    });
    socket.on('error', () => {
      // a client reset is normal when the bridge replaces its socket
    });
  });
  const chatter =
    opts.chatterMs && opts.chatterMs > 0
      ? setInterval(() => {
          if (!client) return;
          chatterCount += 1;
          client.write(
            textPacketFrame(
              FAKE_PEER_NODE,
              BROADCAST,
              `fake chatter #${chatterCount}`,
              1000 + chatterCount,
            ),
          );
        }, opts.chatterMs)
      : null;
  return new Promise((resolve) => {
    server.listen(opts.port ?? 4403, opts.host ?? '127.0.0.1', () => {
      resolve({
        server,
        seen,
        port: /** @type {net.AddressInfo} */ (server.address()).port,
        /** Send a channel message from the fake peer now. */
        say: (text) => {
          chatterCount += 1;
          client?.write(textPacketFrame(FAKE_PEER_NODE, BROADCAST, text, 1000 + chatterCount));
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
  const radio = await startFakeMeshtasticRadio({
    port: arg('--port', 4403),
    chatterMs: arg('--chatter-ms', 5000),
    log: (line) => console.info(`[fake-radio] ${line}`),
  });
  console.info(`[fake-radio] listening on 127.0.0.1:${radio.port}`);
}
