// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSerialDevice, sttyArgs } from './serialDevice';

describe('sttyArgs', () => {
  // OS-specific: GNU stty names the device with -F, BSD (macOS) stty with -f.
  it.each([
    ['linux', '-F'],
    ['darwin', '-f'],
    ['win32', '-F'],
  ] as const)('sets raw mode and the baud rate (%s)', (platform, flag) => {
    expect(sttyArgs(platform, '/dev/ttyUSB0', 115200)).toEqual([
      flag,
      '/dev/ttyUSB0',
      '115200',
      'raw',
      '-echo',
      '-echoe',
      '-echok',
      '-echoctl',
    ]);
  });
});

describe('openSerialDevice', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('rejects for a missing device', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-serial-'));
    await expect(openSerialDevice(path.join(dir, 'ttyUSB9'), 115200)).rejects.toThrow(/ENOENT/);
  });

  it('rejects when the file is not a terminal (stty fails) and closes it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-serial-'));
    const file = path.join(dir, 'not-a-tty');
    fs.writeFileSync(file, '');
    // Open descriptors are countable on Linux only; elsewhere this checks the rejection.
    const countFds = (): number | null =>
      process.platform === 'linux' ? fs.readdirSync('/proc/self/fd').length : null;
    const before = countFds();
    await expect(openSerialDevice(file, 115200)).rejects.toThrow(/stty/);
    // The descriptor opened before stty ran is closed again.
    await new Promise((r) => setTimeout(r, 50));
    expect(countFds()).toBe(before);
  });
});
