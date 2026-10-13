#!/usr/bin/env bash
# Build the project's images for production and push them to a registry.
#
# Usage:
#   build-push.sh <registry> <tag> [--platform linux/amd64] [--no-push] [component ...]
#
#   build-push.sh ghcr.io/your-org/team-mcp 0.1.0
#   build-push.sh ghcr.io/your-org/team-mcp 0.1.0 --platform linux/amd64   (Apple Silicon -> amd64 VPS)
#   build-push.sh registry.example.com/team-mcp 0.1.0 --no-push           (build and tag only)
#
# Images are <registry>/<component>:<tag>, matching values-prod.yaml (global.image.registry
# and global.image.tag). Log in to the registry first (`docker login <host>`); this script
# never handles registry credentials.
#
# Without --platform the images are built for this machine's architecture. A VPS with a
# different architecture needs --platform, which requires `docker buildx` (and, on Apple
# Silicon with Colima, emulation: `colima start --vz-rosetta` or QEMU binfmt). The
# alternative is to run this script on the VPS itself (see README, "Production").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALL=(gateway dashboard mcp-woo mcp-notes mcp-slow provisioner)

ok()  { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: build-push.sh <registry> <tag> [--platform P] [--no-push] [component ...]"
REGISTRY="${1%/}"; TAG="$2"; shift 2
PLATFORM=""; PUSH=1; components=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:?--platform needs a value, e.g. linux/amd64}"; shift 2 ;;
    --no-push) PUSH=0; shift ;;
    -*) die "unknown option $1" ;;
    *) components+=("$1"); shift ;;
  esac
done
[ ${#components[@]} -gt 0 ] || components=("${ALL[@]}")

# Production pins a version: a moving tag would make rollbacks meaningless.
case "$TAG" in latest | local | "") die "tag '$TAG' is not allowed; use a version like 0.1.0" ;; esac
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid tag '$TAG'"
[[ "$REGISTRY" =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$ ]] || die "registry should look like ghcr.io/your-org/team-mcp"
[[ "$REGISTRY" != *your-org* ]] || [ "$PUSH" = 0 ] || die "replace the 'your-org' placeholder with your registry namespace"

if [ -n "$PLATFORM" ]; then
  docker buildx version >/dev/null 2>&1 || die "--platform needs docker buildx (brew install docker-buildx), or build on the VPS without --platform"
fi

for c in "${components[@]}"; do
  dockerfile="$ROOT/$c/Dockerfile"
  [ -f "$dockerfile" ] || die "no Dockerfile for component '$c'"
  image="$REGISTRY/$c:$TAG"
  # Each Dockerfile runs the component's tests during the build, so a failing test
  # stops the release here.
  if [ -n "$PLATFORM" ]; then
    out=(--load); [ "$PUSH" = 1 ] && out=(--push)
    docker buildx build --platform "$PLATFORM" -t "$image" -f "$dockerfile" "${out[@]}" "$ROOT"
  else
    docker build -t "$image" -f "$dockerfile" "$ROOT"
    [ "$PUSH" = 1 ] && docker push "$image"
  fi
  ok "$image $([ "$PUSH" = 1 ] && echo "built and pushed" || echo "built (not pushed)")"
done

printf '\nUse in values/values-prod.yaml:\n  global:\n    image:\n      registry: %s\n      tag: "%s"\n' "$REGISTRY" "$TAG"
