# syntax=docker/dockerfile:1
# worlds (qt.log2u.me): one container serves the built client, /api and /ws.
# Node 22 LTS (Node 20 reached end of life on 2026-04-30). better-sqlite3 11.x
# ships prebuilt binaries for Node 22; the toolchain below is only a fallback.

# ---------- build: client + server (TypeScript), then prune to production deps
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only for the rare case better-sqlite3 has no prebuilt binary.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false

# BuildKit cache mount: rebuilds reuse downloaded packages (slow disk/network on the N100).
COPY client/package.json client/package-lock.json client/
RUN --mount=type=cache,target=/root/.npm cd client && npm ci
COPY server/package.json server/package-lock.json server/
RUN --mount=type=cache,target=/root/.npm cd server && npm ci

COPY shared/ shared/
COPY client/ client/
COPY server/ server/
# The runtime needs only better-sqlite3's compiled addon: drop the bundled SQLite
# sources (~10 MB) and any compile leftovers after pruning dev dependencies.
RUN cd client && npm run build \
  && cd ../server && npm run build && npm prune --omit=dev \
  && cd node_modules/better-sqlite3 \
  && mv build/Release/better_sqlite3.node /tmp/better_sqlite3.node \
  && rm -rf deps src binding.gyp build \
  && mkdir -p build/Release && mv /tmp/better_sqlite3.node build/Release/

# ---------- runtime
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    SERVE_CLIENT=1 \
    HOST=0.0.0.0 \
    PORT=5181 \
    WORLDS_DB=/data/worlds.db
WORKDIR /app
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/scripts server/scripts
COPY --from=build /app/client/dist client/dist
# The Bible text is baked into the image (read-only, ~6 MB); the DB lives in /data.
COPY data/bible-krv.json data/curated-verses.json data/
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5181
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5181/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/server/src/index.js"]
