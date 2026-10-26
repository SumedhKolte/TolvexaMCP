# Demo script

A live walkthrough of the definition of done (spec section 19) with two users, in about
15–20 minutes. Every step is also automated: `bash scripts/e2e-dod.sh` checks the same
things (62 steps) and is a good rehearsal right before the demo. Each step below names
its e2e section.

## Before the demo (5 minutes, off-screen)

1. The cluster is up: `bash scripts/up-local.sh`, which is idempotent.
   `kubectl get pods -A` shows everything Running. `.env` has `LLM_API_KEY` set for the
   chat.
2. **User A** is the admin (`ADMIN_EMAIL` in `.env`). Open <http://hub.localtest.me> in
   one browser window and sign in.
3. **User B** is a member. As A: Team → Create user → `bea@hub.localtest.me`, role
   member. Note the initial password, which is shown once. Open a **private window**,
   sign in as B, go to My Keys → Create key "inspector", and copy the key. It's shown
   once; keep it in the clipboard only.
4. Start MCP Inspector in a terminal and leave it open:
   ```bash
   npx @modelcontextprotocol/inspector@2.8.0
   ```
5. Servers page (as A): woocommerce, notes and slow are all **connected**. If one isn't,
   click its refresh button.
6. Tabs to have ready:
   - the storefront <http://store.localtest.me>;
   - wp-admin → WooCommerce → Orders;
   - a terminal for `kubectl`.

## 1. The store (shopper)  ·  e2e §1

1. Storefront → add **Team MCP Mug** to the cart → Checkout → any name and address →
   **Cash on delivery** → Place order.
   *Show:* the "Order received" page with the order number.
2. wp-admin → WooCommerce → Orders: the new order is there, status *Processing*.
   *Say:* "This is a stock WooCommerce. Everything after this goes through our own MCP
   server and gateway; nobody touches WordPress directly."

## 2. Chat agent (user A)  ·  e2e §2

1. As A, open **Chat**. Type: *Create a product called "Demo Hoodie" priced at 29.99.*
   *Show:*
   - the answer streaming in;
   - the side panel: `create_product` with a green **ok** and its duration;
   - the arguments, and the result with the permalink.
2. Open the permalink, or refresh the storefront: **Demo Hoodie** is live. Buy it with
   COD, as in step 1.
3. Back in Chat: *What orders came in today?*
   *Show:* `list_orders` in the side panel, and the answer listing the new order number
   with "Demo Hoodie".
4. *Say:* "The assistant used exactly the same `dispatch()` path as any MCP client. It can
   only call what A's role allows, and customer names and emails were pseudonymised
   before going to the model provider; the screen shows the real ones."
   Optionally ask *Who placed that order?*: the real name is on screen, and the masking
   notice sits under the input.

## 3. External MCP client (user B, member)  ·  e2e §3

1. In MCP Inspector: transport **Streamable HTTP**, URL `http://hub.localtest.me/mcp`,
   header `Authorization: Bearer <B's key>` → **Connect**.
   *Say:* "Only the gateway URL and B's own key. B has never seen a WooCommerce or notes
   credential."
2. **Tools → List tools.** *Show:* `woocommerce__…`, `notes__…` and `slow__…` tools.
   `create_product`, `update_order_status` and `slow__crash` are **absent**, because B
   is a member.
3. Call `woocommerce__list_orders` with `after` = `<today>T00:00:00Z`. *Show:* the Demo
   Hoodie order.
4. Two upstreams in one flow: call `notes__create_note` with title "Orders <today>" and a
   body summarising those orders, then `notes__search_notes` with query `Orders` to find
   it.
   - With Cursor or Claude Code connected instead, this is one prompt: *"List today's
     orders and save a summary as a team note"*.
   - The chat assistant does the same as one prompt: *Summarize today's orders and save
     it as a team note.*
5. *Optional:* call `woocommerce__update_order_status` by typing its name: `[FORBIDDEN]`.
   "Hidden **and** refused."

## 4. Team and control  ·  e2e §4

1. **Revoke B's key.** As B, My Keys → **Revoke key** (or as A, Team → B's keys). In Inspector,
   List tools again. *Show:* **401**, "This API key has been revoked." No restart, no
   cache: it fails on the very next request.
   B creates a new key and reconnects Inspector for the next steps.
2. **Disable the notes server.** As A, Servers → turn off the **Enabled** switch on the notes row. *Show:*
   - Inspector: List tools, and the `notes__*` tools are gone;
   - Chat as A: *Save a note saying hello*. The assistant isn't offered any notes tool
     any more, so it says it can't.

   Switch it back on; within seconds it's **connected** and the tools are back.
3. **Kill the slow server.** In the terminal:
   ```bash
   kubectl -n upstreams delete pod -l app.kubernetes.io/instance=mcp-slow
   ```
   *Show:*
   - Servers page: slow turns **unreachable** (click refresh to see it at once);
   - Inspector: `slow__echo` returns `[SERVER_UNREACHABLE]` **immediately**. It doesn't
     hang; the gateway already knows it's down;
   - Inspector: `woocommerce__list_products` still works;
   - within a minute or two, slow is **connected** again (it starts slowly on purpose,
     20 s, plus the gateway's reconnect backoff).
4. *Optional:* `slow__echo` while slow is up gives `[TIMEOUT]` after 10 s. It sleeps 15 s
   and the gateway gives up at 10 s.

## 5. Audit log  ·  e2e §6

As A, open **Audit Log**. *Show:*
- every call above, newest first, with the user (A or bea), source (**chat** or
  **mcp**), server, tool, duration, outcome and error code:
  - A's `create_product` and `list_orders` from **chat**;
  - B's calls from **mcp**: `denied` FORBIDDEN, `disabled`, `unreachable`;
- filter by user = bea; click a row for the redacted arguments and the error message;
- the cards at the top: per-server error rate and average latency for the last hour.

Then sign in as B (private window) → Audit Log: **only B's own calls**.

## 6. Stand-outs (if time allows)  ·  e2e §5

- **Permissions (stand-out A):** As A, Permissions → turn the Member switch **off** for
  `notes__create_note`. In Inspector as B, List tools: it's gone, and calling it by name
  gives `[FORBIDDEN]`. Click "Use default" to restore it. *Say:* "Stored in Postgres,
  enforced in `dispatch()` and every listing, on every replica, immediately."
- **Observability (stand-out B):**
  ```bash
  kubectl -n platform port-forward deploy/gateway 9090:9090
  ```
  ```bash
  curl -s http://127.0.0.1:9090/metrics | grep '^mcp_gateway_tool'
  ```
  *Show:* calls by server/tool/outcome, the duration histogram, errors by code
  (FORBIDDEN, SERVER_UNREACHABLE…), and `mcp_gateway_upstream_up`. "This port isn't
  routed by the Ingress, and only the monitoring namespace may scrape it."

## 7. Persistence and the databases (optional, 3 minutes)  ·  assignment: persistent storage

Run `bash scripts/show-db.sh` for a guided tour, then `bash scripts/show-db.sh persist`:
it deletes the Postgres, MariaDB and notes pods and shows identical data afterwards.
Talking points, what not to show on screen, and a graphical-client option are in
[demo-database.md](demo-database.md).

## If something goes wrong on stage

| Problem | Recovery |
|---|---|
| Chat answers "rate limit reached" | Groq free tier: wait a minute, or show the same flow in Inspector |
| A server stays unreachable | Servers → refresh; `kubectl get pods -n upstreams` |
| Inspector won't connect | check the header is exactly `Authorization: Bearer wk_…` and the key isn't revoked |
| Anything else | run `bash scripts/e2e-dod.sh`: 62 PASS lines are the demo in text form |

## After the demo

- As A, Team → disable `bea`, which ends her session and keys at once.
- Demo products, orders and notes can stay. Locally,
  `bash scripts/teardown-local.sh && bash scripts/up-local.sh` gives a clean slate.
