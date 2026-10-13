/**
 * Serial ports on the headless server, listed for the browser's port picker.
 *
 * OS-specific: Linux lists `/dev/serial/by-id/*` (stable across replug and reboot, so a saved port
 * still matches) plus any `ttyUSB*` / `ttyACM*` without a by-id link, with USB ids read from sysfs.
 * macOS lists `/dev/cu.*` (no USB ids). Windows COM ports cannot be opened as files, so the
 * headless server lists none there; Windows users run the desktop app for serial.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { WebSerialPortListing } from '../../shared/webSerialBridge';

/** The file system calls listing needs (tests pass a fake tree). */
export interface SerialPortFs {
  readdir: (dir: string) => string[];
  realpath: (p: string) => string;
  /** Trimmed file contents, or `null` when it cannot be read. */
  readText: (p: string) => string | null;
}

export const nodeSerialPortFs: SerialPortFs = {
  readdir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      // catch-no-log-ok a missing /dev/serial/by-id just means no USB serial device is plugged in
      return [];
    }
  },
  realpath: (p) => fs.realpathSync(p),
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      // catch-no-log-ok devices without sysfs USB ids (on-board UARTs) are listed without them
      return null;
    }
  },
};

const LINUX_BY_ID_DIR = '/dev/serial/by-id';
const LINUX_TTY_NAME = /^tty(?:USB|ACM)\d+$/;

const DARWIN_SKIPPED = new Set(['cu.Bluetooth-Incoming-Port', 'cu.debug-console']);
/** How far up from `/sys/class/tty/<name>/device` the USB device (with `idVendor`) can sit. */
const SYSFS_USB_SEARCH_DEPTH = 4;
const USB_ID = /^[0-9a-f]{4}$/i;

function linuxUsbIds(
  ttyName: string,
  fsx: SerialPortFs,
): Pick<WebSerialPortListing, 'vendorId' | 'productId'> {
  let dir: string;
  try {
    dir = fsx.realpath(`/sys/class/tty/${ttyName}/device`);
  } catch {
    // catch-no-log-ok not a sysfs-backed device (e.g. a pty): listed without USB ids
    return {};
  }
  for (let i = 0; i < SYSFS_USB_SEARCH_DEPTH && dir !== '/'; i++) {
    const vendor = fsx.readText(path.posix.join(dir, 'idVendor'));
    const product = fsx.readText(path.posix.join(dir, 'idProduct'));
    if (vendor && product && USB_ID.test(vendor) && USB_ID.test(product)) {
      return { vendorId: vendor.toLowerCase(), productId: product.toLowerCase() };
    }
    dir = path.posix.dirname(dir);
  }
  return {};
}

function listLinux(fsx: SerialPortFs): WebSerialPortListing[] {
  const ports: WebSerialPortListing[] = [];
  const covered = new Set<string>();
  for (const name of fsx.readdir(LINUX_BY_ID_DIR)) {
    const portId = path.posix.join(LINUX_BY_ID_DIR, name);
    let device: string;
    try {
      device = fsx.realpath(portId);
    } catch {
      // catch-no-log-ok a dangling by-id link (device unplugged while listing) is skipped
      continue;
    }
    const ttyName = path.posix.basename(device);
    covered.add(ttyName);
    ports.push({ portId, displayName: name, portName: ttyName, ...linuxUsbIds(ttyName, fsx) });
  }
  for (const name of fsx.readdir('/dev')) {
    if (!LINUX_TTY_NAME.test(name) || covered.has(name)) continue;
    ports.push({
      portId: `/dev/${name}`,
      displayName: name,
      portName: name,
      ...linuxUsbIds(name, fsx),
    });
  }
  return ports;
}

function listDarwin(fsx: SerialPortFs): WebSerialPortListing[] {
  return fsx
    .readdir('/dev')
    .filter((name) => name.startsWith('cu.') && !DARWIN_SKIPPED.has(name))
    .map((name) => ({ portId: `/dev/${name}`, displayName: name, portName: name }));
}

export function listSerialPorts(
  platform: NodeJS.Platform,
  fsx: SerialPortFs = nodeSerialPortFs,
): WebSerialPortListing[] {
  let ports: WebSerialPortListing[];
  if (platform === 'linux') ports = listLinux(fsx);
  else if (platform === 'darwin') ports = listDarwin(fsx);
  else ports = [];
  return ports.sort((a, b) => a.portId.localeCompare(b.portId));
}
