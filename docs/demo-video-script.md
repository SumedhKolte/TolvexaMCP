# Demo video script (about 9 minutes)

A tight script for the assignment's required demo video. It covers the six things the
brief lists: design, the definition-of-done flow with two users, Kubernetes, MCP
internals, security, the chat agent, and local-to-VPS. The longer runbook with recovery
tips is [demo-script.md](demo-script.md).

**Format:** screen recording with your voice over it. *Say* lines are what to speak, in
your own words. Aim for calm and plain, not fast.

## Before you record (5 minutes, off camera)

1. `bash scripts/up-local.sh`, then confirm the Servers page shows 3 connected.
2. **User A** = admin (`ADMIN_EMAIL` in `.env`). **User B** = a member: as A, Team →
   Create user, then sign in as B in a private window and create a key named `inspector`.
   Copy B's key to the clipboard; it's shown once.
3. Start MCP Inspector in a terminal: `npx @modelcontextprotocol/inspector@2.8.0`.
4. Open these tabs: the storefront, wp-admin → WooCommerce → Orders, the dashboard as A,
   the dashboard as B (private window), a terminal.
5. Close or hide: `.env`, the Inspector terminal tab (it prints a token), anything that
   shows a Secret value.

## 1. The system in 45 seconds (0:00–0:45)

**Show:** the architecture diagram in the README, or the learning-guide page.

> *Say:* "This is a team gateway for MCP servers, with a WooCommerce store as the first
> data source. An admin registers MCP servers once. Every member then reaches all of them
> through one endpoint, with their own key, from Claude Code or Cursor, or through a chat
> in the dashboard. Nothing talks to the upstream servers directly: both the chat and
> external clients go through the gateway. Everything runs on Kubernetes."

Point at the four layers: store, WooCommerce MCP server (written by me), gateway plus
dashboard, chat agent.

## 2. Store (45 s, 0:45–1:30)

**Show:** storefront → add *Team MCP Mug* → checkout → Cash on delivery → place order.
Then wp-admin → WooCommerce → Orders.

> *Say:* "A guest checks out with cash on delivery, and the order shows up in WooCommerce
> admin, status Processing."

## 3. Chat agent as user A (75 s, 1:30–2:45)

**Show:** dashboard as A → Chat. Type: *Create a product called "Demo Hoodie" priced at
29.99.* Point at the side panel: tool `create_product`, outcome ok, duration.
Refresh the storefront: the product is there. Buy it with COD. Back in Chat: *What orders
came in today?*

> *Say:* "The chat calls tools through the gateway as the logged-in user. The side panel
> shows each tool it called. The product appears on the storefront, and after I place an
> order by hand, the agent finds it."

## 4. External client as user B (90 s, 2:45–4:15)

**Show:** MCP Inspector → Streamable HTTP, URL `http://hub.localtest.me/mcp`, header
`Authorization: Bearer <B's key>` → Connect → List tools. Then call
`woocommerce__list_orders` with `after` = today. Then `notes__create_note` with a summary
of those orders, and `notes__search_notes` to find it.

> *Say:* "B connects with only the gateway URL and their own key. They see tools from
> every enabled server, named server-underscore-underscore-tool, so two servers can both
> have a `list_orders` without colliding. Notice B doesn't see `create_product` or
> `update_order_status`: members can't call those. B's last step uses two upstreams in
> one flow: read today's orders from WooCommerce, then save a note through the notes
> server."

## 5. Team and control (100 s, 4:15–5:55)

**Show, in this order:**
1. As B: My Keys → Revoke key. In Inspector, List tools again: **401**. *Say:* "Revoked
   means rejected on the very next call."
2. As A: Servers → turn off **Enabled** on notes. Inspector: List tools, notes tools are
   gone. Chat as A: ask to save a note; the assistant can't. *Say:* "Disabling a server
   removes its tools from both the chat and external clients." Switch it back on.
3. Terminal: `kubectl -n upstreams delete pod -l app.kubernetes.io/instance=mcp-slow`.
   Servers page → refresh: slow shows **Unreachable**. Inspector: `slow__echo` returns
   `[SERVER_UNREACHABLE]` immediately; `woocommerce__list_products` still works.
   *Say:* "The gateway fails fast on a known-dead server and the others keep working."
4. Audit Log as A: every call above, with user (A or B), source (chat or mcp), tool,
   duration and outcome. Click one row for details.

## 6. Kubernetes (75 s, 5:55–7:10)

**Show in the terminal** (run each, comment briefly):

```bash
kubectl get pods -A
kubectl get pvc -A
kubectl -n store get ingress
kubectl get networkpolicy -A
kubectl -n platform get deploy gateway -o yaml | grep -E -A6 "livenessProbe|readinessProbe|resources:"
```

> *Say:* "Namespaces separate platform, store, upstreams and the provisioner. The store's
> database and WordPress content, the gateway's Postgres, and the notes server each have a
> persistent volume. Only the dashboard, the API and the storefront are exposed through
> Ingress: the WooCommerce MCP server isn't in any Ingress, and a deny-by-default
> NetworkPolicy lets only the gateway reach it. Every workload has readiness and liveness
> probes and resource requests and limits. Secrets are Kubernetes Secrets created from a
> gitignored `.env`, never in the repo."

## 7. MCP internals and security (80 s, 7:10–8:30)

**Show:** the *Life of a tool call* diagram in the learning guide, then Permissions page
and `bash scripts/show-db.sh gateway` (scroll the api_keys and upstreams tables).

> *Say:* "A call goes: client, `/mcp`, API key check, then one function, `dispatch()`.
> It splits the name, checks the server is enabled and reachable, checks the role against
> the permission table, calls with a 10-second timeout, and writes one audit row. The
> chat uses the same function, so the two can't drift apart. Keys are stored as hashes
> and upstream credentials are encrypted with AES-256-GCM. The database shows only
> hashes and ciphertext, and the credentials are never sent to a browser or a client.
> Members can only call what their role allows. If an admin adds a malicious server, its
> credential only ever goes to its own URL, the SSRF guard blocks internal addresses, and
> its tool descriptions are treated as untrusted data."

Optional 20 seconds: `bash scripts/show-db.sh persist` and say "the data lives on the
volumes, not in the pods".

## 8. Local to VPS and upgrades (45 s, 8:30–9:15)

**Show:** `values/values-local.yaml` and `values/values-prod.yaml` side by side, then
`bash scripts/deploy-prod.sh --dry-run`.

> *Say:* "The same Helm charts run locally and on a k3s VPS. Only the values file
> changes: domain, TLS from cert-manager, storage class, replicas, image registry and
> sizes. Upgrades are `helm upgrade` with a new image tag, and rollback is `helm
> rollback`; there's a tested backup and restore for the databases."

## 9. Close (15 s, 9:15–9:30)

> *Say:* "Beyond the core, I built tool permissions, observability with Prometheus
> metrics, security hardening, and multi-store provisioning. The README lists where each
> one lives. Thanks for watching."

## If you need it shorter

Cut section 7's optional part and shorten section 8 to one sentence: about 7 minutes.
