// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  // A real terminal (Python's pty pair): libuv reopens it for the read stream, so closing must
  // also release the descriptor openSerialDevice opened (it once kept the device held open).
  const canMakePty =
    process.platform === 'linux' && spawnSync('python3', ['-c', 'import pty']).status === 0;
  it.runIf(canMakePty)('reads, writes and releases every descriptor on close (pty)', async () => {
    const helper = spawn('python3', [
      '-u',
      '-c',
      [
        'import os, pty, sys, select',
        'm, s = pty.openpty()',
        'print(os.ttyname(s), flush=True)',
        'os.write(m, b"hello")',
        'while True:',
        '    r, _, _ = select.select([m, sys.stdin], [], [])',
        '    if sys.stdin in r and not sys.stdin.read(1): break',
        '    if m in r: sys.stdout.write("got:" + os.read(m, 64).hex() + chr(10)); sys.stdout.flush()',
      ].join('\n'),
    ]);
    try {
      const out: string[] = [];
      helper.stdout.on('data', (d: Buffer) => out.push(...String(d).trim().split('\n')));
      await vi.waitFor(() => {
        expect(out[0]).toMatch(/^\/dev\/pts\//);
      });
      const ptsPath = out[0] ?? '';
      const holding = (): number =>
        fs.readdirSync('/proc/self/fd').filter((f) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${f}`) === ptsPath;
          } catch {
            // catch-no-log-ok a descriptor closed while listing
            return false;
          }
        }).length;
      const device = await openSerialDevice(ptsPath, 115200);
      const received: number[] = [];
      device.onData((bytes) => received.push(...bytes));
      await vi.waitFor(() => {
        expect(Buffer.from(received).toString()).toBe('hello');
      });
      await device.write(new Uint8Array([0x94, 0xc3]));
      await vi.waitFor(() => {
        expect(out).toContain('got:94c3');
      });
      expect(holding()).toBeGreaterThan(0);
      device.close();
      await vi.waitFor(() => {
        expect(holding()).toBe(0);
      });
    } finally {
      helper.stdin.end();
      helper.kill();
    }
  });
});
