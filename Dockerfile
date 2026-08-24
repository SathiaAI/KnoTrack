# KnoTrack — self-hosted MCP server
# Multi-stage build: compile TypeScript, then run the plain JS output on a
# slim Node 20 base with only production dependencies installed.

FROM node:20.20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20.20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# scripts/migrate.ts resolves MIGRATIONS_DIR relative to its own compiled
# location (dist/scripts/migrate.js -> dist/migrations), so the SQL files
# must land there, not at /app/migrations.
COPY migrations ./dist/migrations

# Run as the non-root user node:20.20-slim already ships (uid 1000), not root.
USER node

# Migrations are run as a separate deploy-time step (docs/TRD.md §7/§8),
# never automatically on container start, e.g.:
#   docker run --rm --env-file .env <image> node dist/scripts/migrate.js
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/src/index.js"]
