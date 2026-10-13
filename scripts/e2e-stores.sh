#!/usr/bin/env bash
# End-to-end check of multi-store provisioning (bonus, spec section 21). Prints PASS/FAIL
# per step; exits non-zero on any failure.
#
#   bash scripts/e2e-stores.sh [name-a] [name-b]     default: alpha beta
#
# 1. Creates (or reuses) two stores through the API and waits until both are Ready.
# 2. Checks each one: namespace, quota, storefront, its own tools via the gateway.
# 3. Places one COD order on each storefront.
# 4. Asks the chat agent to compare today's orders across the two stores.
# 5. Deletes the second store and checks that its tools, server and namespace are gone.
#
# Needs: curl, jq, kubectl, the admin login in .env, and LLM_API_KEY for step 4.
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HUB="${HUB_URL:-http://hub.localtest.me}"
A="${1:-alpha}"; B="${2:-beta}"
TODAY="$(date -u +%Y-%m-%d)"
W="$(mktemp -d)"
trap 'curl -s -o /dev/null -b "$W/jar" -X POST "$HUB/api/auth/logout" 2>/dev/null; rm -rf "$W"' EXIT

PASSED=0; FAILED=0
pass() { printf '\033[1;32mPASS\033[0m  %s\n' "$*"; PASSED=$((PASSED + 1)); }
fail() { printf '\033[1;31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED + 1)); }
check() { local n="$1"; shift; if "$@"; then pass "$n"; else fail "$n"; fi; }
section() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
env_get() { { grep -E "^$1=" "$ROOT/.env" || true; } | head -1 | cut -d= -f2-; }
api() { curl -s -b "$W/jar" "$@"; }

E="$(env_get ADMIN_EMAIL)" P="$(env_get ADMIN_PASSWORD)" jq -n '{email: env.E, password: env.P}' |
  curl -s -o /dev/null -w '%{http_code}' -c "$W/jar" -H 'content-type: application/json' --data-binary @- "$HUB/api/auth/login" >"$W/code"
[ "$(cat "$W/code")" = 200 ] || { fail "admin login"; exit 1; }

store_json() { api "$HUB/api/stores" | jq -c --arg s "store-$1" '.stores[] | select(.slug == $s)'; }
store_field() { store_json "$1" | jq -r ".$2 // empty"; }

# Guest COD checkout on a storefront (WooCommerce Store API, as the checkout page does).
shop_order() {
  local base="$1" jar="$W/shop.$RANDOM" hd="$W/shop.h" pid
  pid="$(curl -s "$base/wp-json/wc/store/v1/products?per_page=1" | jq -r '.[0].id // empty')"
  [ -n "$pid" ] || return 1
  curl -s -c "$jar" -b "$jar" -D "$hd" -o /dev/null "$base/wp-json/wc/store/v1/cart"
  local nonce; nonce="$(grep -i '^nonce:' "$hd" | tr -d '\r' | awk '{print $2}')"
  curl -s -c "$jar" -b "$jar" -H "Nonce: $nonce" -H 'content-type: application/json' -d "{\"id\":$pid,\"quantity\":$2}" "$base/wp-json/wc/store/v1/cart/add-item" >/dev/null
  local addr='{"first_name":"Sam","last_name":"Buyer","address_1":"2 Test Ave","city":"Austin","state":"TX","postcode":"73301","country":"US","email":"sam.buyer@example.com","phone":"5550188"}'
  curl -s -c "$jar" -b "$jar" -H "Nonce: $nonce" -H 'content-type: application/json' \
    -d "{\"billing_address\":$addr,\"shipping_address\":$addr,\"payment_method\":\"cod\"}" "$base/wp-json/wc/store/v1/checkout" | jq -r '.order_id // empty'
}

section "1. Create two stores and wait until they're ready"
for n in "$A" "$B"; do
  code="$(curl -s -o "$W/created" -w '%{http_code}' -b "$W/jar" -H 'content-type: application/json' -d "{\"name\":\"$n\"}" "$HUB/api/stores")"
  check "create store-$n (HTTP $code: $(jq -r '.store.status // .error.message' "$W/created"))" bash -c "[[ '$code' == 20[02] ]]"
done
again="$(curl -s -o /dev/null -w '%{http_code}' -b "$W/jar" -H 'content-type: application/json' -d "{\"name\":\"$A\"}" "$HUB/api/stores")"
check "creating store-$A again is a no-op (HTTP $again, still one store)" bash -c "[ '$again' = 200 ] && [ \"\$(curl -s -b '$W/jar' '$HUB/api/stores' | jq '[.stores[] | select(.slug == \"store-$A\")] | length')\" = 1 ]"
end=$((SECONDS + 1200))
while [ $SECONDS -lt $end ]; do
  sa="$(store_field "$A" status)"; sb="$(store_field "$B" status)"
  [[ "$sa" != provisioning && "$sb" != provisioning ]] && break
  sleep 10
done
for n in "$A" "$B"; do
  check "store-$n is ready ($(store_field "$n" status) $(store_field "$n" status_reason))" test "$(store_field "$n" status)" = ready
done

section "2. Each store is a separate, capped namespace with its own tools"
for n in "$A" "$B"; do
  ns="store-$n"
  check "namespace $ns is labelled a store, Pod Security restricted" bash -c "kubectl get ns $ns -o json | jq -e '.metadata.labels[\"team-mcp/tenant\"] == \"true\" and .metadata.labels[\"pod-security.kubernetes.io/enforce\"] == \"restricted\"' >/dev/null"
  check "$ns has a ResourceQuota and a LimitRange" bash -c "kubectl -n $ns get resourcequota store-quota >/dev/null && kubectl -n $ns get limitrange store-limits >/dev/null"
  check "$ns has deny-by-default NetworkPolicies" bash -c "kubectl -n $ns get networkpolicy default-deny-all >/dev/null"
  url="$(store_field "$n" url)"
  check "storefront $url loads" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $url/)\" = 200 ]"
done
api "$HUB/api/tools" | jq -r '.tools[].name' >"$W/tools"
for n in "$A" "$B"; do
  check "gateway lists store-${n}__list_orders" grep -qx "store-${n}__list_orders" "$W/tools"
done

section "3. One COD order on each storefront"
OA="$(shop_order "$(store_field "$A" url)" 1)"; check "order #$OA on store-$A" test -n "$OA"
OB="$(shop_order "$(store_field "$B" url)" 2)"; check "order #$OB on store-$B" test -n "$OB"

section "4. Chat: compare today's orders across the two stores"
if api "$HUB/api/chat/status" | jq -e '.available' >/dev/null; then
  for attempt in 1 2; do
    jq -nc --arg m "Compare today's orders between store-$A and store-$B: for each store, list the order numbers and totals." '{messages: [{role: "user", content: $m}]}' |
      curl -s -N --max-time 150 -b "$W/jar" -H 'content-type: application/json' --data-binary @- "$HUB/api/chat" | sed -n 's/^data: //p' | jq -s . >"$W/chat.json"
    # Done when both stores' tools ran and the model produced an answer (a provider
    # error, e.g. a rate limit right after the tool calls, leaves the text empty: retry).
    jq -e --arg a "store-${A}__list_orders" --arg b "store-${B}__list_orders" \
      '(any(.[]; .type == "tool_result" and .name == $a and .ok)) and (any(.[]; .type == "tool_result" and .name == $b and .ok))
       and ([.[] | select(.type == "text") | .delta] | join("") | length > 0)' "$W/chat.json" >/dev/null && break
    printf '      (attempt %s: %s; retrying)\n' "$attempt" "$(jq -r '[.[] | select(.type == "error") | .message] | first // "no answer text"' "$W/chat.json")"
    sleep 30
  done
  check "chat called store-${A}__list_orders and store-${B}__list_orders" bash -c "jq -e --arg a 'store-${A}__list_orders' --arg b 'store-${B}__list_orders' \
    '(any(.[]; .type == \"tool_result\" and .name == \$a and .ok)) and (any(.[]; .type == \"tool_result\" and .name == \$b and .ok))' '$W/chat.json' >/dev/null"
  # Models often write non-breaking hyphens (U+2011); normalise before matching names.
  answer="$(jq -r '[.[] | select(.type == "text") | .delta] | join("") | gsub("\u2011|\u2010|\u2013"; "-")' "$W/chat.json")"
  check "the answer covers both stores and their orders (#$OA, #$OB)" bash -c 'a="$1"; grep -qi "store-$2" <<<"$a" && grep -qi "store-$3" <<<"$a" && grep -q "$4" <<<"$a" && grep -q "$5" <<<"$a"' _ "$answer" "$A" "$B" "$OA" "$OB"
  printf '      chat answer: %s\n' "$(tr '\n' ' ' <<<"$answer" | cut -c1-300)"
else
  fail "chat is not configured (LLM_API_KEY)"
fi

section "5. Delete store-$B: tools first, then the namespace"
ID="$(store_field "$B" id)"
check "delete accepted (202)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -b '$W/jar' -X DELETE '$HUB/api/stores/$ID')\" = 202 ]"
gone_tools() { ! api "$HUB/api/tools" | jq -r '.tools[].name' | grep -q "^store-${B}__"; }
end=$((SECONDS + 60)); until gone_tools || [ $SECONDS -ge $end ]; do sleep 2; done
check "store-${B}__* tools are gone from the gateway" gone_tools
check "its server registration is gone" bash -c "! curl -s -b '$W/jar' '$HUB/api/servers' | jq -e '.servers[] | select(.slug == \"store-$B\")' >/dev/null"
end=$((SECONDS + 600)); until ! kubectl get ns "store-$B" >/dev/null 2>&1 || [ $SECONDS -ge $end ]; do sleep 5; done
check "namespace store-$B is gone" bash -c "! kubectl get ns store-$B >/dev/null 2>&1"
end=$((SECONDS + 60)); until [ -z "$(store_json "$B")" ] || [ $SECONDS -ge $end ]; do sleep 3; done
check "store-$B is no longer listed" test -z "$(store_json "$B")"
check "store-$A is untouched (ready, tools listed)" bash -c "[ \"\$(curl -s -b '$W/jar' '$HUB/api/stores' | jq -r '.stores[] | select(.slug == \"store-$A\") | .status')\" = ready ] && curl -s -b '$W/jar' '$HUB/api/tools' | jq -r '.tools[].name' | grep -qx 'store-${A}__list_orders'"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
