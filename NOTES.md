# NOTES

Running log of progress and decisions. Full decision rationale lives in
`docs/design.md` → Decisions.

## 2026-10-11 — Phase 0: Foundations

**Environment found:** macOS 27 (arm64), 16 GB RAM, 10 CPUs, Homebrew, Node 26, pnpm 11.
Missing tools were installed with Homebrew: colima 0.10.3, docker CLI 29.9, kind 0.33.0,
kubectl 1.37, and Helm 3.22.0 (`helm@3`; plain `helm` is now v4, which the spec rules out).

**Done**
- Repo scaffold per spec section 3, pnpm workspace with 5 package stubs, chart skeletons.
- `.gitignore`, `.env.example` (names only), `tsconfig.base.json`.
- Kind config (single node, 80/443 → 127.0.0.1, `ingress-ready` label).
- Scripts: `up-local.sh` (Colima → Kind → NetworkPolicy check → ingress-nginx 4.15.1),
  `create-secrets.sh` (full implementation), `load-images.sh`, `teardown-local.sh`,
  `helm-check.sh`, and an `e2e-dod.sh` that fails on purpose until Phase 7.
- Docs skeletons: design (with Phase 0 decisions), threat model, upgrade/rollback, demo.

**Decisions:** D0.1–D0.11 in `docs/design.md`.

**Verified (2026-10-11)**
- `pnpm install` succeeds.
- `up-local.sh` created the cluster (kindest/node v1.37.0) in about 3 min and confirmed NetworkPolicy enforcement. ingress-nginx is Ready.
- A re-run of `up-local.sh` is idempotent (about 9 s).
- A throwaway Ingress at `smoke.localtest.me` returned 200 from the Mac, so Mac → Colima → Kind → ingress → pod works.
- `create-secrets.sh --generate`: `.env` is 0600 and gitignored, and a second run changes nothing.
- `create-secrets.sh` keeps Secret keys written by others (merge-patch).
- `helm-check.sh` passes, all scripts pass `bash -n`, and `e2e-dod.sh` exits 1 as intended.

**Risks noted**
- ingress-nginx is retired upstream (March 2026): no further security fixes. Kept because the spec requires it.
- 16 GB host: Colima 8 GB plus Ollama 7B (~5 GB) on the host is tight but workable.

## 2026-10-11 — Phase 1: Store

**Done**
- `charts/store`: MariaDB 11.8.9, WordPress 7.1.3 (PHP 8.5), store-init Job (Helm
  post-install/post-upgrade hook, wp-cli 2.12.0), store Ingress, 6 NetworkPolicies,
  narrow RBAC, PVCs `mariadb-data`/`wordpress-content` (5Gi, kept on uninstall).
- WooCommerce 11.2.1, COD on, USD, shipping disabled, coming-soon off, sample product
  "Team MCP Mug" ($12), REST key (read_write) written to `store/woo-mcp-secrets`.
- `up-local.sh` now runs `create-secrets.sh --generate` and installs the store release.
- `create-secrets.sh`: new `WORDPRESS_SALT`; labels namespaces Pod Security `restricted`;
  fixed a bug where a key missing from `.env` aborted the script.

**Problems hit and fixed**
1. A key missing from `.env` (`grep` exit 1 under `pipefail`) silently killed
   create-secrets. Fixed. My own `| sed` wrapper had hidden the exit code.
2. Non-root `tar` couldn't chmod the volume root. Replaced with the `copy-core` init container (D1.6).
3. **`wp core install --prompt` leaked the store admin password into the Job log.** Replaced
   with `ensure-admin.php` (D1.10), rotated the password, and deleted the old pods.
4. `woocommerce_task_list_hidden` can't be updated on first activation in WC 11. Removed
   the setting, since the skipped onboarding profile covers it.

**Verified**
- Storefront, shop, product, and cart pages return 200 via `store.localtest.me`; wp-admin
  redirects to login.
- Guest COD checkout via the Store API created order #12 (`processing`, Cash on delivery,
  12.00 USD), and the WC admin order query lists it.
- `helm upgrade` re-runs the Job as a no-op: identical counts and Secret hash, 1 API key.
- Deleting the WC keys from the Secret makes the Job rotate on the next upgrade, still with 1 key row.
- NetworkPolicy: other namespace → mariadb/wordpress BLOCKED; wordpress → internet BLOCKED;
  wordpress → kube API BLOCKED; wordpress → mariadb allowed; ingress → wordpress allowed.
- RBAC: store-init can only patch `woo-mcp-secrets`.
- `helm-check.sh` passes for both values files.

**Decisions:** D1.1–D1.18 in `docs/design.md`.

## 2026-10-11 — Phase 2: woo-mcp

**Done**
- `mcp-woo/`: TypeScript MCP server with the five tools (`list_products`,
  `create_product`, `list_orders`, `get_order`, `update_order_status`). It uses stateless
  Streamable HTTP at `/mcp`, constant-time bearer auth, `/healthz`, and OAuth 1.0a signing
  for WooCommerce. There's an 8 s timeout, sanitized errors, and JSON request logs.
- 28 Vitest tests, including a signature cross-check against WooCommerce's own PHP and an
  in-process end-to-end test using the real SDK client.
- `mcp-woo/Dockerfile` (tests run inside the build) and `charts/woo-mcp` (Deployment,
  Service, 3 NetworkPolicies).
- Root `.dockerignore`. `up-local.sh` builds and loads the image and installs woo-mcp with
  an image-ID rollout trigger.

**Problems hit and fixed**
1. pnpm flagged zod 4.6.6 as too fresh. Pinned 4.6.5 and kept the guard (no exclusions).
2. `update_order_status` on a missing order returned "ID is invalid." (WooCommerce sends
   400 `*_invalid_id` on updates). It's now mapped to "Order 9999 not found" (D2.7).
3. A startup config error printed a raw stack trace. It's now one JSON log line plus exit 1.
4. Rebuilt `:local` images didn't roll out. Fixed with the `imageId` pod annotation (D2.12).
5. The log line for an input rejected by the SDK lacked the tool name. It now logs
   `outcome: rejected`.

**Verified**
- Basic auth and query-param credentials over HTTP: real 401 (D2.2).
- Local run plus Inspector 2.8.0 CLI: all five tools work. `create_product` gave id 13 and
  its storefront page returns 200. The `get_order 9999` error is clean, and there are no
  secrets in the logs.
- Deployed pod via port-forward plus Inspector: all five tools work (product 14 created;
  order 12 → completed → processing). 401 without a token, 200 on `/healthz`.
- Key rotation: the same pod, with 0 restarts, picked up the new WooCommerce key in about
  24 s.
- NetworkPolicy matrix (7 flows) as designed.
- `helm-check.sh` passes for both values files.

**Test data left in the store:** products 13 "Inspector Test Mug" ($9.50) and 14 "Cluster
Test Tee" ($19.99); order 12 is back to `processing`.

**Decisions:** D2.1–D2.14 in `docs/design.md`.

## 2026-10-11 — Phase 3: Gateway core

**Done**
- `gateway/` (Fastify 5, Drizzle + Postgres, MCP SDK client and server):
  - **Core:** `dispatch()` written test-first; config validation; Drizzle schema and
    migration (7 tables); migrate+seed under an advisory lock.
  - **Auth:** argon2id passwords, HMAC'd sessions, `wk_` API keys, login rate limits.
  - **Upstreams:** AES-GCM credentials, registry with SSRF guard, `UpstreamManager`
    (backoff, grace, collisions), `HttpConnector` (SSRF check at connect time), health
    loop.
  - **Endpoints:** `/mcp` (stateless), REST API for auth, keys, users, servers, tools, and
    audit; `/healthz`, `/readyz`.
- 91 Vitest tests in 7 files, including 26 integration tests on PGlite with real MCP
  clients. They also run inside the Docker build.
- Charts: `charts/postgres` (new), `charts/gateway`, `charts/platform` (umbrella:
  dependencies, hub Ingress, 5 NetworkPolicies). `up-local.sh` installs the platform.

**Problems hit and fixed**
1. pnpm 11 treated argon2's unreviewed install script as an error (exit 1). Set
   `allowBuilds.argon2: false`, since the prebuilt binaries are used.
2. Fastify 5 types reject a numeric `trustProxy`. Replaced with a hop-count function.
3. The Inspector CLI refuses to call tools missing from `tools/list` (client-side).
   Server-side FORBIDDEN enforcement was verified with raw JSON-RPC instead.

**Verified live (Kind)**
- First boot: migrated, created the admin, registered WooCommerce, seeded 6 permission
  rules. WooCommerce is `connected` with 5 tools: gateway → woo-mcp → WordPress, across
  namespaces with NetworkPolicies.
- Admin created member user B; B logged in and created a key. With B's key, the
  Inspector's `tools/list` shows only the 3 read tools, and `woocommerce__list_orders`
  returns order #12.
- Direct calls by B to `update_order_status` and `create_product` return `[FORBIDDEN]`.
  Unknown names return `[TOOL_NOT_FOUND]`.
- Audit rows show user B, source `mcp`, B's key id, outcome, error code, duration, and
  redacted args. B's own audit view contains only B.
- A revoked key gets 401 on the next request.
- The NetworkPolicy matrix (8 flows) is blocked as designed; `/metrics` is not routed.

**Decisions:** D3.1–D3.20 in `docs/design.md`.

## 2026-10-11 — Phase 4: Upstreams

**Done**
- `mcp-notes/`: `create_note`, `list_notes`, `search_notes`; memory + JSON file on an
  emptyDir; bearer auth; 5 tests.
- `mcp-slow/`: `echo` (15 s default delay, per-call override), `flaky` (50%), `crash`
  (only with `ALLOW_CRASH=true`), slow boot (`STARTUP_DELAY_MS`); 6 tests.
- `charts/upstream-mcp`: one generic chart (`--set instance=notes|slow`), startup,
  readiness and liveness probes, per-release NetworkPolicy plus namespace-wide default-deny
  (owned by mcp-notes), and an unknown-key guard.
- Gateway: TCP connect timeout for upstreams (`UPSTREAM_TCP_CONNECT_TIMEOUT_MS`, 3 s);
  `classifyError` walks the error cause chain; new `connector.test.ts` (96 gateway tests
  in total).
- `up-local.sh` builds 4 images and installs 5 releases; `helm-check.sh` renders both
  upstream instances.

**Problems hit and fixed**
1. Mis-indented `env` in the values files made `ALLOW_CRASH` and `STARTUP_DELAY_MS`
   silently disappear. Fixed, and the chart now rejects unknown instance keys.
2. **A crashed upstream made the first call hang for 10 s** (`TIMEOUT`, server still
   "connected"), because the Service with no ready endpoints drops connections. Added the
   TCP connect timeout: now 3.6 s, then fail-fast (D4.7).
3. A test used port 1, which is on fetch's "bad ports" list, so it passed for the wrong
   reason. Fixed with a real closed port, and the cause-chain walk exposed the real error.

**Verified live (Kind)**
- notes and slow registered by the admin via the API: all 3 servers `connected` (5/3/3
  tools). Tokens never appear in API responses.
- Tool lists: the admin sees 11 tools; the member sees 8 (`slow__crash` and the WooCommerce
  write tools hidden).
- Member `notes__create_note` and `search_notes` work through the gateway.
- `slow__echo` gives `[TIMEOUT]` at exactly 10 s, and slow stays `connected`.
  `delay_ms=500` returns normally.
- Pod deleted: first call `UPSTREAM_ERROR` in 45 ms, then `SERVER_UNREACHABLE` in about
  40 ms. notes and woocommerce stayed `ok`. The dashboard showed `unreachable` until it was
  `connected` again at 32 s.
- `slow__crash`: member `[FORBIDDEN]` (audited `denied`). Admin crash: the container
  restarted (restarts=1); first call 3.6 s `UPSTREAM_ERROR` (connect timeout), then
  `SERVER_UNREACHABLE` in 40–55 ms; notes stayed `ok`; recovered at 51 s.
- Upstreams NetworkPolicy matrix: 10 of 10 as designed.

**Decisions:** D4.1–D4.10 in `docs/design.md`.

## 2026-10-11 — Phase 5: Dashboard

**Done**
- `dashboard/`: React 18 + Vite 8 + TanStack Query + React Router 7 + Tailwind 4 +
  shadcn/ui-style components (Radix). Pages: Login, Servers (add, edit, enable/disable,
  refresh, delete, expandable tools), Team (users, roles, enable/disable, per-user keys),
  My Keys, Connect, Audit Log (filters, cursor paging, row detail). Loading, empty, and
  error states on every list. 11 unit tests.
- `dashboard/nginx/` (site config + security-headers snippet) and `dashboard/Dockerfile`
  (tests run in the build; nginx-unprivileged; read-only root filesystem).
- `charts/dashboard`. The platform chart enables it, which adds the `/` route and the
  dashboard NetworkPolicy. `up-local.sh` builds and loads the 5th image.

**Problems hit and fixed / noted**
1. React Router 8 requires React 19, so it's pinned to 7.18.4 (D5.1).
2. Vite 8's config type rejects a `test` block; removed it (Vitest defaults to node).
3. The Playwright MCP tool's workspace is **MOVOZA**, a different project: its page
   snapshots and console logs went to `MOVOZA/.playwright-mcp/` (10 files). Two snapshots
   contain a test API key captured while its one-time dialog was open. **That key was
   revoked.** The folder is left for the user to delete. `.playwright-mcp/` has been added
   to this repo's `.gitignore`.
4. A "frozen page" during the Team test turned out to be a Radix Select dropdown left open
   by a mis-aimed test click (a modal select hides the rest of the page by design). It
   didn't reproduce in isolated steps, so it's not an app bug.

**Verified**
- Deployed at `hub.localtest.me`: `/`, `/servers`, and `/login` → 200 (SPA); a missing
  asset → 404; `/api` and `/healthz` still reach the gateway.
- Security headers are on HTML and on hashed assets. The bundle has no `.env` values, env
  references, source maps, or inline scripts.
- Browser check (Playwright, 1280 px, production bundle):
  - **Login:** the error message is shown and redirects work.
  - **Member:** read-only Servers, `slow__crash` shown as "admin only", no Team page
    (direct URL redirects); key created, shown once, gone from the DOM after closing, then
    masked; Connect snippets correct with no upstream URLs; audit empty state; logout ends
    the session (`/api/me` 401).
  - **Admin servers:** a server is added (slug auto-suggested; an SSRF URL shows an inline
    error; an unreachable server is saved with a red badge and tooltip). Disabling notes
    hides its tools (3→0); re-enabling restores them. Delete has a confirm/cancel step.
  - **Admin team:** users created with the password shown once; role changes;
    disable/enable; another user's key revoked; own Disable button is disabled.
  - **Admin audit:** user, server, and outcome filters; load more (50→98); row detail with
    redacted args.

**Test users left:** `ui-admin` and `ui-member` (credentials in the gitignored
`.env.ui-test.local`, for your own UI checks); `ui-temp` and `ui-temp2` are disabled.

**Decisions:** D5.1–D5.9 in `docs/design.md`.

## 2026-10-12 — Full product QA (before Phase 6)

**Platform health:** 9/9 workloads Running with 0 restarts; 6/6 Helm releases deployed;
3/3 volumes bound; no node pressure (memory requests 15%); no warning events; 0
error-level log lines in 2 h from any service.

**Real-life flow, end to end (28/28 checks):**
1. A customer checks out with COD.
2. The owner creates a product over MCP; it's live on the storefront.
3. A second customer buys that product.
4. The owner onboards member Bea; Bea creates a key.
5. Bea sees 8 tools (admin-only hidden) and "today's orders" returns both orders.
   Changing order status is `[FORBIDDEN]`.
6. Bea writes an orders summary into notes and finds it again.
7. Failures: `[TIMEOUT]` in 10 s; disabling notes hides its tools / `[SERVER_DISABLED]`;
   killing slow gives `[SERVER_UNREACHABLE]` fast while WooCommerce keeps working.
8. Offboarding: a revoked key gets 401; a disabled user's session gets 401.
9. Every one of Bea's calls is attributed to her in the audit log.
10. Both orders are `processing` in WooCommerce.

(The 3 checks that first showed FAIL were bugs in the QA script itself, and passed once
re-run.)

**UI/UX:** screenshots of all pages for both roles. Found and fixed 10 issues (D5.10),
including a real layout bug (the Audit table clipped the Error code column at 1280 px) and
missing confirmations for disabling users and changing roles. Re-verified 23/23 in the
browser, and the new dashboard is deployed.

**Test data now in the store:** product "QA Hoodie" ($39); orders #15 and #17
(processing); note "Daily orders 2026-10-12"; user `bea.qa@…` (disabled).

## 2026-10-12 — Phase 6: Chat agent (Groq) + customer-data masking

**Built:**
- `POST /api/chat` (SSE) with a tool loop through `dispatch()` (source `chat`).
- `GET /api/chat/status`.
- The dashboard Chat page.
- Customer-data masking before anything reaches the LLM. This was added at the owner's
  request (D6.12).

**Provider:** Groq, `openai/gpt-oss-120b`, `reasoning_effort=low` (D6.13).
`llama-3.3-70b-versatile` isn't available to this account. The key is in `.env` →
`platform/gateway-secrets`, never printed.

**Live checks (real Groq, real store):**
1. "What orders came in today?" → `woocommerce__list_orders {after: 2026-10-12T00:00:00Z}`
   → orders #17 and #15. Audit row: source `chat`, the admin's user id.
2. Admin: "Create a product called Sticker Pack priced at 4.99." → `create_product` →
   product 18, live on the storefront (HTTP 200, title "Sticker Pack").
3. Member: "Mark order 15 as completed" → the model says it has no such tool. The tool
   isn't offered to members, and the model also refused to call it by name when pushed.
   Dispatch-level FORBIDDEN for a hidden tool is covered by the integration test.
   Order 15 stayed `processing`.
4. "Summarize today's orders … save as a team note" → `list_orders` + `notes__create_note`.
   The note stores customers as `Customer_296277` (by design).
5. Masking:
   - The model's own text (`model_text`) contains only `Customer_296277` and
     `customer_296277@masked.invalid`, so it never had the real name or email.
   - The user's screen shows the real name and email.
   - Phone: "hidden"; city: kept.
   - Two bugs, both found live and fixed with tests:
     - the stream unmasker used `d` as its digit placeholder, but "maske**d**" and
       "invali**d**" contain a `d`, so pseudonym emails weren't unmasked;
     - gpt-oss sometimes writes `Customer _296277`, which is now accepted.
6. UI, headless Chrome on `vite preview` (16/16 pass):
   - Chat: streaming, side panel, real data on screen with no pseudonyms, masking notice,
     state kept across pages, New chat;
   - member suggestions; no console errors;
   - phone width with no horizontal scroll on 5 pages; drawer closes and is inert.
   - Found and fixed: a blank page on the first message (D6.15), the phone layout
     (D6.14), and the Connect tabs overflowing.

**Tests:**
- gateway 120 (10 files, including the new `privacy.test.ts`);
- mcp-woo 28;
- dashboard 15;
- helm-check 10/10.

**Owner actions (outside the code):**
- Groq console → Data Controls → Zero Data Retention.
- Review the privacy-policy draft in `docs/privacy-notice.md`.

**Test data added:** product "Sticker Pack" (id 18); note "Orders 2026-10-12".

## 2026-10-12 — Phase 7: Permissions, observability, full DoD run

**Built:**
- Permission editor (D7.1):
  - API: `GET/PUT/DELETE /api/permissions`;
  - dashboard Permissions page: admins edit "members may call", members see it
    read-only.
- Prometheus metrics on a separate port 9090 (D7.2, D7.3):
  - tool calls by server/tool/outcome, a duration histogram by server, upstream up/down,
    errors by code;
  - prom-client 15.1.3;
  - `gateway-metrics` NetworkPolicy and `prometheus.io/*` annotations.
- Audit stats (D7.4): `GET /api/audit/stats`, and "Last hour by server" cards on the Audit
  page (error rate, average latency).
- `scripts/e2e-dod.sh` (D7.5): the whole definition of done, plus the Phase 7 checks.

**Verified live:**
- `bash scripts/e2e-dod.sh` → **62 passed, 0 failed**, twice in a row.
  - The second run followed the final redeploy.
  - Negative check: pointing it at a dead hub prints FAIL and exits 1.
- NetworkPolicy, probed with agnhost from temporary namespaces:
  - `monitoring` → gateway:9090 REACHABLE, gateway:8080 BLOCKED;
  - any other namespace → both BLOCKED;
  - `hub.localtest.me/metrics` serves the dashboard's HTML, not metrics.
- UI, headless Chrome (14/14 pass):
  - admin flips create_note to admin-only and the member's tool list loses it at once;
    "Use default" restores it;
  - the Admin switch is locked on; members see read-only badges;
  - Audit stats cards render for both roles (members: "your calls");
  - no horizontal scroll at 390 px; no console errors.

**Tests:**
- gateway 127 (10 files; +7 for permissions, stats and metrics);
- mcp-woo 28; mcp-notes 5; mcp-slow 6; dashboard 15;
- helm-check 10/10.

**Test data added per e2e run:**
- product "E2E Widget <timestamp>", and two COD orders;
- note "E2E orders <timestamp>";
- user `e2e-member-<timestamp>@hub.localtest.me` (disabled at the end, keys revoked).

## 2026-10-12 — Phase 8: Production readiness

**Built:**
- `scripts/policy-check.mjs`, the spec's rules as code over the rendered manifests of
  both environments, now part of `helm-check.sh` (D8.1).
- `scripts/deploy-prod.sh`: k3s with ingress-nginx, cert-manager, a ClusterIssuer, the
  Secrets and the releases; `--dry-run` supported (D8.5).
- `scripts/build-push.sh` (D8.5) and `scripts/backup.sh` (D8.7).
- WP-Cron CronJob for TLS deployments (D8.2).
- ACME HTTP-01 solver NetworkPolicies (D8.3).
- `preStop` drain on all HTTP workloads (D8.4).
- Optional registry pull secret: `.env` `REGISTRY_*` → `registry-pull`, plus
  `global.image.pullSecrets` (D8.6).
- README "Production (k3s VPS)" walkthrough.
- `docs/upgrade-rollback.md`: upgrade, rollback and restore procedures.
- Policy checklist in `docs/threat-model.md`.
- "Production changes" in design.

**Verified:**
- `helm-check.sh`: 60 checks, 0 failures (lint + template ×10, policy ×50).
- Policy check against deliberately broken values: all 5 breakages caught.
- Server-side dry run of the prod manifests, and of `deploy-prod.sh --dry-run`, under
  Pod Security restricted: accepted with no warnings; nothing changed on the cluster.
  `deploy-prod.sh` refuses to really run against Kind.
- WP-Cron CronJob: HTTP 200, `DISABLE_WP_CRON` set, and a past-due probe event consumed.
  First attempt found the `doing_wp_cron` bug (D8.2). Local store reverted to page-load
  cron afterwards.
- Backup + restore into scratch databases: row counts identical (MariaDB 27/402/9,
  Postgres 11/24/3/6/165). Scratch DBs and the test backup deleted.
- 2 gateway replicas:
  - `e2e-dod.sh` 62/62;
  - rolling restart under continuous traffic: 2 of 8,266 requests failed before the
    preStop drain, 0 of about 20,000 after.
  - Scaled back to 1 locally.
- Registry pull secret: created in 3 namespaces with a fake token; the decoded config is
  correct; a partial config is refused; the test secrets were removed.
- `build-push.sh`: guards refuse `latest`, the placeholder, and `--platform` without
  buildx; a native no-push build works (test tag removed). The classic builder can't
  cross-build to amd64 on this Mac.
- Final: redeployed from the repo, `e2e-dod.sh` 62/62. Tests: gateway 127, mcp-woo 28,
  mcp-notes 5, mcp-slow 6, dashboard 15.

**Not verifiable here:** a real VPS, k3s, Let's Encrypt issuance and DNS. Everything
up to the API server was validated with dry runs on Kind.

## 2026-10-12 — Phase 9: Documentation

**Written or finalised:**
- **README:**
  - what the project is, with an architecture diagram;
  - local setup, and each everyday task (place an order, the dashboard, connect an
    external MCP client, use the chat agent, permissions, metrics, the e2e check);
  - production on a k3s VPS (Phase 8);
  - the stand-out and bonus table with file locations;
  - repository layout, a docs index, and troubleshooting.
- **docs/design.md:** final architecture (diagram, request paths, module table); tool
  naming (chat function-name mapping); failure handling (+ replicas, LLM, hidden tools,
  Postgres down); new **Tradeoffs** table (12 rows); production changes; the decision
  log D0.1–D8.8. Superseded decisions are marked.
- **docs/threat-model.md:** a new "Shared upstream credentials" section. The other four
  spec topics are updated for chat, permissions and masking, including indirect prompt
  injection between members through shared notes. Also a topic index, a
  local-exposure section, and phase tags removed from headings.
- **docs/demo-script.md:** a 15–20 minute live demo of spec section 19 with two users:
  per-step actions, what to show and say, the e2e section each maps to, stand-outs,
  on-stage recovery, and cleanup. Button names checked against the UI.
- **docs/upgrade-rollback.md:** phase tags removed (content complete since Phase 8).

**Fixed while documenting:**
- **Fresh clusters had only WooCommerce registered.** notes and slow were registered by
  hand in Phase 4, so `up-local.sh` followed by `e2e-dod.sh` would have failed at
  preflight on a new machine.
- **New `scripts/register-upstreams.sh`** (idempotent, tokens via stdin) is now run by
  `up-local.sh`. Tested by deleting both registrations and re-registering (both
  `connected`), and by the idempotent path inside `up-local.sh`.
- **The README's terminal login example put the password on curl's command line.** It
  now goes through stdin; the example as written was run and works.

**Verified:**
- All relative links and anchors in the README and docs resolve (script check).
- Every file path named in the docs exists.
- `up-local.sh` exit 0; `helm-check.sh` 60/60; `e2e-dod.sh` 62/62.

## 2026-10-12 — Phase 10: Multi-store provisioning (bonus)

**Built:**
- `provisioner/` service and `charts/provisioner`:
  - fenced RBAC and a ValidatingAdmissionPolicy confining it to `store-*` namespaces;
  - NetworkPolicies.
- Gateway: `stores` table + migration 0001, `/api/stores`, a lease-based reconciler, and
  the `store-` slug reserved on the Servers API.
- Store chart `tenant` mode: ResourceQuota and LimitRange.
- Dashboard Stores page.
- `scripts/e2e-stores.sh`.
- Design D10.1–D10.5 and a threat-model section.

**Verified live:**
- `alpha` and `beta` each went from request to ready in about 66 s.
- Fence probes by impersonation: all attacks denied, only the intended path allowed.
- Provisioner killed mid-install: the pending release was uninstalled and reinstalled,
  and the store was ready about 1 min later.
- `e2e-stores.sh`: 25/25 on the second run. The first run's chat step got an empty
  answer, so the check now retries and verifies both store names.
- Stores UI: 11/11 pass.

**Tests:** gateway 135, provisioner 8, policy-check passes for both environments.

**Finished afterwards:**
- **Store upgrades (D10.6).** Fingerprint-based in-place upgrades of ready stores, plus a
  gateway re-check every `resyncMinutes`. Verified live: a tenant-only value change
  reached `store-alpha` (revision 1 → 2, storefront 200 throughout, main store
  untouched), and the revert rolled back the same way.
- **Several stores in one chat (D10.7).** The core e2e caught the model creating the
  test product in `store-alpha`. The system prompt now defaults writes to the main store,
  and the e2e prompt names the store. Verified: an unspecified "create a product" goes
  to `woocommerce__create_product`.
- Provisioner logs interrupted-install cleanups.
- A per-store backup (`STORE_NS=store-<name> backup.sh`) was verified, and the test
  backup deleted.
- **Final:** `helm-check` 69/69. Tests: gateway 136, provisioner 9, mcp-woo 28,
  mcp-notes 5, mcp-slow 6, dashboard 15 (199). `e2e-dod.sh` 62/62 and `e2e-stores.sh`
  25/25 on the final deployment.

## 2026-10-13 — Teardown bug found during the user's clean-slate run

**What happened:** `teardown-local.sh && up-local.sh` did **not** delete the cluster.
The node was 41 h old and all data survived, yet both scripts exited 0.

**Cause:** `kind get clusters | grep -qx NAME` under `set -o pipefail`. `grep -q` exits
at the first match, so `kind` can get SIGPIPE and the pipeline reports failure. The
script then took the "does not exist; nothing to delete" branch and exited 0. The
failure is intermittent; it couldn't be reproduced in 5 tries afterwards.

**Fix:**
- capture `kind get clusters` into a variable first, then grep it;
- teardown now verifies that the cluster is gone, and fails loudly otherwise;
- the same pattern was fixed in `up-local.sh` and `load-images.sh`, where it would only
  have failed loudly.

The real clean slate was then run: the cluster was deleted ("Kind cluster 'team-mcp'
deleted.") and rebuilt from scratch.

## 2026-10-26 — Persistence audit; gateway crash on Postgres restart

**Audit against the Urumi assignment PDF:** all mandatory requirements are met in the repo.
Not done: the demo video and the GitHub repo/submission (user's). Stand-outs not
attempted: OAuth, many-tools handling, hosted MCP servers, per-key tool-call rate limits.

**Persistence test:** the postgres, mariadb and wordpress pods were killed and restarted:
- MariaDB: 1 product and 376 options before and after;
- plugins unchanged;
- Postgres: 3 users, 3 upstreams, 6 permission rules, 0 audit rows after.

**Bug found:** `createPool` had no `pool.on("error")` listener. A Postgres restart makes
node-postgres emit "error" on the pool; with no listener that kills the process. The
gateway exited and Kubernetes restarted it. Fixed with a handler that logs one line.
- `gateway/test/pool.test.ts` fails without the fix and passes with it.
- Verified live: Postgres killed and restarted, gateway 0 restarts, `/readyz` back at
  200, 2 handled log lines.

**Incident:**
- `.env` was edited at 17:38 (not by me): `ADMIN_PASSWORD` became 9 characters, and the
  Secret was updated to match.
- The gateway validates at least 12 characters at every start, so after the restart it
  crash-looped.
- The rule was not weakened. A fresh 24-character password was generated into `.env`
  (the user's choice), the Secret was redeployed, and the stored admin hash was reset to
  match (argon2id, hashed inside the gateway, password via stdin). Login checked: 200.
- **Why the reset was needed:** `ADMIN_PASSWORD` only seeds the first admin, so changing
  `.env` never changes an existing login. `.env` and the stored login can silently
  diverge. After the reset they match again.

Final: gateway tests 138, `e2e-dod.sh` 62/62, UI test users unaffected (login 200).
