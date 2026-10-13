#!/usr/bin/env bash
# Register the demo upstreams (notes, slow) with the gateway, the same way an admin would
# on the Servers page. WooCommerce is built in (seeded by the gateway), so it's not here.
# Idempotent: servers that are already registered (by slug) are left alone.
#
# Usage: register-upstreams.sh            (called by up-local.sh)
# Env:   HUB_URL (default http://hub.localtest.me), ENV_FILE (default .env)
#
# The admin password and the upstream tokens come from .env and reach curl only through
# stdin (never argv, never printed).
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB="${HUB_URL:-http://hub.localtest.me}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
W="$(mktemp -d)"
trap 'curl -s -o /dev/null -b "$W/jar" -X POST "$HUB/api/auth/logout" 2>/dev/null; rm -rf "$W"' EXIT

ok()  { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
env_get() { { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2-; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
E="$(env_get ADMIN_EMAIL)" P="$(env_get ADMIN_PASSWORD)" jq -n '{email: env.E, password: env.P}' |
  curl -s -o "$W/login" -w '%{http_code}' -c "$W/jar" -H 'content-type: application/json' --data-binary @- "$HUB/api/auth/login" >"$W/code"
[ "$(cat "$W/code")" = 200 ] || die "admin login failed (HTTP $(cat "$W/code")): $(jq -r '.error.message // empty' "$W/login" 2>/dev/null)"

curl -s -b "$W/jar" "$HUB/api/servers" >"$W/servers"

# register <slug> <name> <url> <ENV KEY of the bearer token>
register() {
  if jq -e --arg s "$1" 'any(.servers[]; .slug == $s)' "$W/servers" >/dev/null; then
    ok "$1 already registered"
    return
  fi
  local token; token="$(env_get "$4")"
  [ -n "$token" ] || die "$4 is empty in $ENV_FILE"
  S="$1" N="$2" U="$3" T="$token" jq -n '{slug: env.S, name: env.N, url: env.U, cred_type: "bearer", credential: env.T}' |
    curl -s -o "$W/created" -w '%{http_code}' -b "$W/jar" -H 'content-type: application/json' --data-binary @- "$HUB/api/servers" >"$W/code"
  [ "$(cat "$W/code")" = 201 ] || die "registering $1 failed (HTTP $(cat "$W/code")): $(jq -r '.error.message // empty' "$W/created" 2>/dev/null)"
  ok "$1 registered (status: $(jq -r '.server.status // "?"' "$W/created"))"
}

register notes Notes "http://mcp-notes.upstreams.svc.cluster.local:8080/mcp" NOTES_MCP_BEARER_TOKEN
register slow Slow "http://mcp-slow.upstreams.svc.cluster.local:8080/mcp" SLOW_MCP_BEARER_TOKEN
