# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Autopilot
#
# Node 24 is required, not incidental: persistence uses the built-in
# `node:sqlite` module, which means no native addon, no node-gyp in the build,
# and no compiler toolchain in the final image.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first so a source-only edit does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/autopilot.db

RUN apk add --no-cache tini wget

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The SQLite file lives on a volume so history survives a redeploy — the
# analytics are only meaningful if the event log outlives the container.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# tini reaps zombies and forwards SIGTERM, so the graceful shutdown path in
# server.ts actually runs and in-flight state is flushed.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]
