FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# ── OKX Onchain OS CLI (backs wallet sign-in) ─────────────────────────────
# Prebuilt static binaries are published on the official releases page
# (github.com/okx/onchainos-skills) with a checksums.txt. Download the one for
# this image's architecture and verify it before installing — the build FAILS
# on a checksum mismatch rather than shipping a tampered or truncated binary.
# Pin the version; bump deliberately after testing, since the bot's login flow
# tracks the CLI's `wallet login --phase init/poll` contract.
ARG ONCHAINOS_VERSION=v4.3.0
RUN set -eu; \
    apt-get update && apt-get install -y --no-install-recommends curl ca-certificates; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) asset="onchainos-x86_64-unknown-linux-gnu" ;; \
      arm64) asset="onchainos-aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}"; \
    curl -fsSL "$base/$asset" -o /usr/local/bin/onchainos; \
    curl -fsSL "$base/checksums.txt" -o /tmp/checksums.txt; \
    ( cd /usr/local/bin && grep " ${asset}\$" /tmp/checksums.txt | sed "s|${asset}|onchainos|" | sha256sum -c - ); \
    rm -f /tmp/checksums.txt; \
    chmod +x /usr/local/bin/onchainos; \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    onchainos --version

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# SQLite lives on a mounted volume in production. On Railway, attach a Volume
# to the service at mount path /data (Railway rejects the Docker VOLUME
# instruction and manages persistence itself). On Fly, [[mounts]] handles it.
ENV DATABASE_PATH=/data/legwork.db
# Per-user OKX wallet sessions live on the persistent volume so sign-ins
# survive redeploys.
ENV WALLET_HOME_ROOT=/data/wallets
RUN mkdir -p /data/wallets
EXPOSE 8402
CMD ["node", "dist/index.js"]
