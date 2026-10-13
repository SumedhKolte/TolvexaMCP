# syntax=docker/dockerfile:1
# Build context: repository root (needs the pnpm workspace lockfile).
#   docker build -f mcp-woo/Dockerfile -t team-mcp/mcp-woo:local .

FROM node:22.23.3-alpine3.24 AS build
WORKDIR /repo
# pnpm version comes from package.json "packageManager" via corepack.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY mcp-woo/package.json mcp-woo/
RUN pnpm install --frozen-lockfile --filter @tmg/mcp-woo
COPY mcp-woo/ mcp-woo/
RUN pnpm --filter @tmg/mcp-woo test \
 && pnpm --filter @tmg/mcp-woo build \
 && pnpm --filter @tmg/mcp-woo deploy --prod --legacy /out

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/mcp-woo/dist ./dist
# Built-in non-root user (uid/gid 1000). The chart also enforces runAsNonRoot.
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
