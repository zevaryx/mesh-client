// @vitest-environment node
/** Background-ingest persist sink against a real SQLite database (headless shim for `electron`). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPLY_PREVIEW_MAX_LEN } from '../../renderer/lib/replyPreview';

vi.mock('electron', async () => import('../headless/electronShim'));

const { configureHeadlessApp } = await import('../headless/electronShim');
const { closeDatabase, getDatabase, initDatabase } = await import('../database');
const { MESHTASTIC_REPLY_PREVIEW_MAX_LEN, createMeshtasticBackendPersist } =
  await import('./persist');
const { mainMeshtasticBackendPersistDb } = await import('./mainPersist');
const persistMeshtasticBackendRecord = createMeshtasticBackendPersist(
  mainMeshtasticBackendPersistDb(),
);

const ALICE = 0x22222222;
const BOB = 0x33333333;
const ME = 0x11111111;
const CAROL = 0x44444444;
const T0 = 1_700_000_000_000;

interface Row {
  payload: string;
  reply_preview_text: string | null;
  reply_preview_sender: string | null;
}

function message(fields: Record<string, unknown>): void {
  persistMeshtasticBackendRecord({
    kind: 'message',
    row: {
      sender_id: ALICE,
      sender_name: 'ALI',
      payload: 'x',
      channel: 0,
      timestamp: T0,
      receivedVia: 'rf',
      ...fields,
    } as never,
  });
}

function stored(packetId: number): Row | undefined {
  return getDatabase()
    .prepareOnce(
      'SELECT payload, reply_preview_text, reply_preview_sender FROM messages WHERE packet_id = ?',
    )
    .get(packetId) as Row | undefined;
}

let dataDir = '';

beforeAll(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-mt-backend-persist-'));
  configureHeadlessApp({ dataDir, version: '0.0.0-test' });
  initDatabase();
});

beforeEach(() => {
  getDatabase().prepareOnce('DELETE FROM messages').run();
  getDatabase().prepareOnce('DELETE FROM nodes').run();
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('persistMeshtasticBackendRecord reply previews', () => {
  it('matches the renderer preview length', () => {
    expect(MESHTASTIC_REPLY_PREVIEW_MAX_LEN).toBe(REPLY_PREVIEW_MAX_LEN);
  });

  it('stores the quoted parent text and sender, truncated like the renderer', () => {
    const long = 'p'.repeat(60);
    message({ sender_id: BOB, sender_name: 'Bob', packetId: 10, payload: long });
    message({ packetId: 11, payload: 'reply', replyId: 10, timestamp: T0 + 1000 });
    expect(stored(11)).toEqual({
      payload: 'reply',
      reply_preview_text: `${'p'.repeat(50)}…`,
      reply_preview_sender: 'Bob',
    });
  });

  it('prefers the parent in the same thread over a packet-id collision elsewhere', () => {
    message({
      sender_id: CAROL,
      sender_name: 'Carol',
      packetId: 20,
      payload: 'other channel',
      channel: 1,
    });
    message({ sender_id: ME, sender_name: 'Me', packetId: 20, payload: 'dm to alice', to: ALICE });
    message({ sender_id: BOB, sender_name: 'Bob', packetId: 20, payload: 'right one' });
    message({ packetId: 21, payload: 'reply', replyId: 20, timestamp: T0 + 1000 });
    expect(stored(21)?.reply_preview_text).toBe('right one');
  });

  it('matches a DM reply to its own conversation', () => {
    message({ sender_id: BOB, sender_name: 'Bob', packetId: 30, payload: 'channel post' });
    message({ sender_id: ME, sender_name: 'Me', packetId: 30, payload: 'dm', to: ALICE });
    message({ packetId: 31, payload: 'dm reply', replyId: 30, to: ME, timestamp: T0 + 1000 });
    expect(stored(31)?.reply_preview_text).toBe('dm');
  });

  it('never quotes a newer message and leaves unknown parents and tapbacks without a preview', () => {
    message({
      sender_id: BOB,
      sender_name: 'Bob',
      packetId: 40,
      payload: 'later',
      timestamp: T0 + 5000,
    });
    message({ packetId: 41, payload: 'reply', replyId: 40, timestamp: T0 + 1000 });
    message({ packetId: 42, payload: 'reply', replyId: 999, timestamp: T0 + 1000 });
    message({ sender_id: BOB, sender_name: 'Bob', packetId: 43, payload: 'parent' });
    message({ packetId: 44, payload: '👍', replyId: 43, emoji: 0x1f44d, timestamp: T0 + 1000 });
    for (const id of [41, 42, 44]) {
      expect(stored(id)).toMatchObject({ reply_preview_text: null, reply_preview_sender: null });
    }
  });
});

describe('persistMeshtasticBackendRecord transports', () => {
  const receivedVia = (packetId: number) =>
    (
      getDatabase()
        .prepareOnce('SELECT received_via FROM messages WHERE packet_id = ?')
        .all(packetId) as unknown as { received_via: string }[]
    ).map((r) => r.received_via);

  it.each([
    ['rf', 'mqtt'],
    ['mqtt', 'rf'],
  ] as const)('marks a %s row heard both ways when the %s copy arrives', (first, second) => {
    message({ packetId: 50, receivedVia: first });
    message({ packetId: 50, receivedVia: second });
    expect(receivedVia(50)).toEqual(['both']);
    message({ packetId: 50, receivedVia: second });
    expect(receivedVia(50)).toEqual(['both']);
  });

  it('keeps an RF-heard node as rf when MQTT reports it', () => {
    const node = (source: 'rf' | 'mqtt', viaMqtt: boolean) => {
      persistMeshtasticBackendRecord({
        kind: 'node',
        node: { node_id: ALICE, source, via_mqtt: viaMqtt, long_name: `Alice ${source}` },
      });
    };
    const stored = () =>
      getDatabase().prepareOnce('SELECT source, long_name FROM nodes WHERE node_id = ?').get(ALICE);
    node('mqtt', true);
    expect(stored()).toEqual({ source: 'mqtt', long_name: 'Alice mqtt' });
    node('rf', false);
    node('mqtt', true);
    expect(stored()).toEqual({ source: 'rf', long_name: 'Alice mqtt' });
  });
});
