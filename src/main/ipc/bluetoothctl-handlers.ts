/**
 * Linux Bluetooth pairing helpers through `bluetoothctl` (`bluetooth-*`): scan, pair with the
 * radio PIN, trust, connect, untrust, unpair, info. Used by the ConnectionPanel re-pair flow on
 * Linux; other platforms report bluetoothctl as missing. Shared by the Electron main process and
 * the headless server (which needs `bluetoothctl` and the host's BlueZ over D-Bus). Moved verbatim
 * out of `index.ts`; channel name literals keep check:ipc-contract aligned.
 */
import { spawn } from 'child_process';
import { ipcMain } from 'electron';

import {
  formatMeshtasticBluetoothPin,
  parseMeshtasticBluetoothPin,
} from '../../shared/meshtasticBluetoothPin';
import { formatBluetoothctlSpawnError } from '../bluetoothctlSpawnError';
import { errorMessageText, sanitizeLogMessage } from '../sanitize-log-message';
import { assertIpcSender } from '../validate-ipc-sender';

/** MAC address format: XX:XX:XX:XX:XX:XX */
function isMacAddress(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 6) return false;
  return parts.every((part) => /^[0-9A-Fa-f]{2}$/.test(part));
}

export function registerBluetoothctlIpcHandlers(): void {
  // ─── IPC: Unpair Bluetooth device (Linux only — bluetoothctl remove) ──
  // Not used on routine disconnect; only ConnectionPanel manual re-pair flow.
  ipcMain.handle('bluetooth-unpair', async (event, macAddress: unknown) => {
    assertIpcSender(event, 'bluetooth-unpair');
    if (typeof macAddress !== 'string') {
      throw new Error('bluetooth-unpair: macAddress must be a string');
    }
    // Validate MAC format (XX:XX:XX:XX:XX:XX)
    if (!isMacAddress(macAddress)) {
      throw new Error('bluetooth-unpair: invalid MAC address format');
    }

    console.debug('[IPC] bluetooth-unpair:', macAddress);

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bluetoothctl', ['remove', macAddress]);
      let settled = false;
      let stderr = '';
      let stdout = '';

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill();
          reject(new Error('bluetooth-unpair: timed out after 5 s'));
        }
      }, 5_000);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          console.error('[IPC] bluetooth-unpair failed:', sanitizeLogMessage(stderr));
          reject(new Error(sanitizeLogMessage(stderr) || 'Failed to unpair device'));
          return;
        }
        console.debug('[IPC] bluetooth-unpair success:', sanitizeLogMessage(stdout.trim()));
        resolve();
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = formatBluetoothctlSpawnError(err);
        console.error('[IPC] bluetooth-unpair error:', sanitizeLogMessage(msg));
        reject(new Error(msg));
      });
    });
  });

  // ─── IPC: Start BLE scan (Linux) ─────────────────────────────────────
  const BLUETOOTH_START_SCAN_TIMEOUT_MS = 15_000;
  const BLUETOOTH_STOP_SCAN_TIMEOUT_MS = 5_000;
  const BLUETOOTH_GET_INFO_TIMEOUT_MS = 5_000;

  ipcMain.handle('bluetooth-start-scan', async (event) => {
    assertIpcSender(event, 'bluetooth-start-scan');
    console.debug('[IPC] bluetooth-start-scan');
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bluetoothctl', ['scan', 'on']);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill();
          reject(new Error('bluetooth-start-scan: timed out after 15 s'));
        }
      }, BLUETOOTH_START_SCAN_TIMEOUT_MS);

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          console.debug('[IPC] bluetooth-start-scan success');
          resolve();
        } else {
          console.warn('[IPC] bluetooth-start-scan failed with code', code);
          reject(new Error(`scan on failed with code ${code}`));
        }
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const msg = formatBluetoothctlSpawnError(err);
        console.warn('[IPC] bluetooth-start-scan error:', sanitizeLogMessage(msg));
        reject(new Error(msg));
      });
    });
  });

  // ─── IPC: Stop BLE scan (Linux) ──────────────────────────────────────
  ipcMain.handle('bluetooth-stop-scan', async (event) => {
    assertIpcSender(event, 'bluetooth-stop-scan');
    console.debug('[IPC] bluetooth-stop-scan');
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        console.warn('[IPC] bluetooth-stop-scan: timed out after 5 s, killing process');
        proc.kill();
        finish(); // Don't reject - stop scan failure is not critical
      }, BLUETOOTH_STOP_SCAN_TIMEOUT_MS);
      const proc = spawn('bluetoothctl', ['scan', 'off']);
      proc.on('close', () => {
        console.debug('[IPC] bluetooth-stop-scan done');
        finish();
      });
      proc.on('error', (err) => {
        console.warn(
          '[IPC] bluetooth-stop-scan error:',
          sanitizeLogMessage(err?.message ?? String(err)),
        );
        finish(); // Don't reject - stop scan failure is not critical
      });
    });
  });

  // ─── IPC: Pair Bluetooth device (Linux) ───────────────────────────────
  ipcMain.handle('bluetooth-pair', async (event, macAddress: unknown, pin: unknown) => {
    assertIpcSender(event, 'bluetooth-pair');
    if (typeof macAddress !== 'string') {
      throw new Error('bluetooth-pair: macAddress must be a string');
    }
    if (!isMacAddress(macAddress)) {
      throw new Error('bluetooth-pair: invalid MAC address format');
    }
    let normalizedPin: string | undefined;
    if (typeof pin === 'number' && Number.isInteger(pin) && pin >= 0 && pin <= 999999) {
      normalizedPin = formatMeshtasticBluetoothPin(pin);
    } else if (typeof pin === 'string' && pin.trim().length > 0) {
      const parsed = parseMeshtasticBluetoothPin(pin.trim());
      if (parsed === null) throw new Error('bluetooth-pair: pin must be exactly 6 digits');
      normalizedPin = formatMeshtasticBluetoothPin(parsed);
    } else if (typeof pin !== 'undefined' && pin !== null) {
      throw new Error('bluetooth-pair: pin must be a 6-digit number');
    }
    console.debug('[IPC] bluetooth-pair:', macAddress);
    return new Promise<void>((resolve, reject) => {
      const pairTimeoutMs = 45000;
      let settled = false;
      const trustDeviceBestEffort = (): Promise<void> =>
        new Promise((resolveTrust) => {
          const trustProc = spawn('bluetoothctl', ['trust', macAddress]);
          trustProc.stdout.on('data', () => {
            // drain
          });
          trustProc.stderr.on('data', () => {
            // drain
          });
          trustProc.on('close', () => {
            resolveTrust();
          });
          trustProc.on('error', () => {
            resolveTrust();
          });
        });

      const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let stdout = '';
      let pinSubmitted = false;
      let confirmSubmitted = false;
      let pairRequested = false;
      let agentReady = false;
      let targetDiscovered = false;
      const finishReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pairTimeout);
        reject(err);
      };
      const finishResolve = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pairTimeout);
        resolve();
      };
      const pairTimeout = setTimeout(() => {
        try {
          proc.stdin.write('scan off\n');
        } catch {
          // catch-no-log-ok -- best-effort cleanup during timeout
        }
        try {
          proc.stdin.write('quit\n');
        } catch {
          // catch-no-log-ok -- best-effort cleanup during timeout
        }
        try {
          proc.kill('SIGTERM');
        } catch {
          // catch-no-log-ok -- best-effort cleanup during timeout
        }
        finishReject(new Error('Bluetooth pairing timed out; please retry'));
      }, pairTimeoutMs);
      const requestPair = (): void => {
        if (pairRequested) return;
        if (!agentReady || !targetDiscovered) return;
        pairRequested = true;
        proc.stdin.write(`pair ${macAddress}\n`);
      };
      const processPairingChunk = (chunk: string): void => {
        const chunkLower = chunk.toLowerCase();
        if (
          normalizedPin &&
          !pinSubmitted &&
          (chunkLower.includes('pin code') ||
            chunkLower.includes('request pin') ||
            chunkLower.includes('enter passkey') ||
            chunkLower.includes('passkey (number in 0-999999)') ||
            chunkLower.includes('enter pass key'))
        ) {
          pinSubmitted = true;
          proc.stdin.write(`${normalizedPin}\n`);
        }
        if (
          !confirmSubmitted &&
          (chunkLower.includes('confirm passkey') ||
            chunkLower.includes('[agent] confirm') ||
            chunkLower.includes('authorize service'))
        ) {
          confirmSubmitted = true;
          proc.stdin.write('yes\n');
        }
        if (chunkLower.includes('pairing successful') || chunkLower.includes('failed to pair')) {
          proc.stdin.write('scan off\n');
          proc.stdin.write('quit\n');
        }
      };
      proc.stdin.write('agent KeyboardOnly\n');
      proc.stdin.write('default-agent\n');
      proc.stdin.write('scan on\n');
      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        const chunkLower = chunk.toLowerCase();
        if (
          !agentReady &&
          (chunkLower.includes('default agent request successful') ||
            chunkLower.includes('agent is already registered'))
        ) {
          agentReady = true;
          requestPair();
        }
        if (!pairRequested) {
          const discoveredTarget =
            chunk.includes(macAddress) &&
            (chunk.includes('Device') || chunk.includes('[NEW]') || chunk.includes('[CHG]'));
          if (discoveredTarget) {
            targetDiscovered = true;
            requestPair();
          }
        }
        if (chunk.includes('not available')) {
          if (!pairRequested) {
            requestPair();
            return;
          }
          finishReject(new Error('Pairing failed: device not available. Re-scan and retry.'));
          return;
        }
        processPairingChunk(chunk);
      });
      proc.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        processPairingChunk(chunk);
      });
      proc.on('close', (code) => {
        if (settled) return;
        const pairingFailedByOutput =
          stdout.includes('Failed to pair') ||
          stdout.includes('AuthenticationCanceled') ||
          stderr.includes('Failed to pair') ||
          stderr.includes('AuthenticationCanceled');
        const pairingSucceededByOutput = stdout.includes('Pairing successful');
        if (!pairingFailedByOutput && (pairingSucceededByOutput || code === 0)) {
          void trustDeviceBestEffort()
            .then(() => {
              if (settled) return;
              console.debug('[IPC] bluetooth-pair success');
              finishResolve();
            })
            .catch((e: unknown) => {
              // trustDeviceBestEffort is best-effort and should not reject; finish pairing anyway.
              console.debug(
                '[IPC] bluetooth-pair trust settle:',
                sanitizeLogMessage(errorMessageText(e)),
              );
              if (settled) return;
              finishResolve();
            });
        } else {
          console.warn(
            '[IPC] bluetooth-pair failed:',
            sanitizeLogMessage(stderr.trim() || `code ${code}`),
          );
          finishReject(
            new Error(
              sanitizeLogMessage(
                stderr.trim() ||
                  (pairingFailedByOutput ? 'pair failed (bluetoothctl reported failure)' : '') ||
                  `pair failed with code ${code}`,
              ),
            ),
          );
        }
      });
      proc.on('error', (err) => {
        if (settled) return;
        console.warn(
          '[IPC] bluetooth-pair error:',
          sanitizeLogMessage(formatBluetoothctlSpawnError(err)),
        );
        finishReject(new Error(formatBluetoothctlSpawnError(err)));
      });
    });
  });

  // ─── IPC: Connect Bluetooth device (Linux) ────────────────────────────
  ipcMain.handle('bluetooth-connect', async (event, macAddress: unknown) => {
    assertIpcSender(event, 'bluetooth-connect');
    if (typeof macAddress !== 'string') {
      throw new Error('bluetooth-connect: macAddress must be a string');
    }
    if (!isMacAddress(macAddress)) {
      throw new Error('bluetooth-connect: invalid MAC address format');
    }
    console.debug('[IPC] bluetooth-connect:', macAddress);
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('bluetoothctl', ['connect', macAddress]);
      let stderr = '';
      proc.stdout.on('data', () => {
        // drain
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) {
          console.debug('[IPC] bluetooth-connect success');
          resolve();
        } else {
          console.warn(
            '[IPC] bluetooth-connect failed:',
            sanitizeLogMessage(stderr.trim() || `code ${code}`),
          );
          reject(
            new Error(sanitizeLogMessage(stderr.trim() || `connect failed with code ${code}`)),
          );
        }
      });
      proc.on('error', (err) => {
        const msg = formatBluetoothctlSpawnError(err);
        console.warn('[IPC] bluetooth-connect error:', sanitizeLogMessage(msg));
        reject(new Error(msg));
      });
    });
  });

  // ─── IPC: Untrust Bluetooth device (Linux) ────────────────────────────
  // This is best-effort - failures are ignored
  ipcMain.handle('bluetooth-untrust', async (event, macAddress: unknown) => {
    assertIpcSender(event, 'bluetooth-untrust');
    if (typeof macAddress !== 'string') {
      throw new Error('bluetooth-untrust: macAddress must be a string');
    }
    if (!isMacAddress(macAddress)) {
      throw new Error('bluetooth-untrust: invalid MAC address format');
    }
    console.debug('[IPC] bluetooth-untrust:', macAddress);
    return new Promise<void>((resolve) => {
      const proc = spawn('bluetoothctl', ['untrust', macAddress]);
      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('close', (code) => {
        // Ignore failure - untrust is best-effort, but log for debugging
        if (code !== 0) {
          console.debug(
            '[IPC] bluetooth-untrust exited with code',
            code,
            'stderr:',
            stderr.trim() || '(none)',
          );
        } else {
          console.debug('[IPC] bluetooth-untrust done');
        }
        resolve();
      });
      proc.on('error', (err) => {
        // Ignore error - untrust is best-effort, but log for debugging
        console.debug(
          '[IPC] bluetooth-untrust error:',
          sanitizeLogMessage(err?.message ?? String(err)),
        );
        resolve();
      });
    });
  });

  ipcMain.handle('bluetooth-get-info', async (event, macAddress: unknown) => {
    assertIpcSender(event, 'bluetooth-get-info');
    if (typeof macAddress !== 'string') {
      throw new Error('bluetooth-get-info: macAddress must be a string');
    }
    if (!isMacAddress(macAddress)) {
      throw new Error('bluetooth-get-info: invalid MAC address format');
    }
    return new Promise<string>((resolve) => {
      let settled = false;
      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        console.warn('[IPC] bluetooth-get-info: timed out after 5 s, killing process');
        proc.kill();
        finish('bluetooth-get-info: timed out after 5 s');
      }, BLUETOOTH_GET_INFO_TIMEOUT_MS);
      const proc = spawn('bluetoothctl', ['info', macAddress]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      proc.on('close', (code) => {
        const output = (stdout.trim() || stderr.trim() || `code ${code}`).slice(-2000);
        finish(output);
      });
      proc.on('error', (err) => {
        const msg = formatBluetoothctlSpawnError(err);
        finish(msg);
      });
    });
  });
}
