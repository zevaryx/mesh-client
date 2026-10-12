/**
 * Browser side of headless file transfer (see `src/main/headless/fileTransfer.ts`).
 *
 * `headless:pickFiles` → open a file chooser, upload each file, then complete the request.
 * `headless:download`  → fetch the staged file once and save it through an object URL.
 *
 * The session token travels in an `Authorization` header, never in a URL. The chooser opens with
 * `showPicker()`, which needs a recent user gesture; the click that started the IPC call usually
 * still counts, and when the browser refuses, a small prompt supplies the gesture.
 *
 * Failure behavior: an upload error completes the request with `error`, so the server-side dialog
 * rejects and the app shows a failure instead of a silent cancel. Download errors are logged.
 */
import { MS_PER_MINUTE } from '../../shared/timeConstants';
import {
  sanitizeTransferFileName,
  WEB_BRIDGE_DOWNLOAD_EVENT,
  WEB_BRIDGE_FILES_PATH,
  WEB_BRIDGE_PICK_FILES_EVENT,
  type WebBridgeDownloadNotice,
  type WebBridgePickFilesCompletion,
  type WebBridgePickFilesRequest,
} from '../../shared/webBridgeProtocol';

type Listener = (event: unknown, ...args: unknown[]) => void;

export interface HeadlessFileTransferDeps {
  on: (channel: string, listener: Listener) => unknown;
  token: string | null;
  doc: Document;
  fetchFn: typeof fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

const PROMPT_ID = 'mesh-client-headless-file-prompt';

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isPickRequest(v: unknown): v is WebBridgePickFilesRequest {
  const r = v as Partial<WebBridgePickFilesRequest> | null;
  return (
    typeof r?.requestId === 'string' &&
    typeof r.multiple === 'boolean' &&
    typeof r.accept === 'string'
  );
}

function isDownloadNotice(v: unknown): v is WebBridgeDownloadNotice {
  const d = v as Partial<WebBridgeDownloadNotice> | null;
  return typeof d?.id === 'string' && typeof d.fileName === 'string';
}

/**
 * Prompt shown when the browser blocks a programmatic chooser: its button click is the user
 * gesture the chooser needs. Styled from the app's CSS variables (it lives outside React).
 */
function showPrompt(
  doc: Document,
  req: WebBridgePickFilesRequest,
  onChoose: () => void,
  onCancel: () => void,
): () => void {
  doc.getElementById(PROMPT_ID)?.remove();
  const box = doc.createElement('div');
  box.id = PROMPT_ID;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', req.title ?? 'Choose files');
  box.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.55);';
  const panel = doc.createElement('div');
  panel.style.cssText =
    'min-width:280px;max-width:90vw;padding:20px;border-radius:12px;' +
    'background:var(--color-ink-900,#111827);color:var(--color-ink-100,#e5e7eb);' +
    'font:14px/1.4 system-ui,sans-serif;box-shadow:var(--shadow-level-3,0 8px 24px rgba(0,0,0,.4));';
  const heading = doc.createElement('p');
  heading.textContent = req.title ?? (req.multiple ? 'Choose files' : 'Choose a file');
  heading.style.cssText = 'margin:0 0 16px;font-weight:600;';
  const actions = doc.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel file selection');
  cancel.style.cssText =
    'padding:8px 14px;border-radius:8px;border:1px solid var(--color-ink-600,#4b5563);' +
    'background:transparent;color:inherit;cursor:pointer;';
  const choose = doc.createElement('button');
  choose.type = 'button';
  choose.textContent = req.multiple ? 'Choose files…' : 'Choose file…';
  choose.setAttribute('aria-label', choose.textContent);
  choose.style.cssText =
    'padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-weight:600;' +
    'background:var(--color-brand-green,#67e8b4);color:var(--color-app-bg,#0b0f14);';
  const close = (): void => {
    box.remove();
  };
  cancel.addEventListener('click', () => {
    close();
    onCancel();
  });
  choose.addEventListener('click', () => {
    close();
    onChoose();
  });
  actions.append(cancel, choose);
  panel.append(heading, actions);
  box.append(panel);
  doc.body.append(box);
  choose.focus();
  return close;
}

/** Let the user pick files; `null` when they cancel. */
export function chooseFiles(doc: Document, req: WebBridgePickFilesRequest): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.multiple = req.multiple;
    if (req.accept) input.accept = req.accept;
    input.style.display = 'none';
    input.setAttribute('aria-hidden', 'true');
    doc.body.append(input);
    let settled = false;
    const finish = (files: File[] | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : [];
      finish(files.length > 0 ? files : null);
    });
    input.addEventListener('cancel', () => {
      finish(null);
    });
    try {
      input.showPicker();
    } catch (err) {
      // NotAllowedError: no user activation left. The prompt's click provides one.
      console.debug('[web-bridge] file chooser needs a gesture:', err);
      showPrompt(
        doc,
        req,
        () => {
          input.click();
        },
        () => {
          finish(null);
        },
      );
    }
  });
}

export function installHeadlessFileTransfer(deps: HeadlessFileTransferDeps): void {
  const { doc, fetchFn, token } = deps;

  const complete = async (requestId: string, body: WebBridgePickFilesCompletion): Promise<void> => {
    await fetchFn(`${WEB_BRIDGE_FILES_PATH}/complete/${requestId}`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const handlePick = async (req: WebBridgePickFilesRequest): Promise<void> => {
    const files = await chooseFiles(doc, req);
    if (!files) {
      await complete(req.requestId, { canceled: true });
      return;
    }
    try {
      for (const file of files) {
        const name = encodeURIComponent(sanitizeTransferFileName(file.name));
        const res = await fetchFn(`${WEB_BRIDGE_FILES_PATH}/upload/${req.requestId}?name=${name}`, {
          method: 'POST',
          headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(
            typeof detail?.error === 'string' ? detail.error : `upload failed (${res.status})`,
          );
        }
      }
      await complete(req.requestId, { canceled: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[web-bridge] file upload failed:', message);
      await complete(req.requestId, { canceled: true, error: message });
    }
  };

  const handleDownload = async (notice: WebBridgeDownloadNotice): Promise<void> => {
    const res = await fetchFn(`${WEB_BRIDGE_FILES_PATH}/download/${notice.id}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const url = deps.createObjectURL(await res.blob());
    const a = doc.createElement('a');
    a.href = url;
    a.download = sanitizeTransferFileName(notice.fileName, 'download');
    a.style.display = 'none';
    doc.body.append(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before releasing the blob.
    setTimeout(() => {
      deps.revokeObjectURL(url);
    }, MS_PER_MINUTE);
  };

  deps.on(WEB_BRIDGE_PICK_FILES_EVENT, (_event, payload) => {
    if (!isPickRequest(payload)) return;
    handlePick(payload).catch((err: unknown) => {
      console.error('[web-bridge] file pick failed:', err);
    });
  });
  deps.on(WEB_BRIDGE_DOWNLOAD_EVENT, (_event, payload) => {
    if (!isDownloadNotice(payload)) return;
    handleDownload(payload).catch((err: unknown) => {
      console.error('[web-bridge] download failed:', err);
    });
  });
}
