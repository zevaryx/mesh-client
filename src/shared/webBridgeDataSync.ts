/**
 * Shared viewing in the headless web UI: several browser tabs on one server, each running its own
 * renderer. Every tab decodes the same radio stream, so incoming traffic reaches all of them; what
 * one tab writes on its own (a message it sent, a delivery status, a delete, a favorite or note,
 * MeshCore contacts it fetched) does not. After such a write succeeds and changes rows, the server
 * tells the other tabs which data changed ({@link WEB_BRIDGE_DATA_CHANGED_EVENT}), and they reload
 * it from SQLite.
 *
 * Stream-derived writes every tab repeats (node saves, position / telemetry history, received-via
 * upgrades) are deliberately absent: announcing them would make every tab reload constantly for
 * data it already has.
 */
import type { MeshProtocol } from './meshProtocol';

export const WEB_BRIDGE_DATA_CHANGED_EVENT = 'headless:dataChanged';

export type WebBridgeDataKind = 'messages' | 'nodes';

export interface WebBridgeDataChange {
  protocol: MeshProtocol;
  kind: WebBridgeDataKind;
}

const CHANGE_BY_CHANNEL: Readonly<Record<string, WebBridgeDataChange>> = {
  'db:saveMessage': { protocol: 'meshtastic', kind: 'messages' },
  'db:updateMessageStatus': { protocol: 'meshtastic', kind: 'messages' },
  'db:updateMessagePacketId': { protocol: 'meshtastic', kind: 'messages' },
  'db:deleteFailedOutboundMessage': { protocol: 'meshtastic', kind: 'messages' },
  'db:clearMessages': { protocol: 'meshtastic', kind: 'messages' },
  'db:clearMessagesByChannel': { protocol: 'meshtastic', kind: 'messages' },
  'db:setNodeFavorited': { protocol: 'meshtastic', kind: 'nodes' },
  'db:setNodeNote': { protocol: 'meshtastic', kind: 'nodes' },
  'db:deleteNode': { protocol: 'meshtastic', kind: 'nodes' },
  'db:deleteNodesBatch': { protocol: 'meshtastic', kind: 'nodes' },
  'db:clearNodes': { protocol: 'meshtastic', kind: 'nodes' },

  'db:saveMeshcoreMessage': { protocol: 'meshcore', kind: 'messages' },
  'db:updateMeshcoreMessageStatus': { protocol: 'meshcore', kind: 'messages' },
  'db:updateMeshcoreMessageSender': { protocol: 'meshcore', kind: 'messages' },
  'db:clearMeshcoreMessages': { protocol: 'meshcore', kind: 'messages' },
  'db:clearMeshcoreMessagesByChannel': { protocol: 'meshcore', kind: 'messages' },
  // MeshCore contacts arrive as replies to the tab that asked, not on the shared stream.
  'db:saveMeshcoreContact': { protocol: 'meshcore', kind: 'nodes' },
  'db:saveMeshcoreContactsBatch': { protocol: 'meshcore', kind: 'nodes' },
  'db:deleteMeshcoreContact': { protocol: 'meshcore', kind: 'nodes' },
  'db:updateMeshcoreContactFavorited': { protocol: 'meshcore', kind: 'nodes' },
  'db:updateMeshcoreContactNickname': { protocol: 'meshcore', kind: 'nodes' },
  'db:updateMeshcoreContactType': { protocol: 'meshcore', kind: 'nodes' },
  'db:clearMeshcoreContacts': { protocol: 'meshcore', kind: 'nodes' },

  'db:saveReticulumMessage': { protocol: 'reticulum', kind: 'messages' },
  'db:deleteReticulumMessage': { protocol: 'reticulum', kind: 'messages' },
  'db:clearReticulumMessages': { protocol: 'reticulum', kind: 'messages' },
  'db:markStaleReticulumOutbound': { protocol: 'reticulum', kind: 'messages' },
};

/** What a successful invoke of `channel` changed for other tabs, or `null` (not announced). */
export function webBridgeDataChangeFor(channel: string): WebBridgeDataChange | null {
  return Object.hasOwn(CHANGE_BY_CHANNEL, channel) ? (CHANGE_BY_CHANNEL[channel] ?? null) : null;
}

/** False for a write result that reports zero changed rows (e.g. an ignored duplicate insert). */
export function webBridgeResultChangedRows(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('changes' in result)) return true;
  const changes = result.changes;
  return typeof changes !== 'number' || changes > 0;
}

export function isWebBridgeDataChange(value: unknown): value is WebBridgeDataChange {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.protocol === 'meshtastic' || v.protocol === 'meshcore' || v.protocol === 'reticulum') &&
    (v.kind === 'messages' || v.kind === 'nodes')
  );
}

/**
 * A radio link shared by every tab changed: one tab connected it (other disconnected tabs attach
 * to it) or a user disconnected it (other tabs drop it too, without reconnecting).
 */
export const WEB_BRIDGE_LINK_CHANGED_EVENT = 'headless:linkChanged';

export interface WebBridgeLinkChange {
  protocol: 'meshtastic' | 'meshcore';
  /** The server bridge: TCP (both protocols), Meshtastic HTTP polling, or a serial port. */
  transport: 'tcp' | 'http' | 'serial';
  state: 'connected' | 'disconnected';
  /** Set when `state` is `connected`. */
  host?: string;
  /** TCP: the port. */
  port?: number;
  /** HTTP: whether the radio is polled over HTTPS. */
  tls?: boolean;
  /** Serial: the server's port (`serial:list` port id). */
  portId?: string;
}

/**
 * `() => WebBridgeLinkChange[]`: the radio links the server has open now (all `connected`), so a
 * tab opened later (another browser, a cleared one) can join them.
 */
export const WEB_BRIDGE_LINK_STATE = 'headless:linkState';

export function isWebBridgeLinkChange(value: unknown): value is WebBridgeLinkChange {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.protocol !== 'meshtastic' && v.protocol !== 'meshcore') return false;
  if (v.transport !== 'tcp' && v.transport !== 'http' && v.transport !== 'serial') return false;
  if (v.state === 'disconnected') return true;
  if (v.transport === 'serial') {
    return v.state === 'connected' && typeof v.portId === 'string' && v.portId !== '';
  }
  if (v.state !== 'connected' || typeof v.host !== 'string' || v.host === '') return false;
  return v.transport === 'tcp'
    ? typeof v.port === 'number' && Number.isInteger(v.port)
    : typeof v.tls === 'boolean';
}
