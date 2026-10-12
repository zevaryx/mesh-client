// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { NodeInfoEvent } from '../../renderer/lib/protocols/Protocol';
import { MS_PER_HOUR, MS_PER_SECOND } from '../../shared/timeConstants';
import { recordsForNodeDbEntry } from './meshtasticBackendRecords';

const ME = 0x11111111;
const PEER = 0x22222222;
const NOW = 1_700_000_000_000;

function entry(fields: Partial<NodeInfoEvent> = {}): NodeInfoEvent {
  return { nodeId: PEER, ...fields };
}

describe('recordsForNodeDbEntry', () => {
  it('stores names, radio stats and position, with the radio seconds clock as ms', () => {
    const heardSec = NOW / MS_PER_SECOND - 60;
    const records = recordsForNodeDbEntry(
      entry({
        longName: ' Peer Base ',
        shortName: 'PEER',
        hwModel: 'RAK4631',
        role: 2,
        lastHeardAt: heardSec,
        snr: 6.5,
        hopsAway: 2,
        viaMqtt: true,
        latitude: 39.7,
        longitude: -105,
        altitude: 1600,
        batteryLevel: 80,
        voltage: 4.1,
        channelUtilization: 12,
        airUtilTx: 3,
      }),
      ME,
      NOW,
    );
    expect(records).toEqual([
      {
        kind: 'node',
        node: {
          node_id: PEER,
          source: 'rf',
          via_mqtt: true,
          long_name: 'Peer Base',
          short_name: 'PEER',
          hw_model: 'RAK4631',
          role: 2,
          last_heard: heardSec * MS_PER_SECOND,
          snr: 6.5,
          hops_away: 2,
          battery: 80,
          voltage: 4.1,
          channel_utilization: 12,
          air_util_tx: 3,
          latitude: 39.7,
          longitude: -105,
          altitude: 1600,
        },
      },
      {
        kind: 'position',
        nodeId: PEER,
        latitude: 39.7,
        longitude: -105,
        recordedAt: heardSec * MS_PER_SECOND,
      },
    ]);
  });

  it('drops the hop count of a stale node and clamps future last-heard to now', () => {
    const stale = recordsForNodeDbEntry(
      entry({ hopsAway: 1, lastHeardAt: (NOW - 3 * MS_PER_HOUR) / MS_PER_SECOND }),
      ME,
      NOW,
    );
    expect(stale[0]).toMatchObject({ kind: 'node', node: { node_id: PEER } });
    expect(stale[0]?.kind === 'node' && stale[0].node.hops_away).toBeUndefined();
    const future = recordsForNodeDbEntry(
      entry({ lastHeardAt: NOW / MS_PER_SECOND + 86_400 }),
      ME,
      NOW,
    );
    expect(future[0]?.kind === 'node' && future[0].node.last_heard).toBe(NOW);
  });

  it("leaves the connected radio's position to the renderer and pins its hops to 0", () => {
    const records = recordsForNodeDbEntry(
      entry({ nodeId: ME, latitude: 39.7, longitude: -105, lastHeardAt: NOW / MS_PER_SECOND }),
      ME,
      NOW,
    );
    expect(records).toHaveLength(1);
    const node = records[0]?.kind === 'node' ? records[0].node : null;
    expect(node?.latitude).toBeUndefined();
    expect(node?.hops_away).toBe(0);
  });

  it('skips invalid fixes and history points without a heard time', () => {
    expect(recordsForNodeDbEntry(entry({ latitude: 0, longitude: 0 }), ME, NOW)).toHaveLength(1);
    const unheard = recordsForNodeDbEntry(entry({ latitude: 39.7, longitude: -105 }), ME, NOW);
    expect(unheard.map((r) => r.kind)).toEqual(['node']);
  });
});
