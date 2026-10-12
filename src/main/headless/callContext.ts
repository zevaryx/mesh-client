/**
 * Per-invoke context for headless IPC.
 *
 * `webServer.ts` runs each bridge `invoke` inside {@link runInHeadlessCall}; code reached from that
 * handler (the shim's `dialog.showOpenDialog` / `showSaveDialog`) reads it back with
 * {@link currentHeadlessCall} to reach the browser session that made the call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface HeadlessFilePickOptions {
  title?: string;
  multiple: boolean;
  /** `accept` attribute for the browser file input (e.g. `.p12,.pem`), empty for any. */
  accept: string;
}

export interface HeadlessCallContext {
  sessionId: number;
  /** Ask this session's browser to pick and upload files; `null` when cancelled. */
  requestFiles: (opts: HeadlessFilePickOptions) => Promise<string[] | null>;
  /** Server path a handler writes to; delivered to the browser if the invoke succeeds. */
  stageDownload: (fileName: string) => string;
}

const storage = new AsyncLocalStorage<HeadlessCallContext>();

export function runInHeadlessCall<T>(ctx: HeadlessCallContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentHeadlessCall(): HeadlessCallContext | undefined {
  return storage.getStore();
}
