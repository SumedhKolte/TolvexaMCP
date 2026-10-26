#!/usr/bin/env bash
# A safe, readable tour of the databases, for demos and reviews.
#
#   bash scripts/show-db.sh              everything below
#   bash scripts/show-db.sh gateway      the gateway's Postgres: users, keys, servers, audit...
#   bash scripts/show-db.sh store        the shop's MariaDB: products and orders
#   bash scripts/show-db.sh volumes      the persistent volumes and what mounts them
#   bash scripts/show-db.sh persist      kill the database pods, then prove the data survived
#
# Read-only except `persist`, which restarts pods (Kind clusters only). Nothing secret is
# printed: passwords and API keys appear only as hash prefixes, upstream credentials only
# as a length and a few ciphertext bytes. That is the point: it shows what is *stored*.
set -uo pipefail

PLATFORM_NS="${PLATFORM_NS:-platform}"
STORE_NS="${STORE_NS:-store}"
SECTION="${1:-all}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
head1() { printf '\n\033[1;36m━━━ %s ━━━\033[0m\n' "$*"; }
note() { printf '\033[2m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v kubectl >/dev/null || die "kubectl not found"

# pg <sql> : run SQL in the gateway's Postgres (aligned table output)
pg() {
  kubectl -n "$PLATFORM_NS" exec -i deploy/postgres -c postgres -- \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -P border=2 -v ON_ERROR_STOP=1' <<<"$1" 2>&1 | grep -v '^$'
}
# pg1 <sql> : one bare value
pg1() {
  kubectl -n "$PLATFORM_NS" exec -i deploy/postgres -c postgres -- \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<<"$1" 2>/dev/null
}
# my <sql> : run SQL in the shop's MariaDB (password read inside the pod, never shown)
my() {
  kubectl -n "$STORE_NS" exec -i deploy/mariadb -c mariadb -- \
    sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -t "$MARIADB_DATABASE"' <<<"$1" 2>&1 | grep -v '^$'
}
my1() {
  kubectl -n "$STORE_NS" exec -i deploy/mariadb -c mariadb -- \
    sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot -N "$MARIADB_DATABASE"' <<<"$1" 2>/dev/null
}

gateway() {
  head1 "Gateway database (Postgres): what the gateway remembers"
  bold "Tables and row counts"
  pg "SELECT * FROM (
        SELECT 'users' AS \"table\", count(*) AS rows, 'accounts and roles' AS holds FROM users
        UNION ALL SELECT 'sessions', count(*), 'dashboard logins (HMAC ids only)' FROM sessions
        UNION ALL SELECT 'api_keys', count(*), 'members'' keys (hashes only)' FROM api_keys
        UNION ALL SELECT 'upstreams', count(*), 'registered MCP servers (credentials encrypted)' FROM upstreams
        UNION ALL SELECT 'tool_permissions', count(*), 'which roles may call which tool' FROM tool_permissions
        UNION ALL SELECT 'audit_log', count(*), 'every tool call, one row each' FROM audit_log
        UNION ALL SELECT 'stores', count(*), 'extra stores (bonus)' FROM stores
        UNION ALL SELECT 'login_failures', count(*), 'rate-limit counters' FROM login_failures
      ) t ORDER BY 1;"

  bold "users: passwords are argon2id hashes, never the password"
  pg "SELECT email, role, left(password_hash, 30) || '…' AS password_hash, (disabled_at IS NOT NULL) AS disabled FROM users ORDER BY created_at;"

  bold "api_keys: only a SHA-256 hash is stored; the full key was shown once"
  pg "SELECT k.name, u.email AS owner, k.prefix, left(k.key_hash, 16) || '…' AS sha256, k.revoked_at IS NOT NULL AS revoked, k.last_used_at::timestamp(0) AS last_used
      FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC LIMIT 8;"

  bold "upstreams: the credential is AES-256-GCM ciphertext (length + first bytes only)"
  pg "SELECT slug, url, cred_type, enabled, builtin,
             length(cred_encrypted) AS cred_bytes,
             encode(substring(cred_encrypted from 1 for 6), 'hex') || '…' AS ciphertext_prefix
      FROM upstreams ORDER BY builtin DESC, slug;"

  bold "tool_permissions: the per-role policy the gateway enforces on every call"
  pg "SELECT tool_name, array_to_string(allowed_roles, ', ') AS allowed_roles FROM tool_permissions ORDER BY tool_name;"

  bold "audit_log: the 8 most recent tool calls, attributed to a user and a source"
  pg "SELECT a.ts::timestamp(0) AS time, coalesce(u.email, '(deleted user)') AS user, a.source, a.tool, a.outcome, coalesce(a.error_code, '') AS error, a.duration_ms AS ms
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.ts DESC LIMIT 8;"

  bold "audit_log: outcomes so far"
  pg "SELECT outcome, count(*) AS calls, round(avg(duration_ms)) AS avg_ms FROM audit_log GROUP BY outcome ORDER BY calls DESC;"
}

store() {
  head1 "Store database (MariaDB): the WooCommerce shop"
  bold "Products"
  my "SELECT p.ID AS id, p.post_title AS name, m.meta_value AS price, p.post_status AS status
      FROM wp_posts p LEFT JOIN wp_postmeta m ON m.post_id = p.ID AND m.meta_key = '_price'
      WHERE p.post_type = 'product' AND p.post_status IN ('publish','draft') ORDER BY p.ID DESC LIMIT 8;"
  bold "Orders (city only: customer names, emails and street addresses stay out of this view)"
  # WooCommerce stores orders in its own tables (HPOS: wp_wc_orders), not in wp_posts.
  my "SELECT o.id, o.status, ROUND(o.total_amount, 2) AS total, o.currency, a.city, o.date_created_gmt AS created_utc
      FROM wp_wc_orders o
      LEFT JOIN wp_wc_order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
      WHERE o.type = 'shop_order' ORDER BY o.id DESC LIMIT 8;"
  bold "Table sizes"
  my "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tables,
             (SELECT COUNT(*) FROM wp_posts WHERE post_type = 'product') AS products,
             (SELECT COUNT(*) FROM wp_wc_orders WHERE type = 'shop_order') AS orders,
             (SELECT COUNT(*) FROM wp_options) AS options,
             (SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) FROM information_schema.tables WHERE table_schema = DATABASE()) AS size_mb;"
}

volumes() {
  head1 "Persistent storage: where the data physically lives"
  kubectl get pvc -A -o custom-columns='NAMESPACE:.metadata.namespace,CLAIM:.metadata.name,STATUS:.status.phase,SIZE:.status.capacity.storage,CLASS:.spec.storageClassName' 2>&1 | grep -v '^$'
  bold "Which pod mounts which claim"
  for spec in "$PLATFORM_NS postgres" "$STORE_NS mariadb" "$STORE_NS wordpress" "upstreams mcp-notes"; do
    set -- $spec
    printf '  %-10s %-10s -> ' "$1" "$2"
    kubectl -n "$1" get deploy "$2" -o json 2>/dev/null |
      jq -r '[.spec.template.spec.volumes[]? | select(.persistentVolumeClaim) | "\(.name) = \(.persistentVolumeClaim.claimName)"] | if length == 0 then "-" else join(", ") end' 2>/dev/null || echo "-"
  done
  note "PVCs of the main store and the gateway are kept on 'helm uninstall' (helm.sh/resource-policy: keep)."
}

# Counts that must be identical before and after the pods are killed.
snapshot() {
  printf 'gateway: %s\n' "$(pg1 "SELECT (SELECT count(*) FROM users) || ' users, ' || (SELECT count(*) FROM upstreams) || ' servers, ' || (SELECT count(*) FROM api_keys) || ' keys, ' || (SELECT count(*) FROM tool_permissions) || ' permission rules, ' || (SELECT count(*) FROM audit_log) || ' audit rows'")"
  printf 'shop:    %s\n' "$(my1 "SELECT CONCAT((SELECT COUNT(*) FROM wp_posts WHERE post_type='product'), ' products, ', (SELECT COUNT(*) FROM wp_wc_orders WHERE type='shop_order'), ' orders, ', (SELECT COUNT(*) FROM wp_options), ' settings')")"
  printf 'notes:   %s\n' "$(kubectl -n upstreams exec deploy/mcp-notes -- sh -c 'if [ -f /data/notes.json ]; then wc -c < /data/notes.json | tr -d " "; else echo 0; fi' 2>/dev/null) bytes in /data/notes.json"
}

persist() {
  ctx="$(kubectl config current-context 2>/dev/null)"
  [[ "$ctx" == kind-* ]] || die "persist restarts database pods; it only runs on a Kind cluster (context is '$ctx')"
  head1 "Persistence proof: kill the databases, then check the data"
  bold "Before"
  snapshot >"/tmp/show-db-before.$$"; cat "/tmp/show-db-before.$$"

  targets=("$PLATFORM_NS:postgres" "$STORE_NS:mariadb" "upstreams:mcp-notes")
  declare -a old_pods=()
  for t in "${targets[@]}"; do
    ns="${t%%:*}"; app="${t##*:}"
    old_pods+=("$(kubectl -n "$ns" get pod -l "app.kubernetes.io/name=$app" -o jsonpath='{.items[0].metadata.name}')")
  done
  bold "Deleting the pods at $(date +%T): ${old_pods[*]}"
  i=0
  for t in "${targets[@]}"; do
    kubectl -n "${t%%:*}" delete pod "${old_pods[$i]}" --wait=false >/dev/null; i=$((i + 1))
  done
  # The old pods must be fully gone, otherwise the "after" numbers could come from them.
  i=0
  for t in "${targets[@]}"; do
    kubectl -n "${t%%:*}" wait --for=delete "pod/${old_pods[$i]}" --timeout=120s >/dev/null 2>&1 || die "old pod ${old_pods[$i]} did not terminate"
    i=$((i + 1))
  done
  echo "old pods are gone at $(date +%T); waiting for their replacements"
  i=0
  for t in "${targets[@]}"; do
    ns="${t%%:*}"; app="${t##*:}"
    kubectl -n "$ns" rollout status "deploy/$app" --timeout=240s >/dev/null || die "$app did not come back"
    new="$(kubectl -n "$ns" get pod -l "app.kubernetes.io/name=$app" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
    [ "$new" != "${old_pods[$i]}" ] || die "$app is still the same pod (${old_pods[$i]}); the proof would be meaningless"
    printf '  %-9s %s  ->  %s\n' "$app" "${old_pods[$i]}" "$new"
    i=$((i + 1))
  done
  echo "all new pods are ready at $(date +%T)"
  bold "After"
  snapshot >"/tmp/show-db-after.$$"; cat "/tmp/show-db-after.$$"
  echo
  if diff -q "/tmp/show-db-before.$$" "/tmp/show-db-after.$$" >/dev/null; then
    printf '\033[1;32mPASS\033[0m  new pods, identical data: it lives on the volumes, not in the pods\n'
    rm -f "/tmp/show-db-before.$$" "/tmp/show-db-after.$$"
  else
    printf '\033[1;31mFAIL\033[0m  the counts differ:\n'; diff "/tmp/show-db-before.$$" "/tmp/show-db-after.$$"
    rm -f "/tmp/show-db-before.$$" "/tmp/show-db-after.$$"; exit 1
  fi
}

case "$SECTION" in
  all) gateway; store; volumes ;;
  gateway) gateway ;;
  store) store ;;
  volumes) volumes ;;
  persist) persist ;;
  *) die "usage: show-db.sh [all|gateway|store|volumes|persist]" ;;
esac
