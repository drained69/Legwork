FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Node 22, not 20: the OKX A2A runtime below pulls @xmtp/node-bindings, whose
# native module requires >=22. On 20 the install emits EBADENGINE and the
# runtime fails to load. Legwork's own code runs fine on either.
FROM node:22-slim
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

# ── OKX A2A communication runtime ─────────────────────────────────────────
# The marketplace poller's gate-check requires `communication.ok`, which is
# owned by this CLI. Without it gate-check fails and the poller never starts,
# so tasks addressed to this ASP expire unclaimed. Pinned deliberately: the
# runtime is bootstrapped by `okx-a2a doctor --fix` at boot (see entrypoint).
#
# The XMTP native bindings are a large download that has flaked with ECONNRESET
# on a default single attempt, so retry rather than fail a whole deploy on it.
ARG A2A_NODE_VERSION=0.1.9
RUN npm i -g --fetch-retries=5 --fetch-retry-maxtimeout=120000 \
      "@okxweb3/a2a-node@${A2A_NODE_VERSION}" \
    && okx-a2a --version

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
# Delivered payloads are dispute evidence: a buyer can contest long after a
# redeploy would have cleared an ephemeral filesystem.
ENV DATA_DIR=/data
# The okx-a2a daemon's store — XMTP identity keys, per-job sessions, and the
# BUYER'S CHAT HISTORY — defaults to $HOME/.okx-agent-task on the ephemeral
# rootfs, so every redeploy silently discarded all three. That cost the buyer's
# messages (their criteria live only here; inbound chat never reaches our HTTP
# endpoint) and minted a fresh XMTP installation each deploy, which accumulates
# against the per-inbox installation limit. Pin it to the volume.
ENV OKX_AGENT_TASK_HOME=/data/okx-agent-task
# Railway/Fly/Render terminate TLS in front of the container, so the last
# X-Forwarded-For hop is written by their proxy and can be trusted as the
# rate-limit identity. Never set this when the process is directly exposed.
ENV TRUST_PROXY=true
RUN mkdir -p /data/wallets /data/deliverables /data/okx-agent-task
EXPOSE 8402
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
