# syntax=docker/dockerfile:1
# Build context: repository root.
#   docker build -f dashboard/Dockerfile -t team-mcp/dashboard:local .

FROM node:22.23.3-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY dashboard/package.json dashboard/
RUN pnpm install --frozen-lockfile --filter @tmg/dashboard
COPY dashboard/ dashboard/
# No build-time env is passed: the bundle contains no configuration and no secrets.
RUN pnpm --filter @tmg/dashboard test && pnpm --filter @tmg/dashboard build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine3.24
COPY dashboard/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY dashboard/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/dashboard/dist /usr/share/nginx/html
# uid 101 = nginx. All writable paths (pid, temp files) are under /tmp (an emptyDir).
USER 101
EXPOSE 8080
# Run nginx directly: the image's entrypoint scripts try to rewrite config files, which
# a read-only root filesystem (and this static config) doesn't need.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
