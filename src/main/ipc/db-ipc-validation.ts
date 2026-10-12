/**
 * Main-process boundary validation for the `db:*` IPC handlers (payload caps, id coercion,
 * MeshCore contact/message shape checks). Shared by the Electron main process and the headless
 * server through `db-meshtastic-handlers.ts` / `db-meshcore-handlers.ts`.
 */
import { isChannelIdentityKey } from '../../shared/channelIdentityKey';
import {
  sanitizeMeshcoreAdvLatLonForDb,
  sanitizeMeshcoreLastAdvertForDb,
} from '../../shared/meshcoreContactSanitize';
import { type MeshcoreContactUpsertParams } from '../database';
import { validateMeshcoreMessageLocalOrder } from '../meshcoreMessageChannel';

export const MAX_PAYLOAD_LENGTH = 1024 * 1024; // 1MB cap for message payload
export const MAX_STATUS_STRING = 1024;
// Align with reasonable Meshtastic/DB bounds to prevent unbounded string allocation
export const MAX_NODE_STRING = 512;
export const MAX_HW_MODEL = 128;
export const MAX_GROUP_NAME = 100;

export function safeNonNegativeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid non-negative integer');
  return n >>> 0;
}

/** MeshCore chat channel index (-2 Rooms, -1 DMs, 0+ group channels). */
export function safeMeshcoreChannelIndex(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < -2 || n > 1_000_000) {
    throw new Error('Invalid MeshCore channel index');
  }
  return Math.trunc(n);
}

/** 0 means the connected radio is unknown. Positive values are companion node ids. */
export function safeMeshcoreRadioNodeId(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      'db:clearMeshcoreMessagesByChannel: radioNodeId must be a non-negative integer',
    );
  }
  return n;
}

/** `db:saveMessage` payload after {@link validateSaveMessage}. */
export type SaveMessageInput = Record<string, unknown> & {
  sender_id: number;
  sender_name: string;
  payload: string;
  channel: number;
  timestamp: number;
  packetId?: number;
  status?: string;
  error?: string;
  emoji?: number;
  replyId?: number;
  to?: number;
  mqttStatus?: string;
  receivedVia?: string;
};

export function validateSaveMessage(message: unknown): asserts message is SaveMessageInput {
  if (!message || typeof message !== 'object')
    throw new Error('db:saveMessage: message must be an object');
  const m = message as Record<string, unknown>;
  if (typeof m.payload !== 'string') throw new Error('db:saveMessage: payload must be a string');
  if (m.payload.length > MAX_PAYLOAD_LENGTH) throw new Error('db:saveMessage: payload too long');
  const rawSenderId = Number(m.sender_id);
  if (!Number.isFinite(rawSenderId))
    throw new Error('db:saveMessage: sender_id must be a finite number');
  m.sender_id = rawSenderId >>> 0;
  if (m.to != null) {
    const rawTo = Number(m.to);
    if (!Number.isFinite(rawTo)) throw new Error('db:saveMessage: to must be a finite number');
    m.to = rawTo >>> 0;
  }
  if (typeof m.sender_name !== 'string')
    throw new Error('db:saveMessage: sender_name must be a string');
  if (m.sender_name.length > MAX_NODE_STRING)
    throw new Error('db:saveMessage: sender_name too long');
  if (m.status != null && typeof m.status === 'string' && m.status.length > MAX_STATUS_STRING)
    throw new Error('db:saveMessage: status too long');
  if (m.error != null && typeof m.error === 'string' && m.error.length > MAX_STATUS_STRING)
    throw new Error('db:saveMessage: error too long');
  if (
    m.mqttStatus != null &&
    typeof m.mqttStatus === 'string' &&
    m.mqttStatus.length > MAX_STATUS_STRING
  )
    throw new Error('db:saveMessage: mqttStatus too long');
  safeNonNegativeInt(m.channel);
  if (typeof m.timestamp !== 'number' && typeof m.timestamp !== 'undefined')
    throw new Error('db:saveMessage: timestamp must be a number');
  if (m.timestamp != null && !Number.isFinite(m.timestamp))
    throw new Error('db:saveMessage: invalid timestamp');
  if (m.rxHops != null) {
    const h = Number(m.rxHops);
    if (!Number.isInteger(h) || h < 0)
      throw new Error('db:saveMessage: rxHops must be a non-negative integer');
  }
  if (m.radioNodeId != null) {
    const radio = Number(m.radioNodeId);
    if (!Number.isSafeInteger(radio) || radio < 0)
      throw new Error('db:saveMessage: radioNodeId must be a non-negative integer');
  }
  if (m.channelKey != null && !isChannelIdentityKey(m.channelKey))
    throw new Error('db:saveMessage: channelKey must be a channel identity key');
}

export function validateSaveNode(
  node: unknown,
): asserts node is Record<string, unknown> & { node_id: number } {
  if (!node || typeof node !== 'object') throw new Error('db:saveNode: node must be an object');
  const n = node as Record<string, unknown>;
  const rawNodeId = Number(n.node_id);
  if (!Number.isFinite(rawNodeId)) throw new Error('db:saveNode: node_id must be a finite number');
  n.node_id = rawNodeId >>> 0;
  const checkStr = (key: string, max: number) => {
    const v = n[key];
    if (v != null && typeof v === 'string' && v.length > max)
      throw new Error(`db:saveNode: ${key} exceeds maximum length`);
  };
  checkStr('long_name', MAX_NODE_STRING);
  checkStr('short_name', 64);
  checkStr('hw_model', MAX_HW_MODEL);
  checkStr('source', 64);
}

export function validateSaveMeshcoreMessage(msg: unknown): asserts msg is Record<
  string,
  unknown
> & {
  payload: string;
  timestamp: number;
} {
  if (!msg || typeof msg !== 'object')
    throw new Error('db:saveMeshcoreMessage: message must be an object');
  const m = msg as Record<string, unknown>;
  if (typeof m.payload !== 'string')
    throw new Error('db:saveMeshcoreMessage: payload must be a string');
  if (m.payload.length > MAX_PAYLOAD_LENGTH)
    throw new Error('db:saveMeshcoreMessage: payload too long');
  if (typeof m.timestamp !== 'number' || !Number.isFinite(m.timestamp))
    throw new Error('db:saveMeshcoreMessage: timestamp must be a finite number');
  if (
    m.sender_name != null &&
    typeof m.sender_name === 'string' &&
    m.sender_name.length > MAX_NODE_STRING
  )
    throw new Error('db:saveMeshcoreMessage: sender_name too long');
  if (m.status != null && typeof m.status === 'string' && m.status.length > MAX_STATUS_STRING)
    throw new Error('db:saveMeshcoreMessage: status too long');
  const validReceivedVia = ['rf', 'mqtt', 'both'];
  if (m.received_via != null) {
    if (typeof m.received_via !== 'string' || m.received_via.length > 8)
      throw new Error('db:saveMeshcoreMessage: received_via invalid');
    if (!validReceivedVia.includes(m.received_via))
      throw new Error('db:saveMeshcoreMessage: received_via must be rf, mqtt, or both');
  }
  if (m.rx_packet_fingerprint != null) {
    if (
      typeof m.rx_packet_fingerprint !== 'string' ||
      !/^[0-9A-Fa-f]{8}$/.test(m.rx_packet_fingerprint)
    )
      throw new Error('db:saveMeshcoreMessage: rx_packet_fingerprint must be 8 hex chars');
  }
  validateMeshcoreMessageLocalOrder(m.local_order);
  if (m.rx_hops != null) {
    const h = Number(m.rx_hops);
    if (!Number.isInteger(h) || h < 0)
      throw new Error('db:saveMeshcoreMessage: rx_hops must be a non-negative integer');
  }
  if (m.room_server_id != null) {
    const rs = Number(m.room_server_id);
    if (!Number.isInteger(rs) || rs < 0)
      throw new Error('db:saveMeshcoreMessage: room_server_id must be a non-negative integer');
  }
  if (m.sender_id != null) {
    const rawSender = Number(m.sender_id);
    if (!Number.isFinite(rawSender))
      throw new Error('db:saveMeshcoreMessage: sender_id must be a finite number');
    m.sender_id = rawSender >>> 0;
  }
  if (m.to_node != null) {
    const rawTo = Number(m.to_node);
    if (!Number.isFinite(rawTo))
      throw new Error('db:saveMeshcoreMessage: to_node must be a finite number');
    m.to_node = rawTo >>> 0;
  }
  if (m.radio_node_id != null) {
    const radio = Number(m.radio_node_id);
    if (!Number.isSafeInteger(radio) || radio < 0)
      throw new Error('db:saveMeshcoreMessage: radio_node_id must be a non-negative integer');
  }
  if (m.channel_key != null && !isChannelIdentityKey(m.channel_key))
    throw new Error('db:saveMeshcoreMessage: channel_key must be a channel identity key');
}

export function validateSaveMeshcoreContact(contact: unknown): asserts contact is Record<
  string,
  unknown
> & {
  node_id: number;
  public_key: string;
} {
  if (!contact || typeof contact !== 'object')
    throw new Error('db:saveMeshcoreContact: contact must be an object');
  const c = contact as Record<string, unknown>;
  const nodeId = Number(c.node_id);
  if (!Number.isFinite(nodeId) || nodeId < 0)
    throw new Error('db:saveMeshcoreContact: node_id must be a finite non-negative number');
  if (typeof c.public_key !== 'string')
    throw new Error('db:saveMeshcoreContact: public_key must be a string');
  if (c.public_key.length > 128) throw new Error('db:saveMeshcoreContact: public_key too long');
  if (c.adv_name != null && typeof c.adv_name === 'string' && c.adv_name.length > MAX_NODE_STRING)
    throw new Error('db:saveMeshcoreContact: adv_name too long');
  if (c.nickname != null && typeof c.nickname === 'string' && c.nickname.length > MAX_NODE_STRING)
    throw new Error('db:saveMeshcoreContact: nickname too long');
  if (c.contact_flags != null) {
    const f = Number(c.contact_flags);
    if (!Number.isInteger(f) || f < 0 || f > 255)
      throw new Error('db:saveMeshcoreContact: contact_flags must be 0–255');
  }
  if (c.hops_away != null) {
    const h = Number(c.hops_away);
    if (!Number.isInteger(h) || h < 0)
      throw new Error('db:saveMeshcoreContact: hops_away must be a non-negative integer');
  }
  if (c.on_radio != null) {
    const o = Number(c.on_radio);
    if (o !== 0 && o !== 1) throw new Error('db:saveMeshcoreContact: on_radio must be 0 or 1');
  }
  if (
    c.last_synced_from_radio != null &&
    (typeof c.last_synced_from_radio !== 'string' || c.last_synced_from_radio.length > 128)
  ) {
    throw new Error('db:saveMeshcoreContact: last_synced_from_radio must be a string <= 128');
  }
}

export function meshcoreContactInputToUpsertParams(
  c: Record<string, unknown>,
): MeshcoreContactUpsertParams {
  const coords = sanitizeMeshcoreAdvLatLonForDb(
    c.adv_lat != null ? Number(c.adv_lat) : null,
    c.adv_lon != null ? Number(c.adv_lon) : null,
  );
  return {
    node_id: Number(c.node_id),
    public_key: c.public_key as string,
    adv_name: typeof c.adv_name === 'string' ? c.adv_name : null,
    contact_type: c.contact_type != null ? Number(c.contact_type) : 0,
    last_advert: sanitizeMeshcoreLastAdvertForDb(
      c.last_advert != null ? Number(c.last_advert) : null,
    ),
    adv_lat: coords.adv_lat,
    adv_lon: coords.adv_lon,
    last_snr: c.last_snr != null ? Number(c.last_snr) : null,
    last_rssi: c.last_rssi != null ? Number(c.last_rssi) : null,
    nickname: typeof c.nickname === 'string' ? c.nickname : null,
    contact_flags: c.contact_flags != null ? Number(c.contact_flags) : 0,
    hops_away: c.hops_away != null ? Number(c.hops_away) : null,
    on_radio: c.on_radio != null ? Number(c.on_radio) : null,
    last_synced_from_radio:
      typeof c.last_synced_from_radio === 'string' ? c.last_synced_from_radio : null,
  };
}

export function capStatusString(label: string, value: string | undefined | null): string | null {
  if (value == null) return null;
  if (value.length > MAX_STATUS_STRING)
    throw new Error(`${label} exceeds maximum length (${MAX_STATUS_STRING})`);
  return value;
}

export const DB_SAVE_NODE_PATH_MAX_BYTES = 16 * 1024;
