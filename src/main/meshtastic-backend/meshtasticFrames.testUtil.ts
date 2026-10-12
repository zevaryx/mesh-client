/**
 * Test-only builders for Meshtastic stream frames (FromRadio protobufs with the 0x94 0xC3 header),
 * shared by the background ingest unit tests and the headless end-to-end test.
 */
import { create, toBinary } from '@bufbuild/protobuf';
import { Channel, Mesh, Portnums } from '@meshtastic/protobufs';

import { frameMeshtasticToRadio } from './meshtasticBackendIngest';

const { PortNum } = Portnums;

export const ME = 0x11111111;
export const ALICE = 0x22222222;
export const BROADCAST = 0xffffffff;
export const PSK = new Uint8Array(16).fill(7);

export function frame(variant: Mesh.FromRadio['payloadVariant']): Uint8Array {
  return frameMeshtasticToRadio(
    toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, { payloadVariant: variant })),
  );
}

export function textPacket(opts: {
  from: number;
  to: number;
  id: number;
  text: string;
  channel?: number;
  emoji?: number;
  replyId?: number;
}): Uint8Array {
  return frame({
    case: 'packet',
    value: create(Mesh.MeshPacketSchema, {
      from: opts.from,
      to: opts.to,
      id: opts.id,
      channel: opts.channel ?? 0,
      rxTime: 1_700_000_000,
      hopStart: 3,
      hopLimit: 1,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: PortNum.TEXT_MESSAGE_APP,
          payload: new TextEncoder().encode(opts.text),
          emoji: opts.emoji ?? 0,
          replyId: opts.replyId ?? 0,
        }),
      },
    }),
  });
}

/** The config dump a radio sends after connect: own node, a named peer, one channel. */
export function configDump(): Uint8Array[] {
  return [
    frame({ case: 'myInfo', value: create(Mesh.MyNodeInfoSchema, { myNodeNum: ME }) }),
    frame({
      case: 'nodeInfo',
      value: create(Mesh.NodeInfoSchema, {
        num: ALICE,
        user: create(Mesh.UserSchema, { longName: 'Alice Base', shortName: 'ALI' }),
      }),
    }),
    frame({
      case: 'channel',
      value: create(Channel.ChannelSchema, {
        index: 0,
        role: Channel.Channel_Role.PRIMARY,
        settings: create(Channel.ChannelSettingsSchema, { name: 'Ops', psk: PSK }),
      }),
    }),
  ];
}
