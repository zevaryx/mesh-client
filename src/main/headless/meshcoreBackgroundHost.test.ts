// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { NodeSqliteDB } from '../db-compat';
import { runSchemaUpgrade } from '../db-schema-sync';
import { meshcoreIncomingRow } from '../meshcore-backend/meshcoreBackground';
import { persistMeshcoreMessage } from '../meshcoreMessageChannel';
import { storedMeshcoreContactByPrefix } from './meshcoreBackgroundHost';

function db(): NodeSqliteDB {
  const d = new NodeSqliteDB(':memory:');
  runSchemaUpgrade(d);
  const insert = d.prepare(
    'INSERT INTO meshcore_contacts (node_id, public_key, adv_name, contact_type, nickname) ' +
      'VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(0xb0b, 'B0B1B2B3B4B5' + '00'.repeat(26), 'Bob', 1, null);
  insert.run(0xd00, 'd0d1d2d3d4d5' + '11'.repeat(26), 'Board', 3, ' Club board ');
  return d;
}

describe('MeshCore background storage (headless)', () => {
  it('resolves senders from stored contacts by public key prefix', () => {
    const d = db();
    expect(storedMeshcoreContactByPrefix(d, 'b0b1b2b3b4b5')).toEqual({
      nodeId: 0xb0b,
      name: 'Bob',
      contactType: 1,
    });
    // A nickname wins over the advertised name (what the renderer shows).
    expect(storedMeshcoreContactByPrefix(d, 'd0d1d2d3')).toMatchObject({
      nodeId: 0xd00,
      name: 'Club board',
      contactType: 3,
    });
    expect(storedMeshcoreContactByPrefix(d, '010203040506')).toBeNull();
    // Only hex reaches the LIKE pattern.
    expect(storedMeshcoreContactByPrefix(d, '%')).toBeNull();
    expect(storedMeshcoreContactByPrefix(null, 'b0b1')).toBeNull();
  });

  it('stores a pulled DM once (the same message pulled again is not duplicated)', () => {
    const d = db();
    const row = meshcoreIncomingRow(
      {
        sender_id: 0xb0b,
        sender_name: 'Bob',
        payload: 'hi there',
        channel: -1,
        timestamp: 1_700_000_000_000,
        status: 'acked',
        receivedVia: 'rf',
        to: 0x40302010,
      },
      0x40302010,
      1_700_000_000_000_000,
    );
    expect(persistMeshcoreMessage(d, row).changes).toBe(1);
    persistMeshcoreMessage(d, row);
    const stored = d
      .prepare(
        'SELECT sender_id, payload, channel_idx, to_node, radio_node_id FROM meshcore_messages',
      )
      .all();
    expect(stored).toEqual([
      {
        sender_id: 0xb0b,
        payload: 'hi there',
        channel_idx: -1,
        to_node: 0x40302010,
        radio_node_id: 0x40302010,
      },
    ]);
  });
});
