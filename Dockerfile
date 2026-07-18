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
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# SQLite lives on a mounted volume in production. On Railway, attach a Volume
# to the service at mount path /data (Railway rejects the Docker VOLUME
# instruction and manages persistence itself). On Fly, [[mounts]] handles it.
ENV DATABASE_PATH=/data/legwork.db
RUN mkdir -p /data
EXPOSE 8402
CMD ["node", "dist/index.js"]
