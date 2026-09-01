FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The Telegraph miner YAML is served verbatim at GET /miner.yaml — nodes fetch
# it from this URL and verify it against the on-chain SHA-256 commitment.
COPY miner.yaml ./miner.yaml
# SQLite lives on a mounted volume in production. On Railway, attach a Volume
# to the service at mount path /data (Railway rejects the Docker VOLUME
# instruction and manages persistence itself). On Fly, [[mounts]] handles it.
ENV DATABASE_PATH=/data/legwork.db
ENV DATA_DIR=/data
# Railway/Fly/Render terminate TLS in front of the container, so the last
# X-Forwarded-For hop is written by their proxy and can be trusted as the
# rate-limit identity. Never set this when the process is directly exposed.
ENV TRUST_PROXY=true
RUN mkdir -p /data
EXPOSE 8402
CMD ["node", "dist/index.js"]
