#!/usr/bin/env bash
# Delete the local Kind cluster (and with it every PVC and Secret inside it).
# Usage: teardown-local.sh [--stop-colima]
# .env is left untouched so the next up-local.sh reuses the same credentials.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-team-mcp}"

command -v kind >/dev/null || { echo "ERROR: kind not found" >&2; exit 1; }

# Capture the list first. Piping straight into `grep -q` under pipefail can report a
# false "not found": grep exits at the first match, kind gets SIGPIPE, the pipeline fails.
clusters="$(kind get clusters 2>/dev/null || true)"

if grep -qx "$CLUSTER_NAME" <<<"$clusters"; then
  kind delete cluster --name "$CLUSTER_NAME"
  if grep -qx "$CLUSTER_NAME" <<<"$(kind get clusters 2>/dev/null || true)"; then
    echo "ERROR: cluster '$CLUSTER_NAME' still exists after deletion" >&2
    exit 1
  fi
  echo "Kind cluster '$CLUSTER_NAME' deleted."
else
  echo "Kind cluster '$CLUSTER_NAME' does not exist; nothing to delete."
fi

if [ "${1:-}" = "--stop-colima" ]; then
  colima stop
fi
