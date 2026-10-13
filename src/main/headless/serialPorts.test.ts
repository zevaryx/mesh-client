// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { listSerialPorts, type SerialPortFs } from './serialPorts';

/** A fake file tree: directories list names; links resolve; files hold text. */
function fakeFs(tree: {
  dirs?: Record<string, string[]>;
  links?: Record<string, string>;
  files?: Record<string, string>;
}): SerialPortFs {
  return {
    readdir: (dir) => tree.dirs?.[dir] ?? [],
    realpath: (p) => {
      const target = tree.links?.[p];
      if (target === undefined) throw new Error(`ENOENT ${p}`);
      return target;
    },
    readText: (p) => tree.files?.[p] ?? null,
  };
}

const LINUX_TREE = fakeFs({
  dirs: {
    '/dev/serial/by-id': ['usb-Silicon_Labs_CP2102-if00-port0', 'usb-gone-if00'],
    '/dev': ['ttyUSB0', 'ttyACM0', 'tty1', 'ttyS0', 'null'],
  },
  links: {
    '/dev/serial/by-id/usb-Silicon_Labs_CP2102-if00-port0': '/dev/ttyUSB0',
    // ttyUSB0 is a usb-serial port device: the USB device sits two levels up.
    '/sys/class/tty/ttyUSB0/device': '/sys/devices/pci0/usb1/1-1/1-1:1.0/ttyUSB0',
    // ttyACM0 is a CDC interface: the USB device sits one level up.
    '/sys/class/tty/ttyACM0/device': '/sys/devices/pci0/usb1/1-2/1-2:1.0',
  },
  files: {
    '/sys/devices/pci0/usb1/1-1/idVendor': '10C4',
    '/sys/devices/pci0/usb1/1-1/idProduct': 'ea60',
    '/sys/devices/pci0/usb1/1-2/idVendor': '239a',
    '/sys/devices/pci0/usb1/1-2/idProduct': '8029',
  },
});

describe('listSerialPorts', () => {
  it('lists by-id links first, then unlinked USB ttys, with sysfs USB ids (linux)', () => {
    expect(listSerialPorts('linux', LINUX_TREE)).toEqual([
      {
        portId: '/dev/serial/by-id/usb-Silicon_Labs_CP2102-if00-port0',
        displayName: 'usb-Silicon_Labs_CP2102-if00-port0',
        portName: 'ttyUSB0',
        vendorId: '10c4',
        productId: 'ea60',
      },
      {
        portId: '/dev/ttyACM0',
        displayName: 'ttyACM0',
        portName: 'ttyACM0',
        vendorId: '239a',
        productId: '8029',
      },
    ]);
  });

  it('lists a tty without sysfs USB ids (pty, on-board UART) without them (linux)', () => {
    const fsx = fakeFs({ dirs: { '/dev': ['ttyUSB7'] } });
    expect(listSerialPorts('linux', fsx)).toEqual([
      { portId: '/dev/ttyUSB7', displayName: 'ttyUSB7', portName: 'ttyUSB7' },
    ]);
  });

  it('lists /dev/cu.* except the built-in Bluetooth and debug ports (darwin)', () => {
    const fsx = fakeFs({
      dirs: {
        '/dev': [
          'cu.usbserial-0001',
          'tty.usbserial-0001',
          'cu.Bluetooth-Incoming-Port',
          'cu.debug-console',
        ],
      },
    });
    expect(listSerialPorts('darwin', fsx)).toEqual([
      {
        portId: '/dev/cu.usbserial-0001',
        displayName: 'cu.usbserial-0001',
        portName: 'cu.usbserial-0001',
      },
    ]);
  });

  // OS-specific: COM ports cannot be opened as files, so the headless server lists none on Windows.
  it('lists nothing on win32', () => {
    expect(listSerialPorts('win32', LINUX_TREE)).toEqual([]);
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'returns an empty list with no devices (%s)',
    (platform) => {
      expect(listSerialPorts(platform, fakeFs({}))).toEqual([]);
    },
  );
});
