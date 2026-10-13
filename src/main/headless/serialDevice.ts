/**
 * One open serial device on the headless server: Node has no serial API, so the device file is
 * opened non-blocking, its line settings are set with `stty` (no shell; baud from a fixed list),
 * reads come through a `tty.ReadStream` (event driven, no thread-pool reads) and writes through
 * `fs.write`, one at a time.
 *
 * OS-specific: `stty -F` on Linux, `stty -f` on macOS (see `serialPorts.ts` for Windows). The
 * device is opened before `stty` runs and kept open, so the settings stay applied.
 *
 * Failure behavior: an open or `stty` failure closes the descriptor and rejects. A read error or
 * end of stream (device unplugged) closes the device and reports the reason once through
 * `onClose`. A write that keeps getting EAGAIN for {@link SERIAL_WRITE_RETRY_LIMIT} tries rejects.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import tty from 'node:tty';

import { MS_PER_SECOND } from '../../shared/timeConstants';
import { errorMessageText } from '../sanitize-log-message';

export const SERIAL_STTY_TIMEOUT_MS = 5 * MS_PER_SECOND;
export const SERIAL_WRITE_RETRY_LIMIT = 100;
const SERIAL_WRITE_RETRY_MS = 10;

export interface SerialDevice {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => void;
  onData: (listener: (bytes: Uint8Array) => void) => void;
  /** Once, when the device closes for any reason other than {@link close}. */
  onClose: (listener: (reason: string) => void) => void;
}

export function sttyArgs(
  platform: NodeJS.Platform,
  devicePath: string,
  baudRate: number,
): string[] {
  const deviceFlag = platform === 'darwin' ? '-f' : '-F';
  return [deviceFlag, devicePath, String(baudRate), 'raw', '-echo', '-echoe', '-echok', '-echoctl'];
}

function runStty(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('stty', args, { timeout: SERIAL_STTY_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`stty failed: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

function writeOnce(fd: number, bytes: Uint8Array, offset: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.write(fd, bytes, offset, bytes.length - offset, null, (err, written) => {
      if (err) reject(err);
      else resolve(written);
    });
  });
}

async function writeAll(fd: number, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  let retries = 0;
  while (offset < bytes.length) {
    try {
      offset += await writeOnce(fd, bytes, offset);
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code !== 'EAGAIN' ||
        ++retries > SERIAL_WRITE_RETRY_LIMIT
      ) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, SERIAL_WRITE_RETRY_MS));
    }
  }
}

export async function openSerialDevice(
  devicePath: string,
  baudRate: number,
  platform: NodeJS.Platform = process.platform,
): Promise<SerialDevice> {
  const { O_RDWR, O_NOCTTY, O_NONBLOCK } = fs.constants;
  const fd = await new Promise<number>((resolve, reject) => {
    fs.open(devicePath, O_RDWR | O_NOCTTY | O_NONBLOCK, (err, opened) => {
      if (err) reject(err);
      else resolve(opened);
    });
  });
  let stream: tty.ReadStream;
  try {
    await runStty(sttyArgs(platform, devicePath, baudRate));
    stream = new tty.ReadStream(fd);
  } catch (err) {
    fs.close(fd, (closeErr) => {
      if (closeErr) console.warn('[serial] close after failed open:', closeErr.code);
    });
    throw err;
  }
  // The stream owns the descriptor from here on; destroying it closes the device.
  let closed = false;
  let closeListener: ((reason: string) => void) | null = null;
  let writes: Promise<void> = Promise.resolve();
  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    stream.destroy();
    closeListener?.(reason);
  };
  stream.on('error', (err) => {
    finish(errorMessageText(err));
  });
  stream.on('end', () => {
    finish('device closed');
  });
  return {
    write: (bytes) => {
      const run = writes.then(() => {
        if (closed) throw new Error('serial device closed');
        return writeAll(fd, bytes);
      });
      writes = run.catch(() => undefined);
      return run;
    },
    close: () => {
      if (closed) return;
      closed = true;
      stream.destroy();
    },
    onData: (listener) => {
      stream.on('data', (chunk: Buffer) => {
        listener(new Uint8Array(chunk));
      });
    },
    onClose: (listener) => {
      closeListener = listener;
    },
  };
}
