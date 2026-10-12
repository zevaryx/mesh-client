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
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node -t mesh-client-web .

ARG NODE_IMAGE=node
ARG NODE_VERSION=22.22.0

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
WORKDIR /app
# The server bundle is self-contained: no node_modules in the runtime image.
COPY --from=build /src/dist/renderer ./dist/renderer
COPY --from=build /src/dist-headless/server.js /src/dist-headless/web-bridge.js ./dist-headless/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MESH_CLIENT_WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-headless/server.js"]
