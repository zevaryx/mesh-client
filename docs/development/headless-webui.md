# Headless web UI (Docker)

Run Mesh Client as a server and use it from a browser: the React renderer is served over HTTP and talks to a Node process (no Electron) through a WebSocket. The goal is an always-on gateway image (`docker run … mesh-client-web`) for TCP/HTTP radios, MQTT and Reticulum.

> **Status: early.** The bridge, server, build and image are in place. The app shell loads in the browser and reads and writes its SQLite database (nodes, messages, contacts, outbox, Reticulum/RRC tables), app settings and encrypted secret storage. Meshtastic/MeshCore over TCP, Meshtastic over HTTP and MQTT (both stacks) work; so do TAK, GPS, the release check and Reticulum over network interfaces. USB serial radios plugged into the server work through a `navigator.serial` polyfill ([Serial ports](#serial-ports)); Bluetooth radios work on Linux hosts that pass their BlueZ through ([Bluetooth](#bluetooth)).

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

### Reconnect catch-up

Server pushes (`webContents.send`) that happen while a browser's WebSocket is down are lost. When an established connection drops, the bridge raises a local `power:suspend`; once it reconnects, and after it has sent the calls queued during the outage, it raises `power:resume`. The renderer's sleep/wake recovery (`usePowerRecovery`) handles both, as after a laptop wake: MQTT is bounced, Meshtastic and MeshCore reconnect from their saved parameters, and Reticulum re-attaches to the running sidecar (`reuseIfRunning`), each re-pushing current state. Failed retries within one outage raise nothing more, and the first connect raises nothing. This also covers a server restart. The cost is a radio reconnect after any browser network blip, which is the price of not losing pushes.

### Security model

- **Token:** `MESH_CLIENT_WEB_TOKEN_FILE` (a Docker secret), `MESH_CLIENT_WEB_TOKEN` (min 16 chars), or a random token generated per start and printed once as `http://…/?token=…`. The bridge stores it in `localStorage` and strips it from the address bar; it rides on the WebSocket URL (`/ipc?token=`), compared in constant time. **Rotating:** change the file (or variable) and restart; open tabs then need the new `?token=` link.
- **Bad tokens:** a client that sends 20 wrong tokens within a minute is refused (HTTP 429) for 5 minutes, before its token is even checked (`authThrottle.ts`). The limit sits above what a tab left open across a token change produces, so that tab never locks its own client out. Clients are keyed by remote address; behind a reverse proxy every browser shares the proxy's address unless `MESH_CLIENT_WEB_TRUST_PROXY=on` keys on `X-Forwarded-For`. Only turn that on when the proxy is the only way in, since clients can set that header themselves.
- **Sessions:** at most `MESH_CLIENT_WEB_MAX_SESSIONS` tabs (default 16) are connected at once; more upgrades get 503.
- **Origin:** browser upgrades must have `Origin` matching `Host`. Behind a reverse proxy, forward `Host` unchanged.
- **Sender validation is kept:** authenticated sessions get a synthetic event with `senderFrame.url = mesh-client://headless-web/`, and the shim reports `app.isPackaged === true`, so `assertIpcSender` applies its packaged-build rules unchanged.
- No TLS in the server itself; put it behind a TLS reverse proxy for anything beyond a trusted LAN (see [Reverse proxy](#reverse-proxy)).
- **`MESH_CLIENT_WEB_AUTH=off`** disables the token for isolated networks only. Without a token, a website someone on that network visits could reach the server through DNS rebinding (its own domain re-resolved to the server). So with auth off the server only answers requests whose `Host` is an IP address, `localhost`, or a name listed in `MESH_CLIENT_WEB_ALLOWED_HOSTS`; others get 421.
- **Network reach:** the radio bridges (`*:tcp-connect`, `http:connect`, `hostLink:probe*`) make the **server** open connections to hosts the browser names, after the same hostname validation as the desktop app. A token holder can therefore reach hosts on the server's network (radios, but also anything else listening). Treat the token like SSH access to that network; restrict egress with Docker networking if that matters.
- **Map tiles:** `/tiles` needs the tile cookie described in [Map tiles](#map-tiles); its value is derived from the token, not the token.
- Responses carry `Referrer-Policy: no-referrer` (the first URL holds the token), `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (the renderer's own CSP is a `<meta>` tag, which cannot set that), and `nosniff`. The renderer CSP is unchanged; `'self'` already allows `/web-bridge.js` and the same-origin WebSocket.
- **Untrusted frames:** a bridge frame that cannot be decoded (malformed tag, nesting deep enough to overflow the stack) is dropped and logged; the session stays open. A `__proto__` key stays a plain field.

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

**Open it from a secure context.** Browsers keep some APIs to HTTPS pages and `localhost`. Over plain HTTP by LAN address or host name the bridge fills in `crypto.randomUUID` (used when connecting) and logs a warning, but `crypto.subtle` cannot be replaced: MeshCore channel decryption and key checks, some Reticulum and translation features, notifications and the clipboard do not work there. From another machine use an HTTPS reverse proxy ([Reverse proxy](#reverse-proxy)) or an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 server`, then `http://localhost:8080`).

For a local test, `compose.yaml` builds the image and serves it on `127.0.0.1:8080` (token and key from a `.env` file, with throwaway defaults); `docker compose --profile fake-radios up --build` adds the fake Meshtastic and MeshCore radios at `127.0.0.1:4403` and `127.0.0.1:5000` (the server's own loopback). Bluetooth and serial passthrough are there, commented out. `--profile https` adds nginx on port 8443 with a self-signed certificate (`docker/nginx/`), created on first start for the names in `MESH_CLIENT_TLS_NAMES` (`DNS:<name>` / `IP:<address>`, comma-separated; default `localhost` and `127.0.0.1`) and kept in a volume; accept the browser's warning once, or trust the certificate (`docker compose cp https:/etc/nginx/tls/mesh-client.crt .`).

The server bundle is self-contained (`HEADLESS_SERVER_EXTERNALS = []`), so the runtime image holds only Node, `dist/renderer` and `dist-headless/`. The image runs as `node`, keeps state in the `/data` volume and has a `/healthz` health check. Behind a Docker Hub rate limit or mirror: `--build-arg NODE_IMAGE=mirror.gcr.io/library/node`.

| Variable                            | Default                     | Meaning                                                                                            |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `MESH_CLIENT_DATA_DIR`              | `./mesh-client-data`        | Stands in for Electron `userData` (`/data` in the image)                                           |
| `MESH_CLIENT_WEB_HOST`              | `127.0.0.1`                 | Bind address (`0.0.0.0` in the image)                                                              |
| `MESH_CLIENT_WEB_PORT`              | `8080`                      | HTTP + WebSocket port                                                                              |
| `MESH_CLIENT_WEB_TOKEN`             | random per start            | Session token (min 16 chars)                                                                       |
| `MESH_CLIENT_WEB_TOKEN_FILE`        | unset                       | File holding the token (Docker secret); wins over `MESH_CLIENT_WEB_TOKEN`                          |
| `MESH_CLIENT_WEB_MAX_SESSIONS`      | `16`                        | Browser tabs connected at once (1–256)                                                             |
| `MESH_CLIENT_WEB_TRUST_PROXY`       | `off`                       | `on` keys the bad-token lockout on `X-Forwarded-For` (only behind a proxy that is the only way in) |
| `MESH_CLIENT_WEB_ALLOWED_HOSTS`     | unset                       | With auth off: comma-separated host names served besides IP addresses and `localhost`              |
| `MESH_CLIENT_WEB_AUTH`              | `token`                     | `off` disables auth (isolated networks only)                                                       |
| `MESH_CLIENT_RENDERER_DIR`          | `<bundle>/../dist/renderer` | Vite renderer build                                                                                |
| `MESH_CLIENT_SECRET_KEY_FILE`       | unset                       | File with key material (min 16 chars) for stored secrets; use a Docker secret                      |
| `MESH_CLIENT_SECRET_KEY`            | unset                       | Same, inline; visible in `docker inspect`, so prefer the file                                      |
| `MESH_CLIENT_ACCEPT_SCHEMA_UPGRADE` | unset                       | `1` allows an irreversible database schema upgrade at start (back up `/data` first)                |
| `MESH_CLIENT_WEB_MAX_UPLOAD_MB`     | `64`                        | Max total upload per browser file pick (1–1024 MiB)                                                |
| `MESH_CLIENT_MESHTASTIC_BACKEND`    | `on`                        | `off` stops [storing Meshtastic chat while no tab owns the radio](#background-ingest-meshtastic)   |

### Reverse proxy

The server speaks plain HTTP. For TLS, put a reverse proxy in front that forwards the WebSocket upgrade on `/ipc`, keeps `Host` unchanged (the `Origin` check compares against it) and sets `X-Forwarded-Proto` (the tile cookie is then marked `Secure`). Keep the server on loopback or a private Docker network so the proxy is the only way in.

Caddy (gets a certificate automatically; WebSockets and `Host` work by default):

```text
mesh.example.org {
  reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
server {
  listen 443 ssl;
  server_name mesh.example.org;
  ssl_certificate     /etc/ssl/mesh.crt;
  ssl_certificate_key /etc/ssl/mesh.key;
  client_max_body_size 64m;          # match MESH_CLIENT_WEB_MAX_UPLOAD_MB

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;  # keeps a non-default port, which the Origin check needs
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;           # the bridge WebSocket stays open
  }
}
```

`compose.yaml`'s `https` profile runs this setup with a self-signed certificate (`docker/nginx/mesh-client.conf`). With the proxy as the only way in, set `MESH_CLIENT_WEB_TRUST_PROXY=on` so the bad-token lockout applies per browser instead of to the proxy.

## Background ingest (Meshtastic)

Protocol handling runs in the renderer, so with no browser tab open the server only forwards radio bytes to nobody. For **Meshtastic over TCP, HTTP or BLE** the server now stores what arrives while no tab is decoding:

- **What it stores:** chat text and DMs; live node identity (`NODEINFO_APP`: names, hardware, role, public key); peer positions plus a position-history point after a 10 m move; battery, environment readings and the connected radio's own stats from telemetry. On links the backend opened itself (the link keeper, below) it also stores the radio's NodeDB from the config dump: names, SNR, hops (dropped when older than 2 h), position, battery and radio stats. Replies get the parent's quote and sender stored with them (`reply_preview_*`), found in SQLite by packet id with the renderer's thread rules (`findMeshtasticReplyParent`). Records are defined in `meshtastic-backend/meshtasticBackendRecords.ts`, which mirrors the renderer's paths in `meshtasticNodeSideEffects.ts`.
- **How:** `src/main/meshtastic-backend/` taps what the main process already receives: the TCP socket's byte stream (`TcpBridgeTap` in `ipc/tcp-bridge.ts`, framed with the `@meshtastic/core` framer), each HTTP `fromradio` poll (`ipc/http-bridge.ts`), and each BLE FromRadio forwarded from the sidecar (`gattTap.ts`). Only the most recently opened link feeds the ingest (`createMeshtasticLinkTaps`). It decodes them with the renderer's own decoders (`lib/protocols/meshtasticTextDecode.ts`, `meshtasticNodeDecode.ts`). Writes go through the same SQL as the renderer's IPC (`insertMeshtasticMessageRow`, `upsertMeshtasticNodeRow`, `insertPositionHistoryRow`, `insertEnvironmentTelemetryOn`) in `persist.ts`, which also applies the renderer's rules: blocked senders are dropped, last-heard only moves forward, node patches never wipe stored fields, and an identical environment reading within 60 s is skipped. Sender names, channel keys and the radio's node id come from the config dump the radio sent when the tab connected. It sends the renderer's 60 s heartbeat on TCP (framed) and BLE (raw ToRadio) so the radio keeps the client; HTTP needs none.
- **MQTT (headless):** the Meshtastic MQTT client runs in the server and stays connected when the last tab closes. While no tab is open, its chat and node updates are stored too (`mqttRecords.ts`, fed from `ipc/mqtt-handlers.ts`): chat as `received_via = 'mqtt'` on the radio's channel identity when a radio link is up, nodes with `via_mqtt` (a node the radio heard stays `source = 'rf'`), positions and environment readings tagged `mqtt`. A message already stored from the other transport (same sender and packet id) is marked `both` instead of stored twice, in either order. The renderer's in-memory content dedup (copies with different packet ids) is not mirrored. The MQTT connection itself is still started by a tab (`mqtt:connect`); after a server restart it stays down until a tab connects it.
- **Who owns persistence:** only renderers open sockets, so a socket opened while a tab is connected belongs to that tab. When the last tab leaves the backend takes over, and it keeps storing until a connected tab opens the socket again (a fresh page is not decoding until its runtime reconnects). That reconnect hands ownership back and pushes `meshtastic:backend-caught-up`; the runtime reloads messages and nodes, and the position and environment history stores reload from SQLite. Chat rows are deduplicated by the `(sender_id, packet_id)` unique index, so overlap with the renderer never duplicates.
- **Reconnecting the radio:** when a tab connects over TCP or HTTP the main process saves that target (`app_settings` key `meshtasticBackgroundLink`, not writable over IPC); an explicit Disconnect clears it. With no tab present and the link down, the link keeper (`linkKeeper.ts`) opens it again through the same bridges, 15 s after start (a tab or window may connect first) and after drops with a 5 s to 60 s backoff. Links it opens are the backend's: it sends `want_config` (the radio only streams after a config request) and keeps storing until a tab's own connect replaces the socket. BLE is not reopened: that needs the sidecar's pairing and coexistence flow, which stays renderer-driven.
- **Hosts:** in-process here (`inProcessHost.ts`); on desktop an Electron `utilityProcess` (`utilityHost.ts`, worker bundle `meshtastic-backend.js`), opt-in with `MESH_CLIENT_MESHTASTIC_BACKEND=on`; the desktop host code ships as a separate `meshtastic-backend-host.js` loaded only then (`desktopHostLoader.ts`), with main-process singletons injected (link opening, and the database and SQL helpers the sink in `persist.ts` uses, `mainPersist.ts`), covering a closed window (macOS), a crashed renderer or a reload. In `pnpm run dev`, run `pnpm run build:main` once so the worker bundle exists.
- **Needs a tab:**
  - Reopening BLE (the sidecar's pairing and coexistence flow stays renderer-driven).
  - Storing from serial and MeshCore links. With no tab open they stay connected (a returning tab joins them) but nothing is stored, and a server restart does not reopen them; only Meshtastic TCP and HTTP links are reopened and stored.
  - Node renumbering and the MeshCore-BLE ghost-node filter.
  - **TAK chat relay** in both directions. Its bridge settings live in the browser's storage, and relaying to the mesh sends through the tab's radio connection. Meshtastic MQTT node positions still reach TAK without a tab.
  - **Store & Forward history.** A tab requests it from the router when it connects, which fills gaps from while no link was up. Replays only arrive after such a request.
  - **MeshCore waiting-message drain.** It needs a full MeshCore companion session in main. The radio keeps queued messages until a tab drains them, and Reticulum buffers the last 200 in the sidecar, so both survive short gaps.

## File transfer

Handlers keep calling `dialog.showOpenDialog` / `showSaveDialog`; the shim routes them to the browser that made the IPC call (`headless/callContext.ts` tracks the calling session with `AsyncLocalStorage`, `headless/fileTransfer.ts` serves the bytes, `preload/web/headlessFileTransfer.ts` is the browser side):

- **Open:** the server pushes `headless:pickFiles`; the browser opens a file chooser (filters become the input's `accept`), uploads each file with `POST /files/upload/<id>?name=…`, then `POST /files/complete/<id>`. The handler gets staged server paths with the original base names. Cancel resolves `canceled: true`; an upload error rejects the dialog so the app shows a failure.
- **Save:** the handler gets a staged path to write. When its invoke **succeeds** the server pushes `headless:download` and the browser fetches `GET /files/download/<id>` once and saves it under the handler's file name. A failed invoke discards the file.
- **Gesture:** the chooser opens with `showPicker()`, which needs recent user activation; the click that started the call normally still counts. If the browser refuses, a small prompt appears and its button supplies the gesture.
- **Folder pickers** (Nomad pages folder, rncp receive folder) choose persistent server locations and reject with "folder pickers are not available in headless mode".

Security and lifetime: endpoints require the session token as `Authorization: Bearer` (never in a URL); ids are 128-bit random and one-shot; uploads are capped per pick (`MESH_CLIENT_WEB_MAX_UPLOAD_MB`), written with mode 600 into `mkdtemp` directories under the OS temp dir, kept for the browser session (a picked "file to send" is used by a later call, at most 1 h) and deleted when the session closes; undelivered downloads expire after 10 min.

Known quirk: a handler that returns the saved path (e.g. blocklist export) reports the server staging path, which some UI may display.

## Map tiles

The desktop app serves map tiles on its own `mesh-tiles:` scheme from a disk cache (`offline-maps/protocol.ts`): a cached tile, else one fetched from the basemap and cached. A browser cannot load that scheme, so the server runs the same handler and cache (`<data dir>/tile-cache`) at `GET /tiles/<basemap>/<z>/<x>/<y>.png`, and the renderer rewrites its tile URLs there when `hostKind === 'web'` (`hostMeshTilesUrl` in `renderer/lib/hostKind.ts`). Region downloads (`offline-maps:*`) run on the server and fill that cache, so every tab and the server's own clients share it.

Map images cannot send an `Authorization` header. At startup the bridge posts the token to `POST /session/tiles` (Bearer header) and gets an `HttpOnly; SameSite=Strict; Path=/tiles` cookie (`Secure` when reached over HTTPS or behind a proxy sending `X-Forwarded-Proto: https`). Its value is an HMAC of the token, so it grants tiles only and cannot open a bridge session. Without it `/tiles` answers 401: otherwise anyone who can reach the port could use the server as a tile proxy or learn which areas are cached. Tile responses are `Cache-Control: private`.

## Porting a handler module

1. Make the module take narrow dependencies instead of Electron objects, e.g. `RendererPushTarget` (`src/main/rendererPushTarget.ts`) instead of `BrowserWindow`, and move helpers that live in `index.ts` into their own module (as `validateHttpHost` moved to `httpHostValidation.ts`).
2. Register it from `registerHeadlessHandlers()` in `src/main/headless/index.ts`, alongside the existing Electron registration in `src/main/index.ts`.
3. Run `node scripts/build-headless.mjs`. A "No matching export" error names the Electron API the module needs: add a deliberate headless implementation to `electronShim.ts` (with a test), or keep that path out of headless.
4. Add a test that drives the module through the registry on the shim (pattern: `src/main/headless/headlessTcpBridge.test.ts`).
5. Remove the module's channels from `HEADLESS_PENDING_CHANNELS` in `src/main/headless/headlessChannelCoverage.test.ts`. That guard fails when a preload channel has no headless handler and is not listed as pending, so a new desktop-only channel cannot silently break browser tabs.

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

| Area                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge, server, build, Docker image                                                                                                                                          | Done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Meshtastic / MeshCore TCP (`*:tcp-*`)                                                                                                                                        | Done (`ipc/tcp-bridge.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Boot gate: `secureSecrets:*`, `appSettings:*`, database                                                                                                                      | Done (`ipc/secure-secrets-handlers.ts`, `ipc/app-settings-handlers.ts`, moved out of `index.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SQLite `db:*` and `chat:outbox:*`                                                                                                                                            | Done: `ipc/db-meshtastic-handlers.ts`, `ipc/db-meshcore-handlers.ts`, `ipc/chat-outbox-handlers.ts` (validators in `ipc/db-ipc-validation.ts`), moved verbatim out of `index.ts`; the existing `reticulum-db`, `rrc-db` and `environment-telemetry` modules also register headless                                                                                                                                                                                                                                                                                                      |
| File dialogs: `db:export` / `db:import`, log + support-bundle export, chat / MECP / GPX export, Reticulum attachment save, XMODEM pick / save, MeshCore contacts JSON import | Done: `ipc/file-dialog-handlers.ts` (moved out of `index.ts`), served by the calling browser ([File transfer](#file-transfer)). Already-shared modules (TAK certificates, Reticulum identity / config / blocklist / rncp file) use the same path; folder pickers reject                                                                                                                                                                                                                                                                                                                 |
| TAK server + remote relay (`tak:*`)                                                                                                                                          | Done: lifecycle in `tak/tak-server-host.ts` (moved out of `index.ts`), handlers in `ipc/tak-handlers.ts`; auto-start restored at boot. Publish the TAK port (default 8089) to reach it. Certificate import needs browser upload                                                                                                                                                                                                                                                                                                                                                         |
| GPS (`gps:getFix`)                                                                                                                                                           | Done: the **server's** location (OS / IP geolocation), which is the station position for a gateway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Updates (`update:*`)                                                                                                                                                         | Release check only (`initUpdater(..., { releaseCheckOnly: true })`): reports new versions; update by pulling a new image                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `app:rendererHeartbeat`, service announcements                                                                                                                               | Done (heartbeat accepted and dropped: Electron's hang watchdog has no browser equivalent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Window / OS channels: `app:*`, tray badge, login item, media access, show-in-folder, Electron chooser and power signals                                                      | Done: `headless/headlessAppHandlers.ts` answers them (no-ops, `granted`, `ok: false`); `app:quit` / `app:relaunch` reject so one tab cannot stop the shared server. Clipboard, window focus and `session:clearData` run in the browser (`preload/web/browserLocalInvokes.ts`; the access token survives a session clear). The renderer reads `electronAPI.hostKind === 'web'` (`lib/hostKind.ts`) to hide Quit and show-in-folder and to use the inline emoji picker                                                                                                                    |
| Server features: logs (`log:*`), MECP received log, Reticulum attachment reads, link previews, translation, place lookup, beacon feed, notification sounds, firmware backup  | Done: `ipc/log-handlers.ts` and `ipc/chat-content-handlers.ts` (moved out of `index.ts`) plus the existing modules, registered headless. The server writes `<data dir>/mesh-client.log` and still echoes to stdout. `translation-worker.js` ships next to `server.js` with its license notices. Handlers that answer their caller (`event.sender.send`, e.g. the beacon feed) reach only that tab: each session has a `HeadlessSessionSender` that emits `destroyed` when the tab disconnects. Link previews keep the desktop SSRF guard (private / loopback targets refused after DNS) |
| Notifications (`notify:message`)                                                                                                                                             | Done: shown by the viewer's browser (`browserLocalInvokes.ts`), like chat and alert notifications, which already use the Web Notifications API in the renderer. Browsers offer notifications only on HTTPS or `localhost` and after the viewer allows them; on plain HTTP nothing is shown. Nothing is sent while no tab is open                                                                                                                                                                                                                                                        |
| Offline maps (`offline-maps:*`, `mesh-tiles:`)                                                                                                                               | Done: server-side tile cache and region downloads; tiles served at `/tiles/…` behind a cookie (see [Map tiles](#map-tiles))                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Reticulum (`reticulum:*`, identities)                                                                                                                                        | Done: the image builds the sidecar like release CI (`rns-stack,rns-ble,rns-rnode-tcp`, Ratspeak stack cloned at the reviewed pins) into `/app/resources/reticulum-sidecar/`, found through `app.getAppPath()`. TCP/UDP/RNode-over-TCP interfaces work; BLE RNode and LoRa GATT need the host's BlueZ ([Bluetooth](#bluetooth)). Identity / config file pickers need browser upload                                                                                                                                                                                                      |
| Meshtastic HTTP (`http:*`, `hostLink:*`)                                                                                                                                     | Done (`ipc/http-bridge.ts`, moved out of `index.ts`; polling stops on shutdown)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| MQTT (`mqtt:*`, Meshtastic + MeshCore)                                                                                                                                       | Done (`ipc/mqtt-handlers.ts`, moved out of `index.ts`; headless owns its own client instances and disconnects them on shutdown). MQTT nodes are forwarded to the TAK server                                                                                                                                                                                                                                                                                                                                                                                                             |
| BLE (`gatt:*`, `bleCoexistence:*`, `bluetooth-*`)                                                                                                                            | Done on Linux hosts: `ipc/gatt-handlers.ts` and `ipc/bluetoothctl-handlers.ts` (moved out of `index.ts`), with the host's BlueZ passed through ([Bluetooth](#bluetooth)). Electron's Web Bluetooth pairing prompt channels are dropped (LoRa BLE never uses it)                                                                                                                                                                                                                                                                                                                         |
| Serial (`serial:*`)                                                                                                                                                          | Done: the server's ports through a `navigator.serial` polyfill (`preload/web/webSerialPolyfill.ts`, `headless/serialBridge.ts`); Linux and macOS servers ([Serial ports](#serial-ports))                                                                                                                                                                                                                                                                                                                                                                                                |

## Bluetooth

LoRa BLE (Meshtastic, MeshCore) and Reticulum BLE RNode run in the sidecar, whose btleplug central talks to **BlueZ over the system D-Bus**. The image has the client side (libdbus, and `bluetoothctl` for PIN pairing); the Bluetooth service and adapter stay on the host. So BLE works on **Linux hosts** with BlueZ running; Docker Desktop on macOS and Windows has no host D-Bus to pass in.

```bash
docker run … -v /run/dbus/system_bus_socket:/run/dbus/system_bus_socket mesh-client-web
```

- **Permission:** the host's BlueZ D-Bus policy (`bluetooth.conf` in `/usr/share/dbus-1/system.d/` or `/etc/dbus-1/system.d/`) decides who may talk to it. Current BlueZ allows every local user (`<policy context="default">`), so uid 1000 in the container is enough. Where the policy only allows `root` and the `bluetooth` group, add the host's group id (`--group-add "$(getent group bluetooth | cut -d: -f3)"`; D-Bus reads the caller's groups from the socket) or run the container as root (`--user root`). Without access, scans report `adapter_missing` with `Rejected send message` in the log; with access but no running Bluetooth service or adapter, `Launch helper exited` or `No adapter`.
- **Pairing:** Meshtastic radios need their PIN. The usual Linux flow works: pairing goes through `bluetoothctl` in the container (`ipc/bluetoothctl-handlers.ts`, moved out of `index.ts`), which pairs through the host's BlueZ, so the bond is the host's. Other Bluetooth programs on the host share that adapter and those bonds; do not run the desktop app against the same radio at the same time.
- **Flow:** the panel's Bluetooth option scans and connects through `gatt:*` (`ipc/gatt-handlers.ts`, moved out of `index.ts`), which starts the sidecar in its BLE-only mode when Reticulum is not running, as the desktop app does. The background ingest stores what a Meshtastic BLE session receives while no tab is open; it does not reopen BLE.

## Serial ports

USB radios plugged into the **server** show up in the usual serial port picker. The browser bridge replaces `navigator.serial` with a polyfill whose ports live on the server (`preload/web/webSerialPolyfill.ts`), so the renderer's Web Serial code (Meshtastic, MeshCore, reconnect to a saved port) runs unchanged, in any browser. The viewer's own USB ports are not offered.

- **Server side** (`headless/serialBridge.ts`, `serialDevice.ts`, `serialPorts.ts`): lists `/dev/serial/by-id/*` (stable across replug and reboot) plus `ttyUSB*` / `ttyACM*`, with USB ids from sysfs; macOS servers list `/dev/cu.*`; Windows servers list none (COM ports cannot be opened as files). Opening sets the line with `stty` and reads through a non-blocking tty stream. Only listed ports can be opened, at the usual baud rates.
- **Docker:** pass the device in and give uid 1000 the device's group (`dialout` on Debian / Ubuntu hosts; check with `ls -l /dev/ttyUSB0`):

  ```bash
  docker run … --device /dev/ttyUSB0 --group-add dialout mesh-client-web
  ```

  `/dev/serial/by-id` is a host udev link and does not exist in the container, so the port shows as `ttyUSB0`. A replug can give the radio another number; to follow it, bind `/dev` and allow the USB serial majors instead: `-v /dev:/dev --device-cgroup-rule='c 188:* rmw' --device-cgroup-rule='c 166:* rmw'` (188 `ttyUSB`, 166 `ttyACM`).

- **Unplug:** the port's streams fail with `NetworkError` and it fires `disconnect`, as Web Serial does, so the runtimes start their usual serial reconnect; a replugged radio is found again by its saved port id. A tab whose first connect came from the picker reconnects through the picker, as on desktop.
- **Not supported:** DTR / RTS control (`setSignals`), so firmware flashing over the server's port does not work; flash from the desktop app. Ports plugged in while the picker is open appear the next time it opens.
- **Testing without hardware:** link a pseudo-terminal to a fake radio, for example `socat pty,raw,echo=0,link=/dev/ttyUSB90 tcp:127.0.0.1:4403` with `fake-meshtastic-radio.mjs` (or port 5000 and `fake-meshcore-radio.mjs`), then pick `ttyUSB90`.

## Several tabs (shared viewing)

Several browser tabs (or people) can use one server at once. Each tab runs its own renderer; they share the server's radio links, database and pushes, and every tab can send.

- **Radio link (TCP, and Meshtastic HTTP):** a tab that connects to the target of the link that is already open joins it instead of reconnecting the radio or restarting the HTTP polling (`ipc/linkSharing.ts`, a tap the headless server gives `tcp-bridge.ts` and `http-bridge.ts`; the desktop `index.js` carries only the optional hook calls); it then requests its own config dump over the shared link. A tab already on the link that connects again (its own recovery after a stall) still gets a fresh socket. After a link drop every tab reconnects: the first opens the link, the rest join it.
- **Following each other:** a newly opened link and a user's Disconnect are announced to every tab (`headless:linkChanged`). Disconnected tabs join the link; connected tabs drop it as an explicit disconnect, so they do not reconnect. Closing a tab does not disconnect anything.
- **Data:** incoming traffic reaches every tab on the stream. What one tab writes on its own (sent messages, delivery status, deletes, favorites and notes, MeshCore contacts) is announced to the other tabs (`headless:dataChanged`, `shared/webBridgeDataSync.ts`) when it changed rows, and they reload that protocol's messages or nodes from SQLite (debounced, `renderer/lib/headlessSharedSession.ts`). Stream-derived writes every tab repeats (node saves, histories) are not announced.
- **MeshCore:** the companion protocol has no request ids, and meshcore.js resolves a pending command with the next reply of the right type, so two tabs reading one stream would resolve each other's commands. The server keeps it single-client (`ipc/meshcoreTcpMux.ts`): commands from all tabs go to the radio one at a time, replies go only to the tab that asked (until its last reply: contacts are a start / contact… / end sequence), and pushes (MsgWaiting, adverts, send confirmations) go to every tab. A command with no reply releases the link after 5 s without reply frames. A tab not on the link that sends a disconnect (MeshCore cleans up before connecting) does not drop the link. Messages one tab drains and contacts it fetches reach the others through the data announcements.
- **Serial:** a tab opening a port another tab has open joins it (`headless/serialBridge.ts`): every tab gets the radio's bytes and can write. Like TCP links, the port stays open when tabs close, and closes when the last tab on it disconnects. The first write decides the protocol: MeshCore frames (`<`) go through the same command serializer as TCP, anything else passes through. Tabs do not follow each other's serial connects; a tab that saved the port (it connected before) reconnects to it on load and joins.
- **MQTT:** every tab auto-connects MQTT when it opens. A connect with the same settings as the live (or connecting) connection keeps it and re-sends its status (`headless/mqttConnectionReuse.ts`, given to `ipc/mqtt-handlers.ts` as `keepLiveConnection`); different settings reconnect. A disconnect from any tab disconnects it for all.
- **Reticulum:** the sidecar already serves every tab. A tab that starts the stack while it runs reuses it (`reuseIfRunning`; the sidecar's stack start is a no-op when live). Stopping it stops it for every tab.
- **Testing without hardware:** `node scripts/fake-meshtastic-radio.mjs [--port 4403] [--chatter-ms 5000]` (stream API: config dump, ACKs, peer chatter) and `node scripts/fake-meshcore-radio.mjs [--port 5000] [--chatter-ms 5000]` (companion protocol: self info, contacts, channel 0, message sync with MsgWaiting pushes) are small fake radios.

`getPlatform()` reports the **server's** OS (`linux` / `darwin` / `win32`, other Unix-likes as `linux`), matching what the Electron app reports for the machine its main process runs on. The server injects `<meta name="mesh-client-host-platform">` into `index.html`; the bridge reads it into a global that `process.platform` compiles to in `web-bridge.js`.

## Key files

- `src/shared/webBridgeProtocol.ts`: frames and value codec
- `src/preload/web/electronRendererShim.ts`: browser `ipcRenderer` / `contextBridge`
- `src/preload/web/webSerialPolyfill.ts` and `src/shared/webSerialBridge.ts`: `navigator.serial` backed by the server's ports
- `src/main/headless/`: `index.ts` (entry), `config.ts` (env), `webServer.ts` (HTTP/WS), `ipcRegistry.ts`, `electronShim.ts`, `serialBridge.ts` / `serialDevice.ts` / `serialPorts.ts` (server serial ports)
- `src/main/ipc/gatt-handlers.ts`, `src/main/ipc/bluetoothctl-handlers.ts`: BLE handlers shared with the desktop app
- `src/main/meshtastic-backend/`: Meshtastic background ingest and its in-process / `utilityProcess` hosts
- `scripts/build-headless.mjs`: server + bridge bundles
- `Dockerfile`, `.dockerignore`
