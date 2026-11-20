# syntax=docker/dockerfile:1

# ---- build: bundle the Node entry points (no node_modules needed at runtime) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build:node

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/board.sqlite
WORKDIR /app
RUN addgroup -S board && adduser -S -G board -u 10001 board \
 && mkdir /data && chown board:board /data
COPY --from=build /app/dist/node ./dist/node
COPY migrations ./migrations
USER board
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/node/server.js"]
