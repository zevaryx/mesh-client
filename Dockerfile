# syntax=docker/dockerfile:1
#
# Headless Mesh Client: the renderer served to a browser, backed by a Node server running the
# ported main-process handlers. See docs/development/headless-webui.md for what works today.
#
#   docker build -t mesh-client-web .
#   docker run --rm -p 8080:8080 -v mesh-client-data:/data mesh-client-web
#   # open the URL printed in the log (it carries the session token)
#   # to keep saved credentials across restarts, mount key material and set
#   #   -e MESH_CLIENT_SECRET_KEY_FILE=/run/secrets/<file>   (see docs/development/headless-webui.md)

#   # behind a registry mirror / Docker Hub rate limit:
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node \
#     --build-arg RUST_IMAGE=mirror.gcr.io/library/rust -t mesh-client-web .

ARG NODE_IMAGE=node
ARG NODE_VERSION=22.22.0
ARG RUST_IMAGE=rust

# Reticulum sidecar: same features as release CI (scripts/build-reticulum-sidecar-release.mjs).
# rns-ble links libdbus; BLE itself only works with host BlueZ passed through (Linux hosts).
FROM ${RUST_IMAGE}:1-bookworm AS sidecar
RUN apt-get update \
  && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts ./scripts
COPY reticulum-sidecar ./reticulum-sidecar
# The sidecar embeds shared JSON (interface catalog, RNode RF profiles) at compile time.
COPY src/shared ./src/shared
# Clones rsReticulum / rsLXMF / … at the reviewed pins and applies the repo's overlays.
RUN bash scripts/clone-ratspeak-stack.sh
RUN cd reticulum-sidecar \
  && cargo build --release --features rns-stack,rns-ble,rns-rnode-tcp \
  && strip target/release/mesh-client-reticulum

FROM ${NODE_IMAGE}:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
# Electron is a devDependency but never runs here; skip its ~100 MB binary download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  CI=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Exact pnpm from package.json#packageManager (Node 22's bundled Corepack cannot run pnpm 12).
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
COPY patches ./patches
# --ignore-scripts: skips the Electron native rebuild (postinstall) and git hook setup (prepare).
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build:headless

FROM ${NODE_IMAGE}:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
  MESH_CLIENT_DATA_DIR=/data \
  MESH_CLIENT_WEB_HOST=0.0.0.0 \
  MESH_CLIENT_WEB_PORT=8080
RUN apt-get update \
  && apt-get install -y --no-install-recommends libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Where reticulum-sidecar-path.ts looks: <app.getAppPath()>/resources/reticulum-sidecar/.
COPY --from=sidecar /src/reticulum-sidecar/target/release/mesh-client-reticulum ./resources/reticulum-sidecar/mesh-client-reticulum
# The server bundle is self-contained: no node_modules in the runtime image.
COPY --from=build /src/dist/renderer ./dist/renderer
COPY --from=build /src/dist-headless/server.js /src/dist-headless/web-bridge.js ./dist-headless/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
# TAK server (off until started in the app; publish with -p 8089:8089 when used).
EXPOSE 8089
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MESH_CLIENT_WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-headless/server.js"]
