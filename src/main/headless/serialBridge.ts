/**
 * Server-side serial for the headless web UI (`serial:*`, see `shared/webSerialBridge.ts`). The
 * browser's `navigator.serial` polyfill opens ports here; the renderer's Web Serial code runs
 * unchanged on top.
 *
 * Shared viewing: a port is opened once. Another tab opening the same port joins the open link
 * (its baud rate is ignored); every tab on the link gets the radio's bytes and can write. The port
 * closes when the last tab leaves it or disconnects. The protocol is not known up front: the first
 * write decides it. MeshCore frames start with `<`, and MeshCore has no request ids, so its
 * commands then go through {@link MeshcoreTcpMux} (one at a time, replies to the asking tab only,
 * pushes to all). Anything else (Meshtastic) passes through.
 *
 * Only ports the server lists can be opened, so a token holder cannot open arbitrary files.
 * Failure behavior: an open failure rejects to the caller; an unplugged device pushes
 * `serial:closed` to its tabs and drops the link; a write failure rejects to the writer.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  WEB_SERIAL_BAUD_RATES,
  WEB_SERIAL_CLOSE,
  WEB_SERIAL_CLOSED_EVENT,
  WEB_SERIAL_DATA_EVENT,
  WEB_SERIAL_LIST,
  WEB_SERIAL_OPEN,
  WEB_SERIAL_WRITE,
  type WebSerialOpenResult,
  type WebSerialPortListing,
} from '../../shared/webSerialBridge';
import { MeshcoreTcpMux } from '../ipc/meshcoreTcpMux';
import { errorMessageText, sanitizeLogMessage } from '../sanitize-log-message';
import { assertIpcSender } from '../validate-ipc-sender';
import type { SerialDevice } from './serialDevice';

/** Max bytes per `serial:write` (DoS guard; radio frames are far smaller). */
export const SERIAL_WRITE_MAX_BYTES = 64 * 1024;
const MESHCORE_FRAME_OUTGOING = 0x3c; // '<'

interface TabSender {
  id?: unknown;
  send: (channel: string, ...args: unknown[]) => void;
  once?: (name: 'destroyed', fn: () => void) => unknown;
}

interface SerialLink {
  id: number;
  portId: string;
  device: SerialDevice;
  members: Map<number, TabSender>;
  /** Set by the first write: `null` = pass through, else the MeshCore command serializer. */
  mux: MeshcoreTcpMux | null | undefined;
}

export interface SerialBridgeDeps {
  listPorts: () => WebSerialPortListing[];
  openDevice: (devicePath: string, baudRate: number) => Promise<SerialDevice>;
}

export interface SerialBridge {
  /** Close every open port (server shutdown). */
  closeAll: () => void;
}

function tabOf(event: IpcMainInvokeEvent): { sid: number; sender: TabSender } {
  const sender = event.sender as unknown as TabSender;
  if (typeof sender.id !== 'number') throw new Error('serial: unknown browser tab');
  return { sid: sender.id, sender };
}

export function registerSerialBridgeIpcHandlers(deps: SerialBridgeDeps): SerialBridge {
  const links = new Map<number, SerialLink>();
  const byPort = new Map<string, SerialLink>();
  /** Opens in flight, so two tabs opening one port at once share one device. */
  const opening = new Map<string, Promise<SerialLink>>();
  let nextLink = 1;

  const dropLink = (link: SerialLink): void => {
    links.delete(link.id);
    if (byPort.get(link.portId) === link) byPort.delete(link.portId);
    link.mux?.reset();
  };

  const leave = (link: SerialLink, sid: number): void => {
    if (!link.members.delete(sid)) return;
    link.mux?.sessionClosed(sid);
    if (link.members.size > 0) return;
    console.debug(`[serial] ${sanitizeLogMessage(link.portId)}: last tab left; closing`);
    dropLink(link);
    link.device.close();
  };

  const join = (link: SerialLink, sid: number, sender: TabSender): void => {
    if (link.members.has(sid)) return;
    link.members.set(sid, sender);
    sender.once?.('destroyed', () => {
      leave(link, sid);
    });
  };

  const deliver = (link: SerialLink, sid: number | null, bytes: Uint8Array): void => {
    if (sid !== null) {
      link.members.get(sid)?.send(WEB_SERIAL_DATA_EVENT, link.id, bytes);
      return;
    }
    for (const member of link.members.values()) member.send(WEB_SERIAL_DATA_EVENT, link.id, bytes);
  };

  const openLink = async (portId: string, baudRate: number): Promise<SerialLink> => {
    const device = await deps.openDevice(portId, baudRate);
    const link: SerialLink = {
      id: nextLink++,
      portId,
      device,
      members: new Map(),
      mux: undefined,
    };
    device.onData((bytes) => {
      if (link.mux) link.mux.fromRadio(bytes);
      else deliver(link, null, bytes);
    });
    device.onClose((reason) => {
      console.warn(`[serial] ${sanitizeLogMessage(portId)} closed: ${sanitizeLogMessage(reason)}`);
      dropLink(link);
      for (const member of link.members.values()) {
        member.send(WEB_SERIAL_CLOSED_EVENT, link.id, reason);
      }
      link.members.clear();
    });
    links.set(link.id, link);
    byPort.set(portId, link);
    console.debug(`[serial] opened ${sanitizeLogMessage(portId)} at ${baudRate} baud`);
    return link;
  };

  ipcMain.handle(WEB_SERIAL_LIST, (event) => {
    assertIpcSender(event, WEB_SERIAL_LIST);
    return deps.listPorts();
  });

  ipcMain.handle(
    WEB_SERIAL_OPEN,
    async (event, portId: unknown, baudRate: unknown): Promise<WebSerialOpenResult> => {
      assertIpcSender(event, WEB_SERIAL_OPEN);
      if (typeof portId !== 'string' || !deps.listPorts().some((p) => p.portId === portId)) {
        throw new Error('serial:open: unknown port');
      }
      if (typeof baudRate !== 'number' || !WEB_SERIAL_BAUD_RATES.includes(baudRate)) {
        throw new Error('serial:open: unsupported baud rate');
      }
      const { sid, sender } = tabOf(event);
      let link = byPort.get(portId);
      if (link) {
        console.debug(`[serial] tab ${sid} joined ${sanitizeLogMessage(portId)}`);
      } else {
        let pending = opening.get(portId);
        if (!pending) {
          pending = openLink(portId, baudRate).finally(() => {
            opening.delete(portId);
          });
          opening.set(portId, pending);
        }
        link = await pending;
      }
      join(link, sid, sender);
      return { link: link.id };
    },
  );

  ipcMain.handle(WEB_SERIAL_WRITE, async (event, linkId: unknown, bytes: unknown) => {
    assertIpcSender(event, WEB_SERIAL_WRITE);
    const { sid } = tabOf(event);
    const link = typeof linkId === 'number' ? links.get(linkId) : undefined;
    if (!link?.members.has(sid)) throw new Error('serial:write: port not open');
    if (!(bytes instanceof Uint8Array) || bytes.length > SERIAL_WRITE_MAX_BYTES) {
      throw new Error(`serial:write: invalid or oversized payload (max ${SERIAL_WRITE_MAX_BYTES})`);
    }
    if (bytes.length === 0) return;
    if (link.mux === undefined) {
      const meshcore = bytes[0] === MESHCORE_FRAME_OUTGOING;
      link.mux = meshcore
        ? new MeshcoreTcpMux({
            writeToRadio: (frame) => {
              link.device.write(frame).catch((err: unknown) => {
                console.warn('[serial] write failed:', sanitizeLogMessage(errorMessageText(err)));
              });
            },
            deliver: (target, frame) => {
              deliver(link, target, frame);
            },
          })
        : null;
    }
    if (link.mux) link.mux.fromSession(sid, bytes);
    else await link.device.write(bytes);
  });

  ipcMain.handle(WEB_SERIAL_CLOSE, (event, linkId: unknown) => {
    assertIpcSender(event, WEB_SERIAL_CLOSE);
    const { sid } = tabOf(event);
    const link = typeof linkId === 'number' ? links.get(linkId) : undefined;
    if (link) leave(link, sid);
  });

  return {
    closeAll: () => {
      for (const link of [...links.values()]) {
        dropLink(link);
        link.device.close();
      }
    },
  };
}
