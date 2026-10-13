# syntax=docker/dockerfile:1
# Build context: repository root (needs the pnpm workspace lockfile and the charts).
#   docker build -f provisioner/Dockerfile -t team-mcp/provisioner:local .

FROM node:22.23.3-alpine3.24 AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY provisioner/package.json provisioner/
RUN pnpm install --frozen-lockfile --filter @tmg/provisioner
COPY provisioner/ provisioner/
RUN pnpm --filter @tmg/provisioner test \
 && pnpm --filter @tmg/provisioner build \
 && pnpm --filter @tmg/provisioner deploy --prod --legacy /out

# Helm 3, pinned and verified against the official checksums (get.helm.sh/*.sha256sum).
FROM node:22.23.3-alpine3.24 AS helm
ARG HELM_VERSION=3.22.0
ARG HELM_SHA256_AMD64=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
ARG HELM_SHA256_ARM64=f14e804dfee240f55525b667488fe9adca349e63e00c9af634c0beb1421ac310
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) arch=amd64; sum="$HELM_SHA256_AMD64" ;; \
      aarch64) arch=arm64; sum="$HELM_SHA256_ARM64" ;; \
      *) echo "unsupported architecture $(uname -m)"; exit 1 ;; \
    esac; \
    wget -q -O /tmp/helm.tgz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${arch}.tar.gz"; \
    echo "${sum}  /tmp/helm.tgz" | sha256sum -c -; \
    tar -xzf /tmp/helm.tgz -C /tmp; \
    install -m 0755 "/tmp/linux-${arch}/helm" /usr/local/bin/helm; \
    helm version --short

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/provisioner/dist ./dist
# Only the two charts a store needs; the same charts the main store uses.
COPY charts/store ./charts/store
COPY charts/woo-mcp ./charts/woo-mcp
USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
