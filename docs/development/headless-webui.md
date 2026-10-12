# Headless web UI (Docker)

Run Mesh Client as a server and use it from a browser: the React renderer is served over HTTP and talks to a Node process (no Electron) through a WebSocket. The goal is an always-on gateway image (`docker run … mesh-client-web`) for TCP/HTTP radios, MQTT and Reticulum.

> **Status: early.** The bridge, server, build and image are in place. The app shell loads in the browser and reads and writes its SQLite database (nodes, messages, contacts, outbox, Reticulum/RRC tables), app settings and encrypted secret storage. Meshtastic/MeshCore over TCP, Meshtastic over HTTP and MQTT (both stacks) work; so do TAK, GPS and the release check. so does Reticulum over network interfaces. BLE and serial on the server do not yet (see [Porting status](#porting-status)).

## Architecture

```text
browser                                   headless server (Node 22, no Electron)
───────                                   ──────────────────────────────────────
dist/renderer (unchanged Vite build)      dist-headless/server.js
  └─ window.electronAPI                     ├─ HTTP: static renderer, /web-bridge.js, /healthz
       = src/preload/index.ts               ├─ WS /ipc (token + same-origin check)
         bundled with electron →            │    invoke/send → HeadlessIpcRegistry
         src/preload/web/                   │    webContents.send → broadcast to sessions
         electronRendererShim.ts  ◄── WS ──►└─ main-process handler modules, bundled with
                                                 electron → src/main/headless/electronShim.ts
```

The trick on both sides is the same: **alias the `electron` module at bundle time** so existing code runs unchanged.

- **Browser:** `src/preload/index.ts` only uses `contextBridge` and `ipcRenderer`. `scripts/build-headless.mjs` bundles it as an IIFE (`web-bridge.js`) with `electron` → `electronRendererShim.ts`, so the browser gets the exact same `window.electronAPI` as the desktop app. The server injects `<script src="/web-bridge.js">` ahead of the app module in `index.html`, so `devElectronApiStub` never installs.
- **Server:** handler modules keep calling `ipcMain.handle(...)` and `getMainWindow()?.webContents.send(...)`. In the headless bundle `ipcMain` is backed by `HeadlessIpcRegistry`, and the one `BrowserWindow` broadcasts to every bridge session. The shim exports only what ported modules use: importing anything else **fails the headless build** with "No matching export", so a module is never silently stubbed.

### Wire protocol

`src/shared/webBridgeProtocol.ts`: JSON frames (`invoke` / `send` from the browser; `result` / `error` / `event` from the server). Values JSON cannot carry are tagged: `Uint8Array` / `Buffer` / typed arrays (decoded as `Uint8Array`, as with Electron IPC), `ArrayBuffer`, `Date`, `Map`, `Set`, `bigint`, and `undefined` inside arrays. Invoke rejections use Electron's text (`Error invoking remote method '<channel>': Error: <message>`) so renderer error matching keeps working.

### Security model

- **Token:** `MESH_CLIENT_WEB_TOKEN` (min 16 chars) or a random token generated per start and printed once as `http://…/?token=…`. The bridge stores it in `localStorage` and strips it from the address bar; it rides on the WebSocket URL (`/ipc?token=`), compared in constant time.
- **Origin:** browser upgrades must have `Origin` matching `Host`. Behind a reverse proxy, forward `Host` unchanged.
- **Sender validation is kept:** authenticated sessions get a synthetic event with `senderFrame.url = mesh-client://headless-web/`, and the shim reports `app.isPackaged === true`, so `assertIpcSender` applies its packaged-build rules unchanged.
- No TLS in the server itself; put it behind a TLS reverse proxy for anything beyond a trusted LAN. `MESH_CLIENT_WEB_AUTH=off` disables the token for isolated networks only.
- **Network reach:** the radio bridges (`*:tcp-connect`, `http:connect`, `hostLink:probe*`) make the **server** open connections to hosts the browser names, after the same hostname validation as the desktop app. A token holder can therefore reach hosts on the server's network (radios, but also anything else listening). Treat the token like SSH access to that network; restrict egress with Docker networking if that matters.
- Responses carry `Referrer-Policy: no-referrer` (the first URL holds the token), `X-Frame-Options: DENY`, `nosniff`. The renderer CSP is unchanged; `'self'` already allows `/web-bridge.js` and the same-origin WebSocket.

## Build and run

```bash
pnpm run build:headless # vite build + dist-headless/{server,web-bridge}.js
pnpm run start:headless # http://127.0.0.1:8080/?token=… printed in the log

docker build -t mesh-client-web .
# key material for saved credentials (MeshCore identity, MQTT passwords); keep it safe
head -c 32 /dev/urandom | base64 > mesh-secret.key
docker run --rm -p 8080:8080 -v mesh-client-data:/data \
  -v "$PWD/mesh-secret.key:/run/secrets/mesh-secret.key:ro" \
  -e MESH_CLIENT_SECRET_KEY_FILE=/run/secrets/mesh-secret.key mesh-client-web
```

The server bundle is self-contained (`HEADLESS_SERVER_EXTERNALS = []`), so the runtime image holds only Node, `dist/renderer` and `dist-headless/`. The image runs as `node`, keeps state in the `/data` volume and has a `/healthz` health check. Behind a Docker Hub rate limit or mirror: `--build-arg NODE_IMAGE=mirror.gcr.io/library/node`.

| Variable                            | Default                     | Meaning                                                                             |
| ----------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `MESH_CLIENT_DATA_DIR`              | `./mesh-client-data`        | Stands in for Electron `userData` (`/data` in the image)                            |
| `MESH_CLIENT_WEB_HOST`              | `127.0.0.1`                 | Bind address (`0.0.0.0` in the image)                                               |
| `MESH_CLIENT_WEB_PORT`              | `8080`                      | HTTP + WebSocket port                                                               |
| `MESH_CLIENT_WEB_TOKEN`             | random per start            | Session token (min 16 chars)                                                        |
| `MESH_CLIENT_WEB_AUTH`              | `token`                     | `off` disables auth (isolated networks only)                                        |
| `MESH_CLIENT_RENDERER_DIR`          | `<bundle>/../dist/renderer` | Vite renderer build                                                                 |
| `MESH_CLIENT_SECRET_KEY_FILE`       | unset                       | File with key material (min 16 chars) for stored secrets; use a Docker secret       |
| `MESH_CLIENT_SECRET_KEY`            | unset                       | Same, inline; visible in `docker inspect`, so prefer the file                       |
| `MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE` | unset                       | `1` allows an irreversible database schema upgrade at start (back up `/data` first) |
| `MESH_CLIENT_WEB_MAX_UPLOAD_MB`     | `64`                        | Max total upload per browser file pick (1–1024 MiB)                                 |

## File transfer

Handlers keep calling `dialog.showOpenDialog` / `showSaveDialog`; the shim routes them to the browser that made the IPC call (`headless/callContext.ts` tracks the calling session with `AsyncLocalStorage`, `headless/fileTransfer.ts` serves the bytes, `preload/web/headlessFileTransfer.ts` is the browser side):

- **Open:** the server pushes `headless:pickFiles`; the browser opens a file chooser (filters become the input's `accept`), uploads each file with `POST /files/upload/<id>?name=…`, then `POST /files/complete/<id>`. The handler gets staged server paths with the original base names. Cancel resolves `canceled: true`; an upload error rejects the dialog so the app shows a failure.
- **Save:** the handler gets a staged path to write. When its invoke **succeeds** the server pushes `headless:download` and the browser fetches `GET /files/download/<id>` once and saves it under the handler's file name. A failed invoke discards the file.
- **Gesture:** the chooser opens with `showPicker()`, which needs recent user activation; the click that started the call normally still counts. If the browser refuses, a small prompt appears and its button supplies the gesture.
- **Folder pickers** (Nomad pages folder, rncp receive folder) choose persistent server locations and reject with "folder pickers are not available in headless mode".

Security and lifetime: endpoints require the session token as `Authorization: Bearer` (never in a URL); ids are 128-bit random and one-shot; uploads are capped per pick (`MESH_CLIENT_WEB_MAX_UPLOAD_MB`), written with mode 600 into `mkdtemp` directories under the OS temp dir, kept for the browser session (a picked "file to send" is used by a later call, at most 1 h) and deleted when the session closes; undelivered downloads expire after 10 min.

Known quirk: a handler that returns the saved path (e.g. blocklist export) reports the server staging path, which some UI may display.

## Porting a handler module

1. Make the module take narrow dependencies instead of Electron objects, e.g. `RendererPushTarget` (`src/main/rendererPushTarget.ts`) instead of `BrowserWindow`, and move helpers that live in `index.ts` into their own module (as `validateHttpHost` moved to `httpHostValidation.ts`).
2. Register it from `registerHeadlessHandlers()` in `src/main/headless/index.ts`, alongside the existing Electron registration in `src/main/index.ts`.
3. Run `node scripts/build-headless.mjs`. A "No matching export" error names the Electron API the module needs: add a deliberate headless implementation to `electronShim.ts` (with a test), or keep that path out of headless.
4. Add a test that drives the module through the registry on the shim (pattern: `src/main/headless/headlessTcpBridge.test.ts`).

Electron APIs and their headless meaning, for the shim:

| Electron                                           | Headless                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.getPath`                                      | Under `MESH_CLIENT_DATA_DIR` (`logs/`, `exports/`)                                                                                                                                                                                                                        |
| `ipcMain`                                          | `HeadlessIpcRegistry`                                                                                                                                                                                                                                                     |
| `webContents.send`                                 | Broadcast to all bridge sessions                                                                                                                                                                                                                                          |
| `dialog`                                           | Message prompts throw (callers treat that as "declined"; schema upgrade refused unless `MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE=1`); error boxes go to the log. **File dialogs are served by the calling browser** (see [File transfer](#file-transfer)); folder pickers reject |
| `safeStorage`                                      | `headlessSafeStorage.ts`: AES-256-GCM, scrypt-derived key from `MESH_CLIENT_SECRET_KEY(_FILE)`. Without a key, encryption is reported unavailable and `SecureSecretStore` keeps secrets in memory only. Weaker than an OS keyring                                         |
| `net.isOnline`                                     | Always `true`; a real outage surfaces as the fetch failure callers already classify as offline                                                                                                                                                                            |
| `shell.openExternal`, `shell.showItemInFolder`     | Reject / throw: the server cannot act on the viewer's desktop                                                                                                                                                                                                             |
| `BrowserWindow.fromWebContents`                    | The one headless window                                                                                                                                                                                                                                                   |
| tray, power events, spellcheck, `electron-updater` | Not applicable. `electron-updater` is aliased to a module that throws on load, so `updater.ts` falls back to the GitHub release check                                                                                                                                     |

## Porting status

| Area                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge, server, build, Docker image                                                                                                                                          | Done                                                                                                                                                                                                                                                                                                                                                                        |
| Meshtastic / MeshCore TCP (`*:tcp-*`)                                                                                                                                        | Done (`ipc/tcp-bridge.ts`)                                                                                                                                                                                                                                                                                                                                                  |
| Boot gate: `secureSecrets:*`, `appSettings:*`, database                                                                                                                      | Done (`ipc/secure-secrets-handlers.ts`, `ipc/app-settings-handlers.ts`, moved out of `index.ts`)                                                                                                                                                                                                                                                                            |
| SQLite `db:*` and `chat:outbox:*`                                                                                                                                            | Done: `ipc/db-meshtastic-handlers.ts`, `ipc/db-meshcore-handlers.ts`, `ipc/chat-outbox-handlers.ts` (validators in `ipc/db-ipc-validation.ts`), moved verbatim out of `index.ts`; the existing `reticulum-db`, `rrc-db` and `environment-telemetry` modules also register headless                                                                                          |
| File dialogs: `db:export` / `db:import`, log + support-bundle export, chat / MECP / GPX export, Reticulum attachment save, XMODEM pick / save, MeshCore contacts JSON import | Done: `ipc/file-dialog-handlers.ts` (moved out of `index.ts`), served by the calling browser ([File transfer](#file-transfer)). Already-shared modules (TAK certificates, Reticulum identity / config / blocklist / rncp file) use the same path; folder pickers reject                                                                                                     |
| TAK server + remote relay (`tak:*`)                                                                                                                                          | Done: lifecycle in `tak/tak-server-host.ts` (moved out of `index.ts`), handlers in `ipc/tak-handlers.ts`; auto-start restored at boot. Publish the TAK port (default 8089) to reach it. Certificate import needs browser upload                                                                                                                                             |
| GPS (`gps:getFix`)                                                                                                                                                           | Done: the **server's** location (OS / IP geolocation), which is the station position for a gateway                                                                                                                                                                                                                                                                          |
| Updates (`update:*`)                                                                                                                                                         | Release check only (`initUpdater(..., { releaseCheckOnly: true })`): reports new versions; update by pulling a new image                                                                                                                                                                                                                                                    |
| `app:rendererHeartbeat`, service announcements                                                                                                                               | Done (heartbeat accepted and dropped: Electron's hang watchdog has no browser equivalent)                                                                                                                                                                                                                                                                                   |
| Reticulum (`reticulum:*`, identities)                                                                                                                                        | Done: the image builds the sidecar like release CI (`rns-stack,rns-ble,rns-rnode-tcp`, Ratspeak stack cloned at the reviewed pins) into `/app/resources/reticulum-sidecar/`, found through `app.getAppPath()`. TCP/UDP/RNode-over-TCP interfaces work; BLE RNode / LoRa GATT need host BlueZ and are not wired headless. Identity / config file pickers need browser upload |
| Meshtastic HTTP (`http:*`, `hostLink:*`)                                                                                                                                     | Pending (handlers inline in `index.ts`)                                                                                                                                                                                                                                                                                                                                     |
| MQTT (`mqtt:*`, Meshtastic + MeshCore)                                                                                                                                       | Done (`ipc/mqtt-handlers.ts`, moved out of `index.ts`; headless owns its own client instances and disconnects them on shutdown). MQTT → TAK node forwarding waits on TAK                                                                                                                                                                                                    |
| BLE (`gatt*`)                                                                                                                                                                | Linux hosts only (host D-Bus/BlueZ passthrough); pending                                                                                                                                                                                                                                                                                                                    |
| Serial                                                                                                                                                                       | Web Serial in the viewer's Chromium browser; server-side serial would be a new bridge                                                                                                                                                                                                                                                                                       |

Open design questions: several tabs share one backend and radio (all see every push and can send); exports and attachments that pass server file paths need upload/download flows.

`getPlatform()` reports the **server's** OS (`linux` / `darwin` / `win32`, other Unix-likes as `linux`), matching what the Electron app reports for the machine its main process runs on. The server injects `<meta name="mesh-client-host-platform">` into `index.html`; the bridge reads it into a global that `process.platform` compiles to in `web-bridge.js`.

## Key files

- `src/shared/webBridgeProtocol.ts`: frames and value codec
- `src/preload/web/electronRendererShim.ts`: browser `ipcRenderer` / `contextBridge`
- `src/main/headless/`: `index.ts` (entry), `config.ts` (env), `webServer.ts` (HTTP/WS), `ipcRegistry.ts`, `electronShim.ts`
- `scripts/build-headless.mjs`: server + bridge bundles
- `Dockerfile`, `.dockerignore`
