#!/usr/bin/env bash
# Build the project's images and load them into the Kind cluster (no registry needed).
#
# Usage: load-images.sh [component ...]   default: every component that has a Dockerfile
# Images are tagged team-mcp/<component>:local to match values/values-local.yaml.
# Build context is the repo root so Dockerfiles can use the pnpm workspace lockfile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-team-mcp}"
TAG="${IMAGE_TAG:-local}"
ALL=(gateway dashboard mcp-woo mcp-notes mcp-slow provisioner)

ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
skip() { printf '\033[0;33m    - %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Capture first: `kind ... | grep -q` under pipefail can fail spuriously (SIGPIPE).
grep -qx "$CLUSTER_NAME" <<<"$(kind get clusters 2>/dev/null || true)" || die "Kind cluster '$CLUSTER_NAME' not found (run scripts/up-local.sh)"

components=("$@")
[ ${#components[@]} -gt 0 ] || components=("${ALL[@]}")

for c in "${components[@]}"; do
  dockerfile="$ROOT/$c/Dockerfile"
  if [ ! -f "$dockerfile" ]; then
    skip "$c: no Dockerfile yet, skipping"
    continue
  fi
  image="team-mcp/$c:$TAG"
  docker build -t "$image" -f "$dockerfile" "$ROOT"
  kind load docker-image "$image" --name "$CLUSTER_NAME"
  ok "$image built and loaded"
done
