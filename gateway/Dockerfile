# syntax=docker/dockerfile:1
# Build context: repository root (needs the pnpm workspace lockfile).
#   docker build -f gateway/Dockerfile -t team-mcp/gateway:local .

FROM node:22.23.3-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY gateway/package.json gateway/
RUN pnpm install --frozen-lockfile --filter @tmg/gateway
COPY gateway/ gateway/
# Unit + integration tests (PGlite) run inside the build: failing tests fail the image.
RUN pnpm --filter @tmg/gateway test \
 && pnpm --filter @tmg/gateway build \
 && pnpm --filter @tmg/gateway deploy --prod --legacy /out

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/gateway/dist ./dist
# SQL migrations, applied at startup (dist/db/migrate.js resolves ../../drizzle).
COPY --from=build /repo/gateway/drizzle ./drizzle
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
