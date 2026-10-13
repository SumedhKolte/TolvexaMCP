#!/usr/bin/env bash
# Bring up the complete local environment on Kind (macOS + Colima).
#
# Idempotent: every step checks current state first, so re-running is safe and is
# the normal way to apply changes (it ends in `helm upgrade --install` for each release).
#
# Env overrides: CLUSTER_NAME, COLIMA_CPU, COLIMA_MEMORY, COLIMA_DISK, INGRESS_NGINX_VERSION
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-team-mcp}"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
COLIMA_CPU="${COLIMA_CPU:-4}"
COLIMA_MEMORY="${COLIMA_MEMORY:-8}"
COLIMA_DISK="${COLIMA_DISK:-60}"
# Pinned so a fresh cluster is reproducible. Bump deliberately (see docs/upgrade-rollback.md).
INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-4.15.1}"
# Small image used only for the one-off NetworkPolicy enforcement check.
AGNHOST_IMAGE="registry.k8s.io/e2e-test-images/agnhost:2.53"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  local missing=()
  for t in colima docker kind kubectl helm jq openssl; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing tools: ${missing[*]} (brew install colima docker kind kubectl helm@3 jq)"
  helm version --short | grep -q '^v3\.' || die "Helm 3 is required (found $(helm version --short))"
}

ensure_colima() {
  step "Colima"
  if colima status >/dev/null 2>&1; then
    ok "already running"
  else
    colima start --cpu "$COLIMA_CPU" --memory "$COLIMA_MEMORY" --disk "$COLIMA_DISK" --vm-type vz
    ok "started"
  fi
  docker info >/dev/null 2>&1 || die "docker CLI cannot reach the Colima daemon (try: docker context use colima)"
}

ensure_cluster() {
  step "Kind cluster '${CLUSTER_NAME}'"
  # Capture first: `kind ... | grep -q` under pipefail can fail spuriously (SIGPIPE).
  if grep -qx "$CLUSTER_NAME" <<<"$(kind get clusters 2>/dev/null || true)"; then
    ok "already exists"
  else
    kind create cluster --config "$ROOT/kind/kind-config.yaml" --wait 120s
    ok "created"
    verify_networkpolicy_enforcement
  fi
  kubectl config use-context "$KUBE_CONTEXT" >/dev/null
  kubectl wait --for=condition=Ready nodes --all --timeout=120s >/dev/null
  ok "node(s) Ready, context ${KUBE_CONTEXT}"
}

# The whole design relies on deny-by-default NetworkPolicies. A CNI that silently ignores
# them would make every policy decorative, so prove enforcement once on a fresh cluster:
# a pod can reach a server, then cannot after a default-deny ingress policy is applied.
verify_networkpolicy_enforcement() {
  step "Verifying the CNI enforces NetworkPolicy"
  local ns=netpol-check
  kubectl create namespace "$ns" >/dev/null
  kubectl -n "$ns" run srv --image="$AGNHOST_IMAGE" --port=8080 --labels=app=srv -- netexec --http-port=8080 >/dev/null
  kubectl -n "$ns" expose pod srv --port=8080 >/dev/null
  kubectl -n "$ns" wait --for=condition=Ready pod/srv --timeout=120s >/dev/null

  probe() { # exit 0 if srv is reachable from a fresh client pod
    kubectl -n "$ns" run "probe-$1" --rm -i --restart=Never --quiet --image="$AGNHOST_IMAGE" \
      --command -- /agnhost connect srv:8080 --timeout=3s >/dev/null 2>&1
  }

  probe before || { kubectl delete ns "$ns" --wait=false >/dev/null; die "baseline connectivity failed; cluster networking is broken"; }
  ok "baseline: client reaches server"

  kubectl -n "$ns" apply -f - >/dev/null <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress }
spec: { podSelector: {}, policyTypes: [Ingress] }
EOF
  sleep 3 # give the CNI a moment to program the rule
  if probe after; then
    kubectl delete ns "$ns" --wait=false >/dev/null
    die "NetworkPolicy is NOT enforced by this cluster's CNI; refusing to continue"
  fi
  ok "after default-deny: client is blocked (NetworkPolicy enforced)"
  kubectl delete ns "$ns" --wait=false >/dev/null
}

ensure_ingress_nginx() {
  step "ingress-nginx ${INGRESS_NGINX_VERSION}"
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
  helm repo update ingress-nginx >/dev/null
  # Kind-specific settings: bind 80/443 as hostPorts on the ingress-ready node (mapped to
  # the Mac by kind-config.yaml). maxSurge 0 because two pods can't hold the same hostPort.
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --kube-context "$KUBE_CONTEXT" \
    --namespace ingress-nginx --create-namespace \
    --version "$INGRESS_NGINX_VERSION" \
    --set controller.hostPort.enabled=true \
    --set controller.service.type=NodePort \
    --set-string controller.nodeSelector.ingress-ready=true \
    --set-json 'controller.tolerations=[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}]' \
    --set-json 'controller.updateStrategy={"type":"RollingUpdate","rollingUpdate":{"maxSurge":0,"maxUnavailable":1}}' \
    --set controller.publishService.enabled=false \
    --set controller.extraArgs.publish-status-address=localhost \
    --set controller.ingressClassResource.default=true \
    --set controller.resources.requests.cpu=100m \
    --set controller.resources.requests.memory=128Mi \
    --set controller.resources.limits.cpu=500m \
    --set controller.resources.limits.memory=384Mi \
    --wait --timeout 5m >/dev/null
  kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s >/dev/null
  ok "controller ready"
}

ensure_secrets() {
  step "Secrets"
  # --generate only fills EMPTY values in .env; existing values are never changed.
  bash "$ROOT/scripts/create-secrets.sh" --generate
}

# helm_release <release> <chart dir> <namespace> [extra helm args...]
helm_release() {
  local release="$1" chart="$2" ns="$3"; shift 3
  step "Helm release ${release} (namespace ${ns})"
  helm upgrade --install "$release" "$ROOT/charts/$chart" \
    --kube-context "$KUBE_CONTEXT" --namespace "$ns" \
    -f "$ROOT/values/values-local.yaml" "$@" \
    --wait --timeout 15m
  ok "${release} deployed"
}

# Docker image ID of a locally built component. Passed to the charts as `imageId` so a
# rebuilt :local image changes the pod template and rolls the pods.
image_id() { docker image inspect -f '{{.Id}}' "team-mcp/$1:local"; }

main() {
  require_tools
  ensure_colima
  ensure_cluster
  ensure_ingress_nginx
  ensure_secrets
  step "Images"
  bash "$ROOT/scripts/load-images.sh" mcp-woo gateway mcp-notes mcp-slow dashboard provisioner
  helm_release store store store
  helm_release woo-mcp woo-mcp store --set-string "wooMcp.imageId=$(image_id mcp-woo)"
  helm dependency update "$ROOT/charts/platform" >/dev/null
  helm_release platform platform platform --set-string "gateway.imageId=$(image_id gateway)" \
    --set-string "dashboard.imageId=$(image_id dashboard)"
  # The same generic chart, once per upstream instance.
  helm_release mcp-notes upstream-mcp upstreams --set instance=notes \
    --set-string "upstreams.instances.notes.imageId=$(image_id mcp-notes)"
  helm_release mcp-slow upstream-mcp upstreams --set instance=slow \
    --set-string "upstreams.instances.slow.imageId=$(image_id mcp-slow)"
  # Multi-store bonus: the store provisioner (renders nothing if global.stores is off).
  helm_release provisioner provisioner provisioner \
    --set-string "provisioner.imageId=$(image_id provisioner)"
  # notes and slow are registered like an admin would on the Servers page (WooCommerce
  # is built in). Idempotent, so re-running up-local.sh keeps existing registrations.
  step "Demo upstreams"
  bash "$ROOT/scripts/register-upstreams.sh"
  step "Done"
  echo "    Context: ${KUBE_CONTEXT}"
}

main "$@"
