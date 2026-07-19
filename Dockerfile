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

# ── Optional: OKX Onchain OS CLI (backs email-OTP wallet sign-in) ──────────
# There is no public package for the Linux build, so the installer URL must be
# supplied explicitly at build time:
#   docker build --build-arg ONCHAINOS_INSTALL_URL=https://…/install.sh .
#   railway variables --set ONCHAINOS_INSTALL_URL=…   (then redeploy)
# Without it, wallet sign-in reports itself unavailable in-chat and every other
# feature — profile, hunts, scoring, drafts, approvals — works normally.
ARG ONCHAINOS_INSTALL_URL=""
RUN if [ -n "$ONCHAINOS_INSTALL_URL" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
      curl -fsSL "$ONCHAINOS_INSTALL_URL" -o /tmp/install.sh && sh /tmp/install.sh && rm -f /tmp/install.sh && \
      apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* ; \
    else \
      echo "onchainos CLI not installed — wallet sign-in will report as unavailable" ; \
    fi
ENV PATH="/root/.local/bin:/root/.onchainos/bin:${PATH}"

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
