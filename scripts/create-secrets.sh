#!/usr/bin/env bash
# Turn .env into Kubernetes Secrets. The only path by which secrets enter the cluster
# in local dev (in production, see docs/upgrade-rollback.md).
#
# Usage:
#   create-secrets.sh             read .env, create namespaces, create/update Secrets
#   create-secrets.sh --generate  first fill every EMPTY value in .env with a random
#                                 secret or local default (never overwrites a set value)
#
# Guarantees:
# - Never prints a secret value (only key names).
# - Values never appear on a command line (ps-visible); they go through a 0600 temp file.
# - Existing Secrets are merge-patched, so keys written by others are kept. This matters
#   for store/woo-mcp-secrets, where the store-init Job adds WC_CONSUMER_KEY/SECRET.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
EXAMPLE_FILE="$ROOT/.env.example"
# The gateway's DATABASE_URL is derived; override these if the postgres release differs.
PG_HOST="${PG_HOST:-postgres.platform.svc.cluster.local}"
PG_USER="${PG_USER:-gateway}"
PG_DB="${PG_DB:-gateway}"

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }

umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Read KEY from .env without sourcing it (sourcing would execute arbitrary shell).
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  # `|| true`: a missing key (e.g. one newly added to .env.example) is "empty", not fatal.
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n1 | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

rand_hex()  { openssl rand -hex "$1"; }
rand_pass() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }

default_for() {
  case "$1" in
    CREDENTIAL_ENC_KEY) openssl rand -base64 32 ;;
    SESSION_SECRET|WORDPRESS_SALT) rand_hex 32 ;;
    POSTGRES_PASSWORD|MARIADB_ROOT_PASSWORD|MARIADB_PASSWORD) rand_hex 24 ;;
    WOO_MCP_BEARER_TOKEN|NOTES_MCP_BEARER_TOKEN|SLOW_MCP_BEARER_TOKEN|PROVISIONER_TOKEN) rand_hex 32 ;;
    ADMIN_PASSWORD|WP_ADMIN_PASSWORD) rand_pass ;;
    ADMIN_EMAIL) echo "admin@hub.localtest.me" ;;
    WP_ADMIN_USER) echo "storeadmin" ;;
    WP_ADMIN_EMAIL) echo "admin@store.localtest.me" ;;
    LLM_API_KEY) echo "" ;; # Ollama needs none
    *) echo "" ;;
  esac
}

generate_env() {
  local out="$TMP/env.new" generated=()
  : > "$out"
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^([A-Z0-9_]+)= ]]; then
      local key="${BASH_REMATCH[1]}" val
      val="$(env_get "$key")"
      if [ -z "$val" ]; then
        val="$(default_for "$key")"
        [ -n "$val" ] && generated+=("$key")
      fi
      printf '%s=%s\n' "$key" "$val" >> "$out"
    else
      printf '%s\n' "$line" >> "$out"
    fi
  done < "$EXAMPLE_FILE"
  mv "$out" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if [ ${#generated[@]} -gt 0 ]; then
    ok "generated values for: ${generated[*]}"
  else
    ok ".env already complete; nothing generated"
  fi
}

require() { # fail if any named key is empty
  local missing=()
  for k in "$@"; do [ -n "$(env_get "$k")" ] || missing+=("$k"); done
  [ ${#missing[@]} -eq 0 ] || die "empty in $ENV_FILE: ${missing[*]} (run with --generate to fill)"
}

# Namespaces are created here (not by Helm) because Secrets must exist before installs.
# Pod Security Admission "restricted" is enforced on all of them: every workload must run
# non-root, drop all capabilities, disallow privilege escalation, and use seccomp.
ensure_ns() {
  kubectl create namespace "$1" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl label namespace "$1" --overwrite \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/audit=restricted >/dev/null
}

# upsert_secret <namespace> <name> KEY=ENVKEY ...
# Each pair maps a Secret key to the .env key holding its value; ENVKEY may be the
# special form "=literal" to pass a computed value (used for DATABASE_URL).
upsert_secret() {
  local ns="$1" name="$2"; shift 2
  local f="$TMP/$ns-$name.env"
  : > "$f"
  for pair in "$@"; do
    local key="${pair%%=*}" src="${pair#*=}" val
    if [[ "$src" == =* ]]; then val="${src#=}"; else val="$(env_get "$src")"; fi
    printf '%s=%s\n' "$key" "$val" >> "$f"
  done
  if kubectl -n "$ns" get secret "$name" >/dev/null 2>&1; then
    kubectl -n "$ns" create secret generic "$name" --from-env-file="$f" --dry-run=client -o json \
      | jq '{data: .data}' > "$f.patch.json"
    kubectl -n "$ns" patch secret "$name" --type merge --patch-file "$f.patch.json" >/dev/null
    ok "$ns/$name updated (keys: $(cut -d= -f1 "$f" | tr '\n' ' '))"
  else
    kubectl -n "$ns" create secret generic "$name" --from-env-file="$f" >/dev/null
    kubectl -n "$ns" label secret "$name" app.kubernetes.io/managed-by=create-secrets >/dev/null
    ok "$ns/$name created (keys: $(cut -d= -f1 "$f" | tr '\n' ' '))"
  fi
}

main() {
  command -v kubectl >/dev/null || die "kubectl not found"
  command -v jq >/dev/null || die "jq not found"
  command -v openssl >/dev/null || die "openssl not found"

  if [ "${1:-}" = "--generate" ]; then
    generate_env
  fi
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Copy .env.example or run with --generate."

  require POSTGRES_PASSWORD SESSION_SECRET CREDENTIAL_ENC_KEY ADMIN_EMAIL ADMIN_PASSWORD \
          WOO_MCP_BEARER_TOKEN MARIADB_ROOT_PASSWORD MARIADB_PASSWORD \
          WP_ADMIN_USER WP_ADMIN_PASSWORD WP_ADMIN_EMAIL WORDPRESS_SALT \
          NOTES_MCP_BEARER_TOKEN SLOW_MCP_BEARER_TOKEN PROVISIONER_TOKEN

  local keylen
  keylen="$(env_get CREDENTIAL_ENC_KEY | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
  [ "$keylen" = "32" ] || die "CREDENTIAL_ENC_KEY must be base64 of exactly 32 bytes (got $keylen)"

  for ns in platform store upstreams provisioner; do ensure_ns "$ns"; done
  ok "namespaces platform, store, upstreams, provisioner exist (Pod Security: restricted)"

  local db_url="postgres://${PG_USER}:$(env_get POSTGRES_PASSWORD)@${PG_HOST}:5432/${PG_DB}"

  upsert_secret platform gateway-secrets \
    "DATABASE_URL==$db_url" SESSION_SECRET=SESSION_SECRET CREDENTIAL_ENC_KEY=CREDENTIAL_ENC_KEY \
    ADMIN_EMAIL=ADMIN_EMAIL ADMIN_PASSWORD=ADMIN_PASSWORD LLM_API_KEY=LLM_API_KEY \
    WOO_MCP_BEARER_TOKEN=WOO_MCP_BEARER_TOKEN PROVISIONER_TOKEN=PROVISIONER_TOKEN
  # NOTES/SLOW tokens deliberately do NOT go to the gateway: an admin registers those
  # upstreams through the API, and their credentials are stored encrypted in Postgres.
  upsert_secret platform postgres-secrets POSTGRES_PASSWORD=POSTGRES_PASSWORD

  upsert_secret store mariadb-secrets MARIADB_ROOT_PASSWORD=MARIADB_ROOT_PASSWORD MARIADB_PASSWORD=MARIADB_PASSWORD
  upsert_secret store wordpress-secrets \
    WORDPRESS_DB_PASSWORD=MARIADB_PASSWORD WP_ADMIN_USER=WP_ADMIN_USER \
    WP_ADMIN_PASSWORD=WP_ADMIN_PASSWORD WP_ADMIN_EMAIL=WP_ADMIN_EMAIL WORDPRESS_SALT=WORDPRESS_SALT
  # Only the bearer token comes from .env; the store-init Job merges in the WC keys.
  upsert_secret store woo-mcp-secrets WOO_MCP_BEARER_TOKEN=WOO_MCP_BEARER_TOKEN

  upsert_secret upstreams mcp-notes-secrets MCP_BEARER_TOKEN=NOTES_MCP_BEARER_TOKEN
  upsert_secret upstreams mcp-slow-secrets MCP_BEARER_TOKEN=SLOW_MCP_BEARER_TOKEN
  # Multi-store bonus: the provisioner authenticates the gateway with this shared token.
  upsert_secret provisioner provisioner-secrets PROVISIONER_TOKEN=PROVISIONER_TOKEN

  registry_pull_secret
}

# Optional (production with a private registry): an image pull secret "registry-pull" in
# every namespace, from REGISTRY_SERVER / REGISTRY_USERNAME / REGISTRY_TOKEN. The token
# reaches jq through the environment, never argv.
registry_pull_secret() {
  local server user token cfg="$TMP/dockerconfig.json"
  server="$(env_get REGISTRY_SERVER)"; user="$(env_get REGISTRY_USERNAME)"; token="$(env_get REGISTRY_TOKEN)"
  [ -n "$server$user$token" ] || return 0
  [ -n "$server" ] && [ -n "$user" ] && [ -n "$token" ] || die "set all of REGISTRY_SERVER, REGISTRY_USERNAME, REGISTRY_TOKEN (or none)"
  S="$server" U="$user" T="$token" jq -n \
    '{auths: {(env.S): {username: env.U, password: env.T, auth: ((env.U + ":" + env.T) | @base64)}}}' > "$cfg"
  for ns in platform store upstreams provisioner; do
    kubectl -n "$ns" create secret generic registry-pull --type=kubernetes.io/dockerconfigjson \
      --from-file=.dockerconfigjson="$cfg" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    kubectl -n "$ns" label secret registry-pull app.kubernetes.io/managed-by=create-secrets --overwrite >/dev/null
  done
  ok "image pull secret registry-pull in platform, store, upstreams, provisioner (server: $server)"
}

main "$@"
