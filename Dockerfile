# freeBooks — production image.
#
#   docker run -d --name freebooks -p 127.0.0.1:3000:3000 \
#     -v freebooks-data:/data ghcr.io/lars010101/freebooks:latest
#
# All state lives in /data (database, its pre-migration backups,
# attachments, agent inbox). Pending schema migrations run on start.
# The server trusts every client that can reach it (single-user install),
# so publish the port on 127.0.0.1 only; see README "Running with Docker".
#
# The distrobox development container is Dockerfile.dev.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/package-lock.json api/
COPY mcp/package.json mcp/package-lock.json mcp/
RUN npm ci --omit=dev --ignore-scripts \
 && npm ci --omit=dev --prefix api \
 && npm ci --omit=dev --prefix mcp \
 && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    FREEBOOKS_BIND=0.0.0.0 \
    FREEBOOKS_DB_PATH=/data/freebooks.duckdb \
    FREEBOOKS_ATTACHMENTS_ROOT=/data/attachments \
    FREEBOOKS_INBOX_ROOT=/data/inbox
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/api/node_modules api/node_modules
COPY --from=deps /app/mcp/node_modules mcp/node_modules
COPY package.json ./
COPY api/package.json api/
COPY api/src api/src
COPY api/public api/public
COPY db db
COPY reports reports
COPY mcp/package.json mcp/server.js mcp/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "api/src/index.js"]
