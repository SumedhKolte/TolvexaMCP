#!/usr/bin/env bash
# End-to-end Definition-of-Done run (spec section 19) plus the Phase 7 checks
# (permissions, metrics). Runs against the live deployment and prints PASS/FAIL per step;
# exits non-zero if any step fails.
#
#   bash scripts/e2e-dod.sh
#
# Needs: curl, jq, kubectl (context = the cluster), and the admin login, read from .env
# (ADMIN_EMAIL / ADMIN_PASSWORD) or from E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD. Chat steps
# need the LLM configured (LLM_API_KEY). Secrets are never printed: they go to curl via
# stdin or 0600 files in a private temp dir that is deleted on exit.
#
# Two users, as in the spec: user A = the admin (chat agent, team control), user B = a
# member created for this run (external MCP client). B is disabled again at the end.
# Products, orders and notes created by the run stay in the store as test data.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HUB="${HUB_URL:-http://hub.localtest.me}"
STORE="${STORE_URL:-http://store.localtest.me}"
GW_NS="${GATEWAY_NAMESPACE:-platform}"
UP_NS="${UPSTREAMS_NAMESPACE:-upstreams}"
RUN="$(date -u +%Y%m%d%H%M%S)"
TODAY="$(date -u +%Y-%m-%d)"
W="$(mktemp -d)"

PASSED=0
FAILED=0
pass() { printf '\033[1;32mPASS\033[0m  %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf '\033[1;31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED + 1)); }
section() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
# check "<name>" <command...>: PASS if the command succeeds.
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
die() { fail "$*"; summary; exit 1; }
summary() { printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"; }

for bin in curl jq kubectl; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }; done

# ---------------------------------------------------------------------------- helpers
env_get() { [ -f "$ROOT/.env" ] && { grep -E "^$1=" "$ROOT/.env" || true; } | head -1 | cut -d= -f2-; }
ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-$(env_get ADMIN_EMAIL)}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-$(env_get ADMIN_PASSWORD)}"
[ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ] || { echo "admin credentials not found (.env or E2E_ADMIN_*)" >&2; exit 2; }

# login <email> <password> <cookie-jar>  (password goes through stdin, never argv)
login() {
  E="$1" P="$2" jq -n '{email: env.E, password: env.P}' |
    curl -s -o "$W/login.json" -w '%{http_code}' -c "$3" -H 'content-type: application/json' --data-binary @- "$HUB/api/auth/login"
}
# api <jar> <METHOD> <path> [json]  -> body on stdout, HTTP code in $W/code
api() {
  local jar="$1" m="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -s -o "$W/body" -w '%{http_code}' -b "$jar" -X "$m" -H 'content-type: application/json' --data-binary "$body" "$HUB$path" >"$W/code"
  else
    curl -s -o "$W/body" -w '%{http_code}' -b "$jar" -X "$m" "$HUB$path" >"$W/code"
  fi
  cat "$W/body"
}
code() { cat "$W/code"; }
# mcp_raw <keyfile> <json-rpc body>  -> response body; HTTP code in $W/code; ms in $W/ms
mcp_raw() {
  curl -s --max-time 60 -o "$W/mcp" -w '%{http_code} %{time_total}' -H @"$1" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    --data-binary "$2" "$HUB/mcp" >"$W/meta"
  read -r c t <"$W/meta"; echo "$c" >"$W/code"; awk -v t="$t" 'BEGIN { printf "%d", t * 1000 }' >"$W/ms"
  cat "$W/mcp"
}
mcp_list() { mcp_raw "$1" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq -r '.result.tools[]?.name' | sort; }
mcp_call() { # mcp_call <keyfile> <tool> <json-args>  -> text of the first content item
  mcp_raw "$1" "$(jq -nc --arg n "$2" --argjson a "$3" '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:$n,arguments:$a}}')" |
    jq -r '.result.content[0].text // .error.message // empty'
}
key_header() { printf 'Authorization: Bearer %s\n' "$2" >"$1"; } # key_header <file> <secret>

# chat <jar> <message>  -> SSE events as a JSON array in $W/chat.json
chat() {
  jq -nc --arg m "$2" '{messages: [{role: "user", content: $m}]}' |
    curl -s -N --max-time 150 -b "$1" -H 'content-type: application/json' --data-binary @- "$HUB/api/chat" |
    sed -n 's/^data: //p' | jq -s . >"$W/chat.json"
}
chat_text() { jq -r '[.[] | select(.type == "text") | .delta] | join("")' "$W/chat.json"; }
chat_tool_ok() { jq -e --arg t "$1" 'any(.[]; .type == "tool_result" and .name == $t and .ok)' "$W/chat.json" >/dev/null; }

server_id() { api "$JAR_A" GET /api/servers | jq -r --arg s "$1" '.servers[] | select(.slug == $s) | .id'; }
server_status() { api "$JAR_A" GET /api/servers | jq -r --arg s "$1" '.servers[] | select(.slug == $s) | .status'; }
refresh() { api "$JAR_A" POST "/api/servers/$(server_id "$1")/refresh" >/dev/null; }
# wait_status <slug> <status> <seconds>: force health checks until the dashboard shows it
wait_status() {
  local end=$((SECONDS + $3))
  while [ $SECONDS -lt $end ]; do
    refresh "$1"
    [ "$(server_status "$1")" = "$2" ] && return 0
    sleep 3
  done
  return 1
}

# guest COD checkout through the WooCommerce Store API (what the checkout page uses)
shop_order() {
  local jar="$W/shop.$RANDOM" hd="$W/shop.h"
  curl -s -c "$jar" -b "$jar" -D "$hd" -o /dev/null "$STORE/wp-json/wc/store/v1/cart"
  local nonce; nonce="$(grep -i '^nonce:' "$hd" | tr -d '\r' | awk '{print $2}')"
  curl -s -c "$jar" -b "$jar" -H "Nonce: $nonce" -H 'content-type: application/json' \
    -d "{\"id\":$1,\"quantity\":1}" "$STORE/wp-json/wc/store/v1/cart/add-item" >/dev/null
  local addr='{"first_name":"Dana","last_name":"Shopper","address_1":"1 Demo Road","city":"Austin","state":"TX","postcode":"73301","country":"US","email":"dana.shopper@example.com","phone":"5550142"}'
  curl -s -c "$jar" -b "$jar" -H "Nonce: $nonce" -H 'content-type: application/json' \
    -d "{\"billing_address\":$addr,\"shipping_address\":$addr,\"payment_method\":\"cod\"}" \
    "$STORE/wp-json/wc/store/v1/checkout" | jq -r '.order_id // empty'
}

# ---------------------------------------------------------------------------- cleanup
JAR_A="$W/a.jar"; JAR_B="$W/b.jar"
KEY1="$W/key1.hdr"; KEY2="$W/key2.hdr"
B_ID=""; KEY2_ID=""; NOTES_DISABLED=0; PF_PID=""; A_LOGGED_IN=0
cleanup() {
  [ -n "$PF_PID" ] && { kill "$PF_PID" 2>/dev/null; wait "$PF_PID" 2>/dev/null; }
  if [ "$A_LOGGED_IN" = 1 ]; then
    [ "$NOTES_DISABLED" = 1 ] && api "$JAR_A" POST "/api/servers/$(server_id notes)/enable" >/dev/null
    [ -n "$KEY2_ID" ] && api "$JAR_A" DELETE "/api/keys/$KEY2_ID" >/dev/null
    [ -n "$B_ID" ] && api "$JAR_A" PATCH "/api/users/$B_ID" '{"disabled":true}' >/dev/null
    api "$JAR_A" POST /api/auth/logout >/dev/null
  fi
  rm -rf "$W"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------- preflight
section "0. Preflight"
check "gateway /healthz answers" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $HUB/healthz)\" = 200 ]"
[ "$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$JAR_A")" = 200 ] || die "user A (admin) can log in"
A_LOGGED_IN=1
pass "user A (admin $(jq -r '.user.email' "$W/login.json" | sed 's/^\(..\).*@/\1…@/')) logged in"
for s in woocommerce notes slow; do
  check "server '$s' is connected" wait_status "$s" connected 120
done

# ---------------------------------------------------------------------------- 1. store
section "1. Store (storefront shopper)"
check "storefront loads" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $STORE/)\" = 200 ]"
FIRST_PRODUCT="$(curl -s "$STORE/wp-json/wc/store/v1/products?per_page=1" | jq -r '.[0].id // empty')"
O1="$(shop_order "$FIRST_PRODUCT")"
check "add to cart + COD checkout creates an order (#${O1:-none})" test -n "$O1"

# WooCommerce admin data comes from the WooCommerce REST API (what wp-admin shows),
# read here through the gateway with a short-lived admin key.
ADMIN_KEY="$W/admin.hdr"
ADMIN_KEY_ID=""
if api "$JAR_A" POST /api/keys "{\"name\":\"e2e-admin-$RUN\"}" >/dev/null && [ "$(code)" = 201 ]; then
  key_header "$ADMIN_KEY" "$(jq -r '.secret' "$W/body")"
  ADMIN_KEY_ID="$(jq -r '.key.id' "$W/body")"
fi
ORDER_STATUS="$(mcp_call "$ADMIN_KEY" woocommerce__get_order "{\"id\":${O1:-0}}" | jq -r '.status // empty' 2>/dev/null)"
check "order #$O1 is in WooCommerce admin (status: ${ORDER_STATUS:-missing})" test "$ORDER_STATUS" = processing
[ -n "$ADMIN_KEY_ID" ] && api "$JAR_A" DELETE "/api/keys/$ADMIN_KEY_ID" >/dev/null

# ---------------------------------------------------------------------------- 2. chat
section "2. Chat agent (user A)"
CHAT_OK=0
api "$JAR_A" GET /api/chat/status >/dev/null
if jq -e '.available' "$W/body" >/dev/null; then
  pass "chat is configured (masking: $(jq -r '.masking' "$W/body"))"
  CHAT_OK=1
else
  fail "chat is configured: $(jq -r '.reason // "unknown"' "$W/body")"
fi

PNAME="E2E Widget $RUN"
PID=""
if [ "$CHAT_OK" = 1 ]; then
  for attempt in 1 2; do
    chat "$JAR_A" "Create a product called \"$PNAME\" priced at 7.50 in the main store (woocommerce__create_product)."
    chat_tool_ok woocommerce__create_product && break
    sleep 20 # free-tier rate limits: give the provider a moment before retrying
  done
  check "chat called woocommerce__create_product" chat_tool_ok woocommerce__create_product
  PID="$(curl -s "$STORE/wp-json/wc/store/v1/products?search=$(jq -rn --arg s "$PNAME" '$s|@uri')" | jq -r --arg n "$PNAME" '.[] | select(.name == $n) | .id' | head -1)"
  check "\"$PNAME\" is on the storefront (product ${PID:-missing})" test -n "$PID"
  PLINK="$(curl -s "$STORE/wp-json/wc/store/v1/products/${PID:-0}" | jq -r '.permalink // empty')"
  check "its product page loads" bash -c "[ -n '$PLINK' ] && [ \"\$(curl -s -o /dev/null -w '%{http_code}' '$PLINK')\" = 200 ]"
fi
O2="$( [ -n "$PID" ] && shop_order "$PID" )"
check "shopper orders it by hand (COD) -> order #${O2:-none}" test -n "$O2"

if [ "$CHAT_OK" = 1 ] && [ -n "$O2" ]; then
  for attempt in 1 2; do
    chat "$JAR_A" "What orders came in today in the main store? List each order number."
    chat_tool_ok woocommerce__list_orders && chat_text | grep -q "$O2" && break
    sleep 20
  done
  check "chat called woocommerce__list_orders" chat_tool_ok woocommerce__list_orders
  check "chat answer includes order #$O2" bash -c "jq -r '[.[] | select(.type == \"text\") | .delta] | join(\"\")' '$W/chat.json' | grep -q '$O2'"
fi

# ---------------------------------------------------------------------------- 3. external client
section "3. External MCP client (user B, member)"
B_EMAIL="e2e-member-$RUN@hub.localtest.me"
api "$JAR_A" POST /api/users "{\"email\":\"$B_EMAIL\",\"role\":\"member\"}" >/dev/null
B_ID="$(jq -r '.user.id // empty' "$W/body")"
B_PW_FILE="$W/b.pw"; jq -r '.initial_password // empty' "$W/body" >"$B_PW_FILE"
check "admin creates user B ($B_EMAIL)" test -n "$B_ID"
check "user B logs in" test "$(login "$B_EMAIL" "$(cat "$B_PW_FILE")" "$JAR_B")" = 200
api "$JAR_B" POST /api/keys "{\"name\":\"inspector-$RUN\"}" >/dev/null
KEY1_ID="$(jq -r '.key.id // empty' "$W/body")"
key_header "$KEY1" "$(jq -r '.secret // empty' "$W/body")"
check "user B creates an API key (shown once)" test -n "$KEY1_ID"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e-dod","version":"1"}}}'
SERVER_NAME="$(mcp_raw "$KEY1" "$INIT" | jq -r '.result.serverInfo.name // empty')"
check "MCP initialize with only the URL and B's key (server: ${SERVER_NAME:-none})" test -n "$SERVER_NAME"
mcp_list "$KEY1" >"$W/b-tools"
for s in woocommerce notes slow; do
  check "tools/list has $s tools ($(grep -c "^${s}__" "$W/b-tools") tools)" grep -q "^${s}__" "$W/b-tools"
done
for t in woocommerce__create_product woocommerce__update_order_status slow__crash; do
  check "restricted tool $t is hidden from B" bash -c "! grep -qx '$t' '$W/b-tools'"
done
check "restricted tool called directly -> FORBIDDEN" bash -c "[[ \"\$(cat)\" == '[FORBIDDEN]'* ]]" < <(mcp_call "$KEY1" woocommerce__update_order_status '{"id":1,"status":"completed"}')

ORDERS="$(mcp_call "$KEY1" woocommerce__list_orders "{\"after\":\"${TODAY}T00:00:00Z\"}")"
check "B: today's orders include #${O2:-$O1}" bash -c "jq -e --argjson id '${O2:-${O1:-0}}' 'any(.orders[]; .id == \$id)' >/dev/null" <<<"$ORDERS"
SUMMARY="$(jq -r '"Orders on '"$TODAY"': " + ([.orders[] | "#\(.id) \(.status) \(.total) \(.currency)"] | join(", "))' <<<"$ORDERS" 2>/dev/null)"
NOTE_TITLE="E2E orders $RUN"
NOTE="$(mcp_call "$KEY1" notes__create_note "$(jq -nc --arg t "$NOTE_TITLE" --arg b "$SUMMARY" '{title: $t, body: $b}')")"
check "two upstreams in one flow: woocommerce orders saved via notes__create_note" bash -c "jq -e '.id' >/dev/null" <<<"$NOTE"
FOUND="$(mcp_call "$KEY1" notes__search_notes "$(jq -nc --arg q "$RUN" '{query: $q}')")"
check "the note is found again with notes__search_notes" grep -q "$NOTE_TITLE" <<<"$FOUND"

# ---------------------------------------------------------------------------- 4. control
section "4. Team and control"
api "$JAR_B" DELETE "/api/keys/$KEY1_ID" >/dev/null
mcp_raw "$KEY1" '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' >"$W/revoked"
check "revoked key -> next call is 401 ($(jq -r '.error.message // .error // empty' "$W/revoked" 2>/dev/null | head -c 60))" test "$(code)" = 401

api "$JAR_B" POST /api/keys "{\"name\":\"cursor-$RUN\"}" >/dev/null
KEY2_ID="$(jq -r '.key.id // empty' "$W/body")"
key_header "$KEY2" "$(jq -r '.secret // empty' "$W/body")"
check "B creates a new key" test -n "$KEY2_ID"

NOTES_ID="$(server_id notes)"
api "$JAR_A" POST "/api/servers/$NOTES_ID/disable" >/dev/null && NOTES_DISABLED=1
check "admin disables the notes server" test "$(server_status notes)" = disabled
# "gone" must not pass on an empty or failed listing: woocommerce tools must still be there.
only_without_notes() { local t; t="$(cat)"; grep -q '^woocommerce__' <<<"$t" && ! grep -q '^notes__' <<<"$t"; }
check "notes tools gone from the external client (tools/list)" only_without_notes < <(mcp_list "$KEY2")
check "notes tools gone from the chat agent's tool list (A)" only_without_notes < <(api "$JAR_A" GET /api/tools | jq -r '.tools[].name')
check "calling a notes tool -> SERVER_DISABLED" bash -c "[[ \"\$(cat)\" == '[SERVER_DISABLED]'* ]]" < <(mcp_call "$KEY2" notes__list_notes '{}')
api "$JAR_A" POST "/api/servers/$NOTES_ID/enable" >/dev/null && NOTES_DISABLED=0
check "notes re-enabled and connected" wait_status notes connected 60
check "notes tools are back for the external client" grep -q '^notes__' < <(mcp_list "$KEY2")

kubectl -n "$UP_NS" delete pod -l app.kubernetes.io/instance=mcp-slow --wait=false >/dev/null 2>&1
check "killed the slow server's pod" test $? -eq 0
check "dashboard shows slow as unreachable" wait_status slow unreachable 45
MSG="$(mcp_call "$KEY2" slow__echo '{"message":"hi"}')"
MS="$(cat "$W/ms")"
check "call to the dead upstream fails fast with SERVER_UNREACHABLE (${MS} ms)" bash -c "[[ '$MSG' == '[SERVER_UNREACHABLE]'* ]] && [ '$MS' -lt 2000 ]"
check "woocommerce keeps working while slow is down" bash -c "jq -e '.products' >/dev/null" < <(mcp_call "$KEY2" woocommerce__list_products '{"per_page":1}')
check "slow recovers and shows connected again" wait_status slow connected 150

# ---------------------------------------------------------------------------- 5. permissions + metrics
section "5. Permissions editor and metrics (Phase 7)"
api "$JAR_B" PUT /api/permissions/notes__create_note '{"member":false}' >/dev/null
check "a member can't edit permissions (403)" test "$(code)" = 403
api "$JAR_A" PUT /api/permissions/notes__create_note '{"member":false}' >/dev/null
check "admin makes notes__create_note admin-only" test "$(code)" = 200
check "it disappears from B's tools/list at once" bash -c "t=\$(cat); grep -q '^notes__list_notes' <<<\"\$t\" && ! grep -qx notes__create_note <<<\"\$t\"" < <(mcp_list "$KEY2")
check "and is rejected when B calls it directly (FORBIDDEN)" bash -c "[[ \"\$(cat)\" == '[FORBIDDEN]'* ]]" < <(mcp_call "$KEY2" notes__create_note '{"title":"x","body":"y"}')
api "$JAR_A" DELETE /api/permissions/notes__create_note >/dev/null
check "reset to default: B sees it again" grep -qx notes__create_note < <(mcp_list "$KEY2")

STATS="$(api "$JAR_A" GET /api/audit/stats)"
check "audit stats: per-server error rate and avg latency for the last hour" bash -c "jq -e '.servers | any(.server == \"woocommerce\" and .calls > 0 and (.avg_latency_ms | type) == \"number\")' >/dev/null" <<<"$STATS"

kubectl -n "$GW_NS" port-forward svc/gateway 19090:9090 >/dev/null 2>&1 &
PF_PID=$!
for _ in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:19090/metrics && break; sleep 0.5; done
curl -s http://127.0.0.1:19090/metrics >"$W/metrics"
check "/metrics: tool call counters" grep -Eq '^mcp_gateway_tool_calls_total\{server="woocommerce",tool="woocommerce__list_orders",outcome="ok"\} [1-9]' "$W/metrics"
check "/metrics: duration histogram" grep -Eq '^mcp_gateway_tool_call_duration_seconds_count\{server="woocommerce"\} [1-9]' "$W/metrics"
check "/metrics: errors by code" grep -Eq '^mcp_gateway_tool_errors_total\{code="FORBIDDEN"\} [1-9]' "$W/metrics"
check "/metrics: upstream status gauges" bash -c "grep -Eq '^mcp_gateway_upstream_up\{server=\"woocommerce\"\} 1' '$W/metrics' && grep -Eq '^mcp_gateway_upstream_up\{server=\"slow\"\} [01]' '$W/metrics'"
kill "$PF_PID" 2>/dev/null; wait "$PF_PID" 2>/dev/null; PF_PID=""
check "/metrics is not reachable through the Ingress" bash -c "! curl -s $HUB/metrics | grep -q mcp_gateway_"

# ---------------------------------------------------------------------------- 6. audit
section "6. Audit log attribution"
api "$JAR_A" GET "/api/audit?userId=$B_ID&limit=200" >"$W/audit-b"
has_row() { jq -e --arg t "$2" --arg o "$3" --arg s "$4" 'any(.items[]; .tool == $t and .outcome == $o and .source == $s)' "$1" >/dev/null; }
check "B: list_orders ok (mcp)" has_row "$W/audit-b" woocommerce__list_orders ok mcp
check "B: create_note ok (mcp)" has_row "$W/audit-b" notes__create_note ok mcp
check "B: update_order_status denied (mcp)" has_row "$W/audit-b" woocommerce__update_order_status denied mcp
check "B: notes call while disabled -> disabled (mcp)" has_row "$W/audit-b" notes__list_notes disabled mcp
check "B: slow__echo unreachable (mcp)" has_row "$W/audit-b" slow__echo unreachable mcp
check "every B row is attributed to B" bash -c "jq -e --arg e '$B_EMAIL' '(.items | length) > 0 and all(.items[]; .userEmail == \$e)' >/dev/null" <"$W/audit-b"
if [ "$CHAT_OK" = 1 ]; then
  A_ID="$(api "$JAR_A" GET /api/me | jq -r '.user.id')"
  api "$JAR_A" GET "/api/audit?userId=$A_ID&limit=200" >"$W/audit-a"
  check "A: create_product ok (chat)" has_row "$W/audit-a" woocommerce__create_product ok chat
  check "A: list_orders ok (chat)" has_row "$W/audit-a" woocommerce__list_orders ok chat
fi
api "$JAR_B" GET "/api/audit?limit=200" >"$W/audit-b-own"
check "B sees only their own audit entries" bash -c "jq -e --arg e '$B_EMAIL' 'all(.items[]; .userEmail == \$e)' >/dev/null" <"$W/audit-b-own"

summary
[ "$FAILED" -eq 0 ]
