#!/usr/bin/env bash
# Run `helm lint` and `helm template` for every chart against BOTH environment values
# files. Fails on the first error. Required by spec section 6.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHARTS=(platform store woo-mcp upstream-mcp:notes upstream-mcp:slow provisioner)
ENVS=(local prod)

ok() { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }

# "chart:instance" entries render the generic upstream chart once per instance.
for entry in "${CHARTS[@]}"; do
  chart="${entry%%:*}"
  instance=""; [ "$entry" != "$chart" ] && instance="${entry#*:}"
  extra=""; [ -n "$instance" ] && extra="--set instance=$instance"
  dir="$ROOT/charts/$chart"
  if grep -q '^dependencies:' "$dir/Chart.yaml"; then
    helm dependency update "$dir" >/dev/null
  fi
  for env in "${ENVS[@]}"; do
    values="$ROOT/values/values-$env.yaml"
    # shellcheck disable=SC2086
    helm lint "$dir" -f "$values" $extra --quiet >/dev/null
    # shellcheck disable=SC2086
    helm template "$chart" "$dir" -f "$values" $extra >/dev/null
    ok "$entry [$env]: lint + template"
  done
done

# Production-readiness rules over the rendered manifests of both environments: probes,
# requests/limits, security contexts, NetworkPolicies, RBAC, TLS, storage, replicas.
command -v node >/dev/null || { echo "node not found (needed for the policy check)" >&2; exit 1; }
[ -d "$ROOT/node_modules/yaml" ] || { echo "run 'pnpm install' first (policy check needs the yaml package)" >&2; exit 1; }
node "$ROOT/scripts/policy-check.mjs"
