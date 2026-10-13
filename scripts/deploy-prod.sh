#!/usr/bin/env bash
# Deploy (or upgrade) everything on a production k3s cluster with values/values-prod.yaml.
# Same charts as local; see README "Production (k3s VPS)" for the full walkthrough.
#
# Usage:
#   ACME_EMAIL=you@example.com bash scripts/deploy-prod.sh
#   bash scripts/deploy-prod.sh --dry-run      validate everything server-side, change nothing
#
# Steps (all idempotent, safe to re-run for upgrades):
#   1. preflight: tools, kube context (refuses Kind), no placeholders left in values-prod
#   2. ingress-nginx (LoadBalancer via k3s ServiceLB, client IPs preserved)
#   3. cert-manager + a Let's Encrypt ClusterIssuer (HTTP-01 through ingress-nginx)
#   4. Secrets from .env (scripts/create-secrets.sh)
#   5. Helm releases: store, woo-mcp, platform, mcp-notes, mcp-slow
#
# Env: KUBE_CONTEXT (default: current), ACME_EMAIL (required, not for --dry-run),
#      ACME_SERVER (default Let's Encrypt production; use the staging URL to test),
#      VALUES (default values/values-prod.yaml), STORE_NS / PLATFORM_NS / UPSTREAMS_NS,
#      INGRESS_NGINX_VERSION, CERT_MANAGER_VERSION.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALUES="${VALUES:-$ROOT/values/values-prod.yaml}"
KUBE_CONTEXT="${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || true)}"
INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-4.15.1}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.2}"
ACME_SERVER="${ACME_SERVER:-https://acme-v02.api.letsencrypt.org/directory}"
STORE_NS="${STORE_NS:-store}"; PLATFORM_NS="${PLATFORM_NS:-platform}"; UPSTREAMS_NS="${UPSTREAMS_NS:-upstreams}"
DRY_RUN=0; [ "${1:-}" = "--dry-run" ] && DRY_RUN=1

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }
H=(--kube-context "$KUBE_CONTEXT")
[ "$DRY_RUN" = 1 ] && H+=(--dry-run=server)

# Reads a scalar from the values file: value_of global.tls.clusterIssuer
value_of() { node -e 'const {parse}=require(process.argv[1]); let v=parse(require("fs").readFileSync(process.argv[2],"utf8")); for (const k of process.argv[3].split(".")) v=v?.[k]; process.stdout.write(v==null?"":String(v));' "$ROOT/node_modules/yaml" "$VALUES" "$1"; }

preflight() {
  step "Preflight"
  for bin in kubectl helm jq openssl node; do command -v "$bin" >/dev/null || die "$bin not found"; done
  [ -d "$ROOT/node_modules/yaml" ] || die "run 'pnpm install' first (needed to read the values file)"
  [ -n "$KUBE_CONTEXT" ] || die "no kube context (set KUBE_CONTEXT or KUBECONFIG)"
  if [[ "$KUBE_CONTEXT" == kind-* ]] && [ "$DRY_RUN" = 0 ]; then die "context '$KUBE_CONTEXT' is a Kind cluster; use scripts/up-local.sh for local"; fi
  k get --raw /readyz >/dev/null || die "cluster '$KUBE_CONTEXT' is not reachable"
  ok "context $KUBE_CONTEXT reachable"
  # Placeholders must be replaced before a real deploy (a dry run may keep them).
  if grep -nE 'example\.com|your-org' "$VALUES" | grep -vE '^[0-9]+:[[:space:]]*#' >/dev/null; then
    [ "$DRY_RUN" = 1 ] || die "$VALUES still has placeholders (example.com / your-org): set your domain and registry"
    printf '\033[0;33m    ! placeholders kept (dry run)\033[0m\n'
  fi
  [ "$(value_of global.image.tag)" != "latest" ] || die "global.image.tag must be a version, not latest"
  if [ "$DRY_RUN" = 0 ]; then [ -n "${ACME_EMAIL:-}" ] || die "set ACME_EMAIL (Let's Encrypt account contact)"; fi
  ok "values: hub=$(value_of global.hubHost) store=$(value_of global.storeHost) images=$(value_of global.image.registry):$(value_of global.image.tag)"
}

ingress_nginx() {
  step "ingress-nginx $INGRESS_NGINX_VERSION"
  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
  helm repo update ingress-nginx >/dev/null
  # externalTrafficPolicy=Local keeps the real client IP (k3s ServiceLB would SNAT it
  # otherwise), which the gateway's per-IP login rate limit relies on.
  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx "${H[@]}" \
    --namespace ingress-nginx --create-namespace --version "$INGRESS_NGINX_VERSION" \
    --set controller.service.type=LoadBalancer \
    --set controller.service.externalTrafficPolicy=Local \
    --set controller.allowSnippetAnnotations=false \
    --set controller.ingressClassResource.default=true \
    --wait --timeout 10m >/dev/null
  ok "ingress-nginx ready"
}

cert_manager() {
  step "cert-manager $CERT_MANAGER_VERSION"
  helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
  helm repo update jetstack >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager "${H[@]}" \
    --namespace cert-manager --create-namespace --version "$CERT_MANAGER_VERSION" \
    --set crds.enabled=true --wait --timeout 10m >/dev/null
  ok "cert-manager ready"
  local issuer; issuer="$(value_of global.tls.clusterIssuer)"
  [ -n "$issuer" ] || die "global.tls.clusterIssuer is empty in $VALUES"
  if [ "$DRY_RUN" = 1 ]; then
    ok "ClusterIssuer '$issuer' skipped (dry run: the CRD may not exist yet)"
    return
  fi
  k apply -f - >/dev/null <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: $issuer
spec:
  acme:
    server: $ACME_SERVER
    email: $ACME_EMAIL
    privateKeySecretRef: { name: $issuer-account-key }
    solvers:
      - http01:
          ingress:
            ingressClassName: $(value_of global.ingressClassName)
EOF
  ok "ClusterIssuer '$issuer' ($ACME_SERVER)"
}

secrets() {
  step "Secrets"
  if [ "$DRY_RUN" = 1 ]; then
    for ns in "$STORE_NS" "$PLATFORM_NS" "$UPSTREAMS_NS" "${PROVISIONER_NS:-provisioner}"; do k get namespace "$ns" >/dev/null || die "namespace $ns missing (run without --dry-run once, or create it)"; done
    ok "skipped in dry run (namespaces exist)"
    return
  fi
  kubectl config use-context "$KUBE_CONTEXT" >/dev/null # create-secrets.sh uses the current context
  bash "$ROOT/scripts/create-secrets.sh"
}

release() {
  local name="$1" chart="$2" ns="$3"; shift 3
  helm upgrade --install "$name" "$ROOT/charts/$chart" "${H[@]}" --namespace "$ns" -f "$VALUES" "$@" \
    --wait --timeout 15m >/dev/null
  ok "$name ($ns)$([ "$DRY_RUN" = 1 ] && echo ": validated server-side, not applied")"
}

main() {
  preflight
  ingress_nginx
  cert_manager
  secrets
  step "Helm releases"
  release store store "$STORE_NS"
  release woo-mcp woo-mcp "$STORE_NS"
  helm dependency update "$ROOT/charts/platform" >/dev/null
  release platform platform "$PLATFORM_NS"
  release mcp-notes upstream-mcp "$UPSTREAMS_NS" --set instance=notes
  release mcp-slow upstream-mcp "$UPSTREAMS_NS" --set instance=slow
  # Multi-store bonus: renders nothing unless global.stores.enabled.
  release provisioner provisioner "${PROVISIONER_NS:-provisioner}"
  step "Done"
  echo "    Dashboard: https://$(value_of global.hubHost)    Store: https://$(value_of global.storeHost)"
  echo "    Certificates: kubectl get certificate -A   (Ready=True within a few minutes once DNS points here)"
}

main
