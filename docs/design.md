# Design

How the system is built and why. The first sections give the overview. **Decisions**
(D0.1 to D8.8, in build order) records every non-obvious choice, with what was rejected
and how it was verified. Later decisions can refine earlier ones, and say so.

## Architecture

```
                 hub.<domain>                                      store.<domain>
                      │                                                  │
               ingress-nginx (TLS in prod) ──────────────────────────────┤
   /api /mcp /healthz │  / (static)                                      ▼
                      ▼                                   store ns:  WordPress + WooCommerce ──▶ MariaDB
 platform ns:  gateway ×1 (local) / ×2 (prod)                         ▲  ▲       (PVCs: wp-content, db)
               │  Fastify · MCP SDK (stateless Streamable HTTP)       │  │ HTTP, OAuth 1.0a signed
               │  dispatch() ── bearer ──────────────────────────▶ woo-mcp   │
               │             ── bearer ──▶ upstreams ns: mcp-notes, mcp-slow │
               │  chat ── HTTPS 443 (public IPs only) ──▶ LLM provider       │
               │  :9090 /metrics ◀── monitoring ns only        store-init Job (Helm hook):
               ▼                                               installs WooCommerce, REST keys,
             Postgres: users, sessions, api_keys,              patches woo-mcp-secrets
             upstreams (encrypted creds), tool_permissions,    wp-cron CronJob (prod, TLS)
             audit_log, login_failures
   dashboard: React SPA on nginx-unprivileged (CSP), same host as the API
```

**Request paths:**
- **MCP client:** `POST /mcp` with `Authorization: Bearer wk_…`.
  1. The key is checked (SHA-256 lookup; revoked keys and disabled users are refused).
  2. A fresh stateless MCP server answers `tools/list` from `Core.listTools(role)`: the
     cached tools of enabled, healthy upstreams, filtered by the permission table.
  3. `tools/call` goes to `Core.dispatch()`.
- **Dashboard:** cookie session → `/api/*` (zod-validated JSON, one error format).
  `POST /api/chat` streams SSE. The agent loop gets the same `listTools(role)` and sends
  every tool call through the same `Core.dispatch()` with `source: "chat"`. Customer data
  is masked before anything goes to the provider (D6.12).

**Inside the gateway, every tool call from every entry point takes one path:**

```
/mcp (API key) ───┐                                         ┌──▶ audit_log (exactly 1 row per call)
                  ├─▶ Core.dispatch() ─▶ dispatch() ────────┼──▶ metrics (counters, histogram)
/api/chat (cookie)┘   parse <slug>__<tool> → find upstream  └──▶ result, or "[CODE] message"
                      → disabled? → unreachable? (fail fast) → role allowed? (FORBIDDEN)
                      → UpstreamManager.callTool(timeout) → map errors → passthrough isError
```

| Module | Role |
|---|---|
| `router/dispatch.ts` | pure; all I/O injected; unit tested in isolation (16 tests). `core.ts` wires it to Postgres, the upstream manager, the audit log and metrics |
| `upstream/manager.ts` | one MCP client per enabled upstream: status, cached tools, health checks, backoff (1 s → 60 s), grace period |
| `upstream/connector.ts` | the only code that talks HTTP to upstreams. It adds the credential header and enforces the SSRF check at connect time |
| `registry/service.ts` | the only code that writes `upstreams` or decrypts credentials |
| `router/aggregate.ts` | the permission-filtered tool list for `/mcp` and the chat agent, so both always see the same tools |
| `chat/` | provider client (`model.ts`), tool loop (`agent.ts`), SSE route, customer-data masking (`privacy.ts`) |

**Components and why they exist:**
- **woo-mcp:** WooCommerce products and orders as 5 MCP tools, OAuth 1.0a-signed REST
  calls inside the cluster.
- **mcp-notes:** team notes, for the two-upstream demo.
- **mcp-slow:** timeouts, flaky failures and crashes on demand.
- **Placement:** each lives in the namespace of what it serves, and NetworkPolicies allow
  only the arrows shown above.

## Tool naming

- **Exposed name:** `<slug>__<upstreamToolName>`, e.g. `woocommerce__list_orders`.
- **Slugs** are unique and match `[a-z0-9-]{2,30}`. They can't contain `__`, so names are
  parsed by splitting on the **first** `__`. The same upstream tool name can never collide
  across servers.
- **Upstream names containing `__`** are exposed with `__` → `_`. The original name is
  kept in tool metadata (`_meta["team-mcp/originalName"]`) and is what the gateway sends
  upstream.
- **Rejected at listing time** (the server stays connected and reports them in
  `last_error`):
  - two tools of one server that would get the same exposed name;
  - names with characters outside `[A-Za-z0-9_.-]`.
- Exposed names are at most 30 + 2 + 64 characters. For the chat, LLM providers require
  function names matching `^[a-zA-Z0-9_-]{1,64}$`, so the agent maps names that don't
  fit (dots, length) to unique valid ones and maps them back before calling `dispatch()`
  (D6.6).

## Failure handling

| Situation | Behaviour |
|---|---|
| Upstream's Service has no ready endpoints (pod crashed/restarting) | the TCP connect is silently dropped, so the client gives up after `UPSTREAM_TCP_CONNECT_TIMEOUT_MS` (3 s) → transport error → unreachable (D4.7) |
| Upstream down at connect / health check | status `unreachable`, `last_error` recorded, client discarded; retried with backoff 1 s, 2 s, 4 s … capped at 60 s |
| Call to an unreachable upstream | `[SERVER_UNREACHABLE]` **immediately** (no connect attempt, no timeout wait) |
| Transport error during a call | `[UPSTREAM_ERROR]`, and the upstream is marked unreachable, so the next call fails fast |
| Upstream slower than its timeout (default 10 s, per upstream) | `[TIMEOUT]`; the upstream is **not** marked down (it's alive, just slow) |
| Upstream answers with a JSON-RPC error | `[UPSTREAM_ERROR]` with the message truncated; stays connected |
| Upstream tool returns `isError: true` | passed through unchanged; audited as `error` / `TOOL_ERROR` |
| Disabled upstream | never contacted; tools hidden; calls return `[SERVER_DISABLED]` |
| Tool listing with a dead or slow upstream | upstreams queried in parallel (`allSettled`), each capped at 3 s; the others are listed normally |
| Cached tools of a newly failed upstream | still listed during a grace period (until 2 failures in a row = "confirmed gone"), then removed |
| Health loop | every 30 s, all enabled upstreams in parallel: connect if needed + `tools/list` with a 3 s timeout |
| Several gateway replicas | each replica tracks upstream health itself. A replica that hasn't noticed a failure yet still answers `[SERVER_UNREACHABLE]` once its 3 s connect timeout expires (D8.8) |
| LLM provider fails (bad key, rate limit, timeout, model error) | one friendly message to the user (no provider body); the tool calls already made stay audited (`describeLlmError` in `chat/model.ts`) |
| The model calls a hidden or non-existent tool | sent to `dispatch()` anyway, which refuses it (`FORBIDDEN` / `TOOL_NOT_FOUND`) and audits it; the error goes back to the model as a result |
| Chat loop doesn't converge | stops after 8 model rounds and says so |
| Postgres down | `/readyz` fails, so the pod leaves the Service; `/healthz` stays up, so there's no restart loop |

## Tradeoffs

| Chose | Over | Because | Cost |
|---|---|---|---|
| One `dispatch()` for `/mcp` and chat | separate paths per entry point | permissions, timeouts, error codes and audit can't drift apart | the chat can't use gateway-internal shortcuts |
| Stateless Streamable HTTP (fresh MCP server per request) | MCP sessions | any replica answers any request; no sticky sessions | no `notifications/tools/list_changed`: clients see changes on their next `tools/list` |
| Gateway holds upstream credentials (shared per server) | passing members' tokens through | members need nothing but one key; revocation is one DB write | an upstream can't tell members apart (the gateway's audit log does). See the threat model, "Shared upstream credentials" |
| Health state in each replica's memory | shared health in Postgres | no write traffic, no coordination; the fast-fail path needs no DB | replicas can disagree for up to one health interval (30 s) |
| Postgres for sessions, login limits and permissions | Redis or other in-memory stores | one fewer component; shared across replicas; durable | a DB round trip per request (small tables, indexed) |
| Plain HTTP + OAuth 1.0a to WordPress inside the cluster | TLS to WordPress | WooCommerce requires OAuth 1.0a over HTTP; NetworkPolicy limits who can talk to it | signature-URL subtleties (D2.3) |
| Default member policy `allow` for unlisted tools | `deny` | new servers are usable immediately; write tools of the store are explicit rules | a new server's write tools are open to members until an admin restricts them (one switch on Permissions; `defaultMemberToolAccess: deny` flips it) |
| Groq's free tier, OpenAI-compatible client | a local Ollama model | runs on any laptop, good tool calling, fast | conversation and masked tool results leave the cluster (D6.12 masking, ZDR, privacy notice) |
| Chat history kept in the browser | server-side conversation storage | nothing to store, secure or expire; any replica answers | a page reload starts a new conversation |
| Single replica for WordPress, MariaDB and Postgres (RWO volumes, `Recreate`) | HA databases, object storage | fits one VPS and free components | brief downtime when those three are upgraded |
| ingress-nginx | Traefik (k3s default) or Gateway API | specified; mature; identical locally and in prod | retired upstream; replace later (D0.3) |
| Policy rules as code over rendered manifests | admission controllers (Kyverno, Gatekeeper) | no extra cluster component; runs offline before deploy | it checks the charts, not things applied by hand |

## Production changes

**What production changes today.** It's the same charts with
`values/values-prod.yaml`, deployed by `scripts/deploy-prod.sh` (full table in
docs/upgrade-rollback.md):
- real hosts, with TLS from cert-manager and Let's Encrypt;
- `local-path` storage;
- 2 gateway replicas and larger requests and limits;
- versioned images from a registry, pulled `Always` (optionally with a pull secret);
- WP-Cron run by a CronJob;
- ingress-nginx behind k3s ServiceLB, keeping real client IPs.

**Recommended next steps for a real business**, not done because they need paid services
or more than one node:
- **Off-site backups on a schedule.** `scripts/backup.sh` exists; run it from cron on
  another machine and keep copies elsewhere.
- **Secrets management.** Move `.env` to SOPS-encrypted files or Sealed Secrets, so
  deploys don't depend on one machine's `.env`.
- **Databases.** A replicated MariaDB and Postgres (or managed ones), and object storage
  for WordPress uploads. Together these allow more than one WordPress replica and remove
  the brief downtime of `Recreate` upgrades.
- **Monitoring.** Prometheus and Grafana scraping `/metrics` (already exposed to the
  `monitoring` namespace), with alerts on `mcp_gateway_upstream_up == 0` and on error
  rate.
- **Ingress.** Replace ingress-nginx, which is retired upstream (D0.3), with a maintained
  controller or Gateway API implementation, once one is chosen.
- **Multi-node.** PodDisruptionBudgets and anti-affinity, which only matter with more
  than one node.
- **CI.** Run `helm-check.sh` and the image builds (tests included) on every push, and
  sign images.

## Decisions

Each entry: what was decided, why, and the phase it was made in.

### Phase 0 — Foundations

- **D0.1 Helm 3, explicitly pinned.** Homebrew's `helm` formula now installs Helm 4. The
  spec requires Helm 3, so the local setup uses the `helm@3` formula (3.22.x), and
  `up-local.sh` refuses to run under any other major version. Charts use `apiVersion: v2`,
  which Helm 4 also reads, so a later move is possible but is a deliberate decision.
- **D0.2 Keep Kind's default CNI (kindnet).** kindnet has enforced NetworkPolicy since
  kind v0.24, so Calico isn't needed. Because deny-by-default policies are a core control,
  `up-local.sh` verifies enforcement on every new cluster (client reaches a server, then is
  blocked after a default-deny policy) and aborts if enforcement is missing.
- **D0.3 ingress-nginx chart pinned to 4.15.1** (controller 1.15.1), installed with Kind
  settings (hostPort 80/443 on the `ingress-ready` node; `maxSurge: 0`, because two pods
  can't hold the same hostPort). Risk: the Kubernetes project retired ingress-nginx in
  March 2026, so it gets no new releases or security fixes. The spec mandates it, so it
  stays. The migration path (Gateway API, or k3s's bundled Traefik in prod) is recorded
  under Production changes.
- **D0.4 One values file per environment, shared by every release.** The spec allows only
  `values/values-local.yaml` and `values/values-prod.yaml`, but there are several
  independent releases (platform, store, woo-mcp, mcp-notes, mcp-slow). Every release gets
  the same file. `global:` holds environment-wide settings (hosts, TLS, storageClass, image
  registry/tag/pullPolicy). Each component reads its own top-level section and ignores the
  rest. The generic `upstream-mcp` chart takes `--set instance=<name>` to pick its section.
- **D0.5 Secrets come only from `.env` through `create-secrets.sh`.**
  - `--generate` fills empty `.env` values with random secrets or local defaults and never
    overwrites a set value. This avoids hand-writing a dozen secrets without adding a
    script outside the spec'd layout.
  - The script never prints values and never puts them on a command line (it uses a 0600
    temp file and `--from-env-file`).
  - It derives `DATABASE_URL` from `POSTGRES_PASSWORD`, so the two can't drift. It writes
    `MARIADB_PASSWORD` to both `mariadb-secrets` and `wordpress-secrets`
    (`WORDPRESS_DB_PASSWORD`) for the same reason. It writes `WOO_MCP_BEARER_TOKEN` into
    both `platform` and `store`.
  - Existing Secrets are merge-patched, not replaced, so the WC REST keys that the
    store-init Job adds to `store/woo-mcp-secrets` survive a re-run.
  - `NOTES_MCP_BEARER_TOKEN` and `SLOW_MCP_BEARER_TOKEN` go only to their upstream's Secret
    (`upstreams/mcp-{notes,slow}-secrets`), not to the gateway. The admin registers those
    servers through the API, and the gateway stores their credentials encrypted.
- **D0.6 Two files beyond the section-3 layout:** `tsconfig.base.json` (shared strict TS
  settings for the five Node packages) and `scripts/helm-check.sh` (section 6 requires a
  committed script that runs `helm lint` and `helm template` for both values files).
- **D0.7 Node 22 in containers.** The host has Node 26, which only runs pnpm and the tests.
  Images pin `node:22-*` as the spec requires, and `engines` is `>=22`.
- **D0.8 Colima sizing: 4 CPU / 8 GB / 60 GB, `vz` VM.** This fits WordPress, MariaDB,
  Postgres, and the Node services. Ollama runs on the Mac host (Phase 6), outside the VM,
  so the model's ~5 GB stays out of the VM budget on a 16 GB machine. *(Superseded by
  D6.1: the chat uses Groq by default; Ollama remains an option.)*
- **D0.9 Image names:** `team-mcp/<component>:local` locally (loaded with `kind load`, no
  registry) and `<registry>/<component>:<version>` in prod, both from `global.image`.
- **D0.10 TypeScript 5.9, not 7.** TS 7 (the native port) is available, but drizzle-kit,
  Vite plugins, and Vitest type tooling are proven on 5.x. Revisit after the core passes.
- **D0.11 Colima exposes ingress on all host interfaces.** Kind binds 80/443 to 127.0.0.1
  inside the VM, but Colima's forwarder (`limactl`) listens on `*:80`/`*:443` on the Mac,
  so the local stack is reachable from the LAN. That's acceptable for a dev laptop because
  everything still needs a session or API key. It's recorded in the threat model, and
  restricting the forwarder is revisited in Phase 8.

### Phase 1 — Store

- **D1.1 Pinned versions:** `wordpress:7.1.3-php8.5-apache` (the latest PHP 8.x variant),
  `wordpress:cli-2.12.0-php8.5`, `mariadb:11.8.9` (11.8 LTS), and WooCommerce 11.2.1
  (tested against WP 7.1.3). They're pinned for reproducibility; see upgrade-rollback.md.
- **D1.2 Every store pod meets Pod Security "restricted"; no root exceptions were needed.**
  The spec expected WordPress and MariaDB to need root.
  - **MariaDB** runs as uid 999 with emptyDirs for `/run/mysqld` and `/tmp`.
  - **WordPress** runs as uid 33 (www-data), with emptyDirs for Apache's run and lock dirs.
    Apache binds port 80 through the namespaced "safe" sysctl
    `net.ipv4.ip_unprivileged_port_start=0`, which "restricted" allows. That avoids
    `NET_BIND_SERVICE` or rewriting Apache's port config.
  - Every container has `readOnlyRootFilesystem`, drops ALL capabilities, and uses seccomp
    RuntimeDefault.
  - `create-secrets.sh` labels the platform, store, and upstreams namespaces
    `enforce=restricted`, so a non-compliant pod is rejected, not just warned about.
- **D1.3 The MariaDB probe uses `mariadb-admin ping`.** That's MariaDB 11's name for
  `mysqladmin`; the old name isn't shipped in 11.x images. It pings over TCP (127.0.0.1) so
  the init-time temporary server (`--skip-networking`) doesn't read as ready. `ping` exits 0
  whenever the server answers, so the probe needs no credentials.
- **D1.4 WordPress probes.** Readiness is `GET /wp-login.php`, as specified; it exercises
  PHP and the DB. Liveness is a TCP check on :80, so a database outage makes WordPress
  NotReady instead of restart-looping it.
- **D1.5 Shipping is disabled** (`woocommerce_ship_to_countries=disabled`). With shipping on,
  checkout of a physical product fails with "no shipping options" until someone configures
  zones. COD is enabled for all methods and for virtual products, so products the agent
  creates are immediately purchasable.
- **D1.6 WordPress core lives in an emptyDir, filled by a `copy-core` init container. Only
  `wp-content` is on the PVC.**
  - The image's entrypoint copies core with `tar ... .`, which tries to chmod the volume
    root and fails as non-root.
  - The init container archives top-level entries individually instead. It seeds bundled
    themes and plugins into `wp-content` with `--skip-old-files`, never overwriting.
  - The Job uses the same init container, so wp-cli always runs the same WordPress version
    as the web pod and downloads no core files.
- **D1.7 The store-init Job mounts the web pod's RWO `wordpress-content` PVC**, so the
  plugin it installs is the one served. RWO is per node, which is fine on single-node Kind
  and single-VPS k3s. Multi-node needs RWX storage or node affinity (Production changes).
  The Job runs as uid 33, not the wp-cli image's 82, so files it creates (plugins,
  `uploads/wc-logs`) belong to the uid the web pod runs as.
- **D1.8 Job RBAC is a single rule: `patch` on `secrets/woo-mcp-secrets`.**
  - There's no `create`: RBAC can't scope `create` by resourceNames, so it would mean
    "create any Secret". `create-secrets.sh` creates the Secret beforehand.
  - There's no `get` either: the Job reads the current key pair through `secretKeyRef` env
    (`optional: true`), which the kubelet resolves, not the Job's token.
  - Verified with `kubectl auth can-i`: patch on that Secret is yes, and everything else
    (get, list, create, delete, other Secrets, pods) is no.
- **D1.9 REST key: direct DB insert, with the Secret as source of truth.**
  - The key is created with `wp eval-file`, using WooCommerce's own `wc_rand_hash` and
    `wc_api_hash`, because `wp wc` has no command for creating keys.
  - WooCommerce stores consumer keys hashed, so an existing key can't be read back. Each
    run checks the Secret's pair against the DB. On a mismatch or absence it deletes only
    the keys it owns (by description), creates a fresh pair, and merge-patches the Secret.
  - That makes "Secret wiped" and "DB wiped" self-heal; both were tested.
- **D1.10 The store admin password never touches argv or logs, and the Secret is its
  source of truth.**
  - The first version used `wp core install --prompt=admin_password`. wp-cli echoes the
    reconstructed command, password included, into the Job log. That was caught during
    verification, and the password was rotated.
  - Now `core install` runs with a throwaway generated password, and `ensure-admin.php`
    sets the real one from env.
  - The password is written only when it differs, because `wp_set_password` ends sessions.
  - To rotate it: edit `.env`, run `create-secrets.sh`, then `helm upgrade`.
- **D1.11 One `WORDPRESS_SALT` secret expands into the 8 WordPress keys and salts** through
  Kubernetes `$(VAR)` expansion. Without fixed salts the image randomizes them per
  container, which logs everyone out on every restart.
- **D1.12 URLs and loopback.** `WP_HOME`/`WP_SITEURL` come from `global.storeHost` and
  `global.tls.enabled`: plain http locally (TLS off, documented), https in prod. Locally, a
  `hostAliases` entry points the store host at 127.0.0.1 inside the pod, so WP-Cron and
  Action Scheduler loopback calls never leave the pod. In prod, with TLS, loopback can't
  reach https from inside the pod, so the fix is a system-cron CronJob (Production changes).
- **D1.13 Web pod hardening:** `DISALLOW_FILE_MODS`, `DISALLOW_FILE_EDIT`,
  `AUTOMATIC_UPDATER_DISABLED` (plugins and core change only through the image and the
  Job), and `WP_HTTP_BLOCK_EXTERNAL` (outbound HTTP fails fast instead of hanging wp-admin,
  since egress is denied anyway).
- **D1.14 NetworkPolicy for store-init's API access: port 6443 only.** Policy is evaluated
  after Service DNAT, so the rule names the API server's real endpoint port (6443 on Kind
  and k3s), not the Service's 443. Verified: the Job patches the Secret, and the WordPress
  pod is blocked from the API.
- **D1.15 PVCs carry `helm.sh/resource-policy: keep`**, so `helm uninstall store` never
  deletes the database or uploads.
- **D1.16 How the checkout was verified.** The built-in browser pane used for verification
  blocks subresources on hosts that resolve to 127.0.0.1 (`ERR_BLOCKED_BY_CLIENT`). The
  same assets return 200 over curl, so the checkout block can't render in that pane; a
  normal browser is unaffected. The automated COD checkout therefore goes through the
  WooCommerce Store API (`/wp-json/wc/store/v1/cart` → `add-item` → `checkout`), which is
  exactly what the checkout block calls. The same flow will drive `e2e-dod.sh`.
- **D1.17 Order storage.** The CLI install leaves WooCommerce's newer order storage (HPOS)
  off, so orders are stored as posts. Admin screens, REST v3, and the Store API all work
  with either; it isn't changed.
- **D1.18 No outbound mail.** There's no MTA, so WooCommerce emails fail with a harmless
  `sendmail` warning. Out of scope for the demo.

### Phase 2 — woo-mcp

- **D2.1 Stack and supply chain.** The stack is Express 5, `@modelcontextprotocol/sdk`
  1.32.1, and zod 4.
  - pnpm 11's `minimumReleaseAge` guard stays on with **no exclusions**. When it flagged
    zod 4.6.6 (published hours earlier), 4.6.5 was pinned exactly instead.
  - The MCP Inspector used for verification is 2.8.0 (18 days old) for the same reason.
  - `allowBuilds` permits only esbuild's install script.
- **D2.2 WooCommerce auth is OAuth 1.0a (HMAC-SHA256); Basic auth is not accepted over
  HTTP.**
  - **Verified with real requests** to the plain-HTTP store: Basic auth and
    `consumer_key`/`consumer_secret` query params both return
    `401 woocommerce_rest_cannot_view`. WooCommerce attempts Basic only when `is_ssl()`
    is true (`class-wc-rest-authentication.php`) and otherwise requires OAuth 1.0a.
  - **Rejected alternative:** sending `X-Forwarded-Proto: https` to make WordPress believe
    the request is TLS. It would misrepresent the transport and send the consumer secret
    in cleartext on every call. OAuth never sends the secret at all.
  - **Header, not query:** OAuth params go in the `Authorization: OAuth …` header, which
    WordPress's `.htaccess` forwards to PHP. That keeps the consumer key out of URLs and
    access logs.
  - **Cross-checked:** the signer is tested against a base string and signature produced
    by WooCommerce 11.2.1's own PHP functions, copied verbatim from the plugin.
- **D2.3 Signature URL ≠ request URL.** WooCommerce recomputes the signature over its
  **home URL** plus the request path, with the scheme forced to `http` for non-TLS requests.
  woo-mcp sends requests to `http://wordpress.<ns>.svc.cluster.local` (`WC_BASE_URL`) but
  signs `http://<storeHost>/…` (`WC_SIGNATURE_BASE_URL`). In prod that's still `http://`,
  even though the public site is https, because the in-cluster request isn't TLS.
- **D2.4 Stateless Streamable HTTP.**
  - Each `POST /mcp` builds a fresh `McpServer` and transport (`sessionIdGenerator:
    undefined`) and answers with JSON instead of SSE.
  - `GET` and `DELETE /mcp` return 405.
  - Tradeoff: no server-initiated messages (e.g. `tools/list_changed`). woo-mcp's tool set
    is static, so nothing is lost, and any replica can serve any request.
- **D2.5 Secrets are mounted as a directory and read on every request.**
  - Only directory mounts (not env vars or `subPath`) are refreshed by the kubelet.
  - Measured: after store-init rotated the key, the **same pod, with 0 restarts**, served
    with the new key within about 24 s.
  - During the kubelet sync window, calls fail cleanly with `HTTP 401: Consumer key is
    invalid.`, which is acceptable for a rare, deliberate rotation.
- **D2.6 Bearer auth.**
  - Both tokens are hashed with SHA-256 and compared with `crypto.timingSafeEqual`, so
    neither the timing nor the length is leaked.
  - Auth runs **before** the body is parsed.
  - A missing configured token makes the server answer 503: it refuses to run
    unauthenticated.
- **D2.7 Error mapping.**
  - Messages are short and sanitized, with tags stripped, `ck_`/`cs_` redacted, and a
    200-character limit.
  - HTML error pages are never forwarded, and redirects are not followed
    (`redirect: "manual"`).
  - The timeout is 8 s (`WC_TIMEOUT_MS`).
  - A 404, **or a 400 with code `*_invalid_id`** (WooCommerce's answer for updating a
    missing order), becomes `Order <id> not found`. Found by testing
    `update_order_status` against the real store.
- **D2.8 Input validation.**
  - `regular_price` must be a decimal *string*, as the spec says. The Inspector CLI coerces
    `9.50` to a number, so pass `'regular_price="9.50"'`.
  - `after`/`before` accept a date or a datetime, normalized to UTC, and are sent with
    `dates_are_gmt=true` so WooCommerce compares them against `date_created_gmt`.
- **D2.9 `/healthz` doesn't call WooCommerce.** A store outage shouldn't restart woo-mcp;
  tools report it as a tool error instead.
- **D2.10 Logging.** Each request produces one JSON line: HTTP method, path, status,
  duration, the JSON-RPC method, the tool **name**, and an outcome of `ok`, `error`, or
  `rejected` (the SDK rejected the input before the handler ran). Arguments, headers, and
  secrets are never logged, and a test asserts this.
- **D2.11 Image.**
  - Multi-stage `node:22.23.3-alpine3.24` build. The unit tests run **inside** the build,
    so failing tests fail the image.
  - `pnpm deploy --prod` produces a production-only `node_modules` (3 dependencies).
  - It runs as uid 1000 with a read-only root filesystem.
  - A root `.dockerignore` keeps `.env` and `node_modules` out of every build context; the
    built image was checked for this.
- **D2.12 Local rollouts.** The `:local` tag never changes, so `up-local.sh` passes the
  Docker image ID as `wooMcp.imageId`, which is rendered as a pod annotation. A rebuild
  rolls the pods; prod uses versioned tags and leaves it empty.
- **D2.13 NetworkPolicy ownership.** The woo-mcp chart owns its own flows: ingress from
  gateway pods in `platform`, egress to WordPress :80, and the matching ingress rule on
  WordPress. It relies on the store chart's namespace-wide default-deny and DNS rules.
  Verified matrix:

  | Source → destination | Result |
  |---|---|
  | `upstreams` → woo-mcp | blocked |
  | `platform` non-gateway pod → woo-mcp | blocked |
  | other `store` pod → woo-mcp | blocked |
  | gateway-labelled pod → woo-mcp | allowed |
  | woo-mcp → internet | blocked |
  | woo-mcp → MariaDB | blocked |
  | woo-mcp → WordPress | allowed |

- **D2.14 Tool results are JSON text content.** There's no `outputSchema` or
  `structuredContent`. Every MCP client and LLM handles text, and the shapes are small and
  stable.

### Phase 3 — Gateway core

- **D3.1 Build order and seams.**
  - `dispatch()`, `aggregateTools()`, tool naming, the permission policy, crypto, and the
    SSRF guard are pure modules written test-first.
  - Everything stateful sits behind small interfaces: `UpstreamManager` +
    `Connector`/`UpstreamSession`, `Registry`, and the audit writer.
  - `Core` wires them together and is the only thing `/mcp` (and, in Phase 6, chat) uses.
- **D3.2 Integration tests use PGlite** (Postgres compiled to WebAssembly, in-process).
  They run the real migrations, real seeding, the real Fastify app, and real MCP SDK
  clients against `/mcp`; only the upstream connector is faked. No Docker is needed, and
  the suite runs inside the image build.
- **D3.3 Postgres is its own chart, `charts/postgres`**, a dependency of the platform
  umbrella. This adds to the section-3 layout: the spec makes postgres a toggleable
  dependency but lists no chart directory for it. It uses the official `postgres:16.15`
  image, not Bitnami, whose free images are discontinued.
  - Runs as uid 999 with a read-only root filesystem and `PGDATA` in a subdirectory of
    the 2Gi PVC (avoids `lost+found`).
  - Readiness uses `pg_isready` over TCP, so the init-time server isn't counted as ready.
- **D3.4 Migrations run at gateway startup under a Postgres advisory lock.** Drizzle-kit
  SQL migrations are committed in `gateway/drizzle/`. With 2 prod replicas starting
  together, exactly one migrates and seeds; the other waits, then finds nothing to do.
- **D3.5 Seeding semantics.**
  - **Admin:** created only when `users` is empty; `ADMIN_PASSWORD` is used once.
  - **Built-in WooCommerce upstream:** created if missing. Its URL and token are
    **deployment-managed**: re-applied on boot when they differ, which is how the token is
    rotated and how a changed `CREDENTIAL_ENC_KEY` re-encrypts it. Admins can
    enable/disable/rename it, but URL and credential edits are refused with a clear error,
    since they would silently revert on the next boot.
  - **Permission rules:** inserted if missing; admin edits are never overwritten.
- **D3.6 Multi-replica consistency.** Postgres is the only source of truth. Each replica
  re-reads the (tiny) `upstreams` table on every list, every dispatch, and every health
  tick, and syncs its manager. So an enable/disable/delete on replica A applies to the
  next request on replica B. Connection health is per replica, which is correct, since
  each replica has its own connections.
- **D3.7 Upstream status model.**
  - The API reports `connected | unreachable | disabled`, plus an internal `pending` (not
    tried on this replica yet), which is shown as unreachable with "not checked yet".
  - The health check is connect-if-needed + `tools/list` (3 s). For a stateless upstream a
    fresh `initialize` on every tick would only add load; a reconnect does a full
    `initialize`.
  - "Confirmed gone" = 2 failures in a row. Until then, cached tools stay listed but calls
    fail fast.
  - **Only transport failures mark an upstream down.** Timeouts and JSON-RPC errors don't:
    a deliberately slow tool shouldn't take a healthy server offline.
- **D3.8 Untrusted tool metadata.** Descriptions are capped at 1024 characters. The
  upstream's own URL and credential are scrubbed from them, so a hostile or careless
  upstream can't leak them through `tools/list`. Prompt-injection risk is covered in the
  threat model.
- **D3.9 Permissions.**
  - The `tool_permissions` table maps an exposed tool name to its allowed roles. Admins
    are always allowed.
  - Members get tools with **no** rule according to `DEFAULT_MEMBER_TOOL_ACCESS`, which
    defaults to `allow`, so that newly added servers (e.g. notes) are usable by the team.
    Restricted tools must be listed explicitly. The seeded defaults implement the spec.
  - Enforced in `dispatch()` and in `tools/list` (tested both ways).
  - The admin editing UI and API come in Phase 7.
- **D3.10 Dashboard sessions.**
  - The cookie (`tmg_session`) holds a random 32-byte token. The DB holds
    HMAC-SHA256(`SESSION_SECRET`, token), so a DB dump yields no usable cookies.
  - The cookie is `HttpOnly`, `SameSite=Lax`, `Secure` when TLS is on, and lasts 12 h.
  - Logout deletes the row; disabling a user deletes all their sessions.
  - **CSRF:** `SameSite=Lax` keeps the cookie off cross-site POST/PATCH/DELETE. Mutating
    routes accept JSON bodies only, which a cross-site HTML form can't send without a CORS
    preflight (there's no CORS). No CSRF token is needed on a same-host app.
- **D3.11 Login hardening.**
  - Rate limits are counted **in Postgres**, per IP and per email (5 failures per 15 min),
    so they hold across replicas.
  - The client IP is read with `trustProxy` limited to exactly 1 hop (ingress-nginx), so a
    client can't spoof `X-Forwarded-For`.
  - "No such user" and "wrong password" give the same error and take the same time (a
    dummy argon2 verify runs for unknown emails).
  - A disabled user who gives the correct password gets 403 `USER_DISABLED`.
- **D3.12 API keys** are hashed with **SHA-256, not argon2**. The secret has 256 bits of
  entropy, so there's nothing to brute-force, and it's verified on every MCP request.
  - Lookup is by the unique 8-character prefix, followed by a constant-time hash compare.
  - Checked against the DB on every request (revoked → 401, disabled user → 403),
    verified live.
  - `last_used_at` is written at most once a minute per key.
- **D3.13 Credential encryption: AES-256-GCM** with a fresh 12-byte nonce per encryption
  and the auth tag appended to the ciphertext. The AAD is `upstream:<row id>`, which
  binds each ciphertext to its row: copying an encrypted credential onto another row
  fails to decrypt (tested).
- **D3.14 SSRF policy.**
  - Allowed: `*.svc.cluster.local`, plus an explicit allowlist (`UPSTREAM_HOST_ALLOWLIST`,
    exact names or `.suffix`).
  - Public hostnames only with `ALLOW_PUBLIC_UPSTREAMS=true` (off by default), and then
    only if they resolve to **public** addresses.
  - IP-literal URLs and `localhost` are rejected.
  - Loopback, link-local (incl. 169.254.169.254), unspecified, multicast, and IPv4-mapped
    forms of these are always blocked.
  - The check runs at registration **and on every new connection**: undici's DNS lookup
    hook checks the exact addresses the socket uses, which defeats DNS rebinding. A
    kept-alive connection isn't re-resolved, but its peer address can't change either.
- **D3.15 Audit.**
  - One row per dispatch, in every case.
  - Upstream `isError` results get `error_code = TOOL_ERROR`, so they can be filtered
    apart from gateway errors.
  - `args_summary`: values under sensitive-looking keys are replaced, long strings are cut
    to 40 characters, and the whole summary to 200.
  - If writing the row fails, the call result is still returned (the call may already have
    changed data) and the failure is logged loudly.
  - Pagination is keyset on the id, which stays stable while rows are being inserted.
- **D3.16 REST API shape.**
  - Responses are snake_case views that **allow-list** fields: `password_hash`,
    `key_hash`, and `cred_encrypted` can't leak by accident.
  - Members get server names, status, and tools, but **not URLs or credential settings**.
  - `POST /api/keys` returns `{key, secret}`, and `secret` is never shown again.
  - `POST /api/users` generates a strong initial password when none is given.
  - A server is saved even when its test connection fails; an SSRF failure, by contrast,
    is a hard 400.
  - The last active admin can't be demoted or disabled.
- **D3.17 `/mcp`.** Stateless Streamable HTTP, a fresh SDK `Server` per request bound to
  the caller, JSON responses (not SSE). Missing/invalid/revoked key → 401 with
  `WWW-Authenticate`, disabled user → 403, `GET`/`DELETE` → 405. Tradeoff: no
  `notifications/tools/list_changed`; clients see changes on their next `tools/list`.
- **D3.18 One host for dashboard and API.** The Ingress routes `/api`, `/mcp`, and
  `/healthz` (Exact) to the gateway, and `/` to the dashboard (Phase 5). `/metrics` is
  deliberately not routed. Proxy buffering is off and timeouts are 180 s, for slow tools
  and the Phase 6 SSE stream. The gateway serves no static files: nginx serves the
  dashboard, so the spec's "static dashboard fallback" lives in the dashboard image
  (Phase 5).
- **D3.19 Platform NetworkPolicy (deny by default).**
  - Allowed: ingress-nginx → gateway; gateway → Postgres, woo-mcp, and `upstreams/*:8080`;
    DNS.
  - Verified blocked: other namespaces → Postgres or gateway; gateway → internet,
    MariaDB, or WordPress (it can't bypass woo-mcp).
- **D3.20 Dependencies.** argon2 uses its bundled prebuilt binaries (including musl
  arm64/x64), and its install script stays disabled in `allowBuilds`. undici is used only
  to attach the SSRF lookup hook to upstream connections.

### Phase 4 — Upstreams

- **D4.1 Small, deliberately duplicated server scaffold.** `mcp-notes` and `mcp-slow` each
  carry about 100 lines of identical scaffold: `auth.ts` (constant-time bearer check,
  per-request token read), `log.ts`, and `http.ts` (stateless Streamable HTTP, `/healthz`,
  405 for GET/DELETE). `mcp-slow`'s copies are marked "same as mcp-notes". A shared
  workspace package would remove the duplication, but it would add a fourth package
  outside the spec's layout and a build-order dependency for three tiny servers. Revisit
  if a fourth server appears.
- **D4.2 Notes storage.** Notes are kept in memory and mirrored to `/data/notes.json` on an
  emptyDir, so they survive a container restart but not pod deletion (persistence isn't
  required). Writes are serialized and atomic (write-then-rename). Storage is capped at
  1000 notes, oldest dropped, so a loop can't exhaust memory.
- **D4.3 mcp-slow behaviour knobs** (env vars):
  - `ECHO_DELAY_MS`, default 15000, longer than the gateway's 10 s timeout, plus a
    per-call `delay_ms` override for a fast echo.
  - `FLAKY_FAILURE_RATE`, default 0.5; `flaky` fails with an `isError` tool result.
  - `ALLOW_CRASH`: **off by default** in the image, **on in `values-local.yaml`**, and
    **off in `values-prod.yaml`**. When it's off, `crash` isn't even registered.
  - At the gateway, `slow__crash` is admin-only (seeded permission rule): hidden from
    members' `tools/list`, and `[FORBIDDEN]` if called directly (verified).
  - `crash` answers first, then exits 200 ms later, so the caller gets a clean response.
- **D4.4 `STARTUP_DELAY_MS`** (20 s locally) makes mcp-slow boot slowly. Without it a
  restarted pod is back within 1–2 s and the demo can't show the "unreachable until it
  recovers" state. A `startupProbe` (2 s × 45 = 90 s budget) covers the slow boot, so the
  liveness probe can stay strict.
- **D4.5 One generic chart, `upstream-mcp`, selected with `--set instance=<name>`.**
  - Instances are defined in the shared values (`upstreams.instances.<name>`). They differ
    in image, port, Secret name, and a small `env` map; the env map is needed for the
    spec's `ALLOW_CRASH` switch.
  - The chart **rejects unknown instance keys**. A mis-indented env var silently vanished
    once during this phase; it now fails `helm template` with a pointed message.
  - `helm-check.sh` renders both instances for both environments.
- **D4.6 NetworkPolicy ownership in a shared namespace.**
  - Every release fully locks down its own pods: ingress only from gateway pods in
    `platform` on its port, egress only to DNS.
  - Exactly one release, `upstreams.namespaceOwner` (mcp-notes), also owns the
    namespace-wide `default-deny-all` and `allow-dns-egress`, because two releases can't
    own the same object.
  - If mcp-notes were uninstalled, the namespace-wide default would go with it, but each
    remaining server's own policy still isolates it.
  - Verified (10 flows): upstreams can't reach each other, platform, store, or the
    internet. Only the gateway reaches them; an unlabelled pod in their own namespace is
    blocked.
- **D4.7 TCP connect timeout for upstream calls (3 s), separate from the tool timeout.**
  - **Found during the crash test:** a Kubernetes Service with no ready endpoints silently
    **drops** new connections. Through the Service the connection hung, while the pod IP
    refused it in 2 ms (measured).
  - **Before the fix:** the first call after a crash hung for the full 10 s, came back as
    `[TIMEOUT]`, and left `slow` "connected", since timeouts deliberately don't mark a
    server down.
  - **Now:** undici's connect timeout (`UPSTREAM_TCP_CONNECT_TIMEOUT_MS`, default 3 s)
    turns "can't open a connection" into a transport error. The first call fails in about
    3.6 s with `UND_ERR_CONNECT_TIMEOUT`, the server is marked unreachable, and every
    later call fails in about 40 ms.
  - A slow *tool* on a live connection is still a `TIMEOUT` at 10 s and the server stays
    connected (verified).
  - Also: `classifyError` now walks the fetch error's cause chain, so `last_error` and
    SSRF blocks show the real reason instead of "fetch failed". This was found when a test
    hit fetch's "bad port" list.
- **D4.8 The first call after a death is `UPSTREAM_ERROR`, the rest `SERVER_UNREACHABLE`.**
  The first call is the one that discovers the failure, and spec step 6 classifies
  transport errors as `UPSTREAM_ERROR`. From then on, the gateway knows and fails fast
  without contacting the upstream (spec step 4).
- **D4.9 Notes and slow are registered by an admin through the API, not seeded.** Their
  bearer tokens live only in their own Secret (`upstreams/mcp-*-secrets`) and, encrypted,
  in the gateway's DB. `scripts/register-upstreams.sh` (run by `up-local.sh`, idempotent) registers them
  through the same admin API, so a fresh cluster has all three servers.
- **D4.10 Recovery time is the sum of three backoffs:** Kubernetes container-restart
  backoff (grows on repeated crashes), plus the startup delay, plus the gateway's reconnect
  backoff (1 s doubling, capped at 60 s). Measured: 32 s after a pod deletion, and 51 s
  after a second crash of the same container.

### Phase 5 — Dashboard

- **D5.1 React Router 7.18, not 8.** React Router 8 requires React ≥ 19.2. The spec pins
  React 18, so the dashboard uses React 18.3.1 with React Router 7.18.4 (peer
  `react >= 18`). Everything else (TanStack Query 5, Radix, lucide, sonner) supports both.
  Vite 8 and Tailwind 4 (via `@tailwindcss/vite`) are used.
- **D5.2 shadcn/ui components are written as source files, without the CLI.** shadcn is
  "copy the component source into your repo". The interactive CLI was skipped, and the
  components in `src/components/ui/` follow its patterns (Radix primitives + `cva` +
  `cn()`). The `button-class.ts` helper gives Radix `AlertDialog` actions the button look.
- **D5.3 No configuration in the bundle.**
  - The dashboard is same-origin with the API, so it needs no URLs at all: API calls are
    relative, and the Connect page shows `window.location.origin + "/mcp"`.
  - `envPrefix` is set to a prefix nothing uses, so Vite can't inline a stray `VITE_*`
    variable.
  - No source maps are shipped.
  - Verified on the deployed image: none of the 14 `.env` values, no `process.env` or
    `VITE_` references, no `.map` files, and no inline `<script>`.
- **D5.4 Secrets are shown once.** New API keys and new users' initial passwords appear
  only in `OneTimeSecret`: read-only input, Copy button, and a "won't be shown again"
  warning. Closing it calls `mutation.reset()`, which drops the only in-memory copy (the
  mutation result).
  - Verified in the browser: after closing, the secret is in neither the DOM nor any input
    value.
  - Afterwards keys are only ever shown as `wk_<prefix>_••••••••`.
  - Upstream credentials are write-only form fields that are never loaded back.
- **D5.5 Auth in the UI.**
  - `/api/me` decides routing.
  - A 401 from any query or mutation clears the cache and goes to `/login`.
  - Admin-only routes redirect members. That's a convenience: the gateway enforces every
    rule anyway.
  - The API's own error messages are shown, never stack traces. Network failures and HTML
    error pages map to generic text.
- **D5.6 nginx-unprivileged 1.31.6** serves the build on 8080 as uid 101, with a read-only
  root filesystem (`/tmp` emptyDir) and the image's entrypoint scripts bypassed.
  - **Caching:** hashed `/assets/*` are immutable for a year; `index.html` and SPA routes
    are `no-cache`; a missing asset is a real 404, not the app shell.
  - **Security headers** (CSP `script-src 'self'`, `connect-src 'self'`,
    `frame-ancestors 'none'`, `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy
    no-referrer`, `Permissions-Policy`, COOP) live in a snippet included by every
    `location`. nginx's `add_header` in a location replaces the server-level ones, so this
    keeps them on every response, including assets (verified).
  - **`style-src` keeps `'unsafe-inline'`**: Radix's scroll lock injects a `<style>`
    element at runtime. Inline *styles* can't execute code; scripts stay `'self'`-only.
- **D5.7 Live status.** The Servers page polls every 10 s, so a server going down or
  recovering shows up without a reload. The status badge is green, red with `last_error`
  in a tooltip, or grey.
- **D5.8 How the UI was verified.** In a real browser (Playwright) at 1280×860, against
  the **production bundle** served by `vite preview` on `localhost:4173`, proxying `/api`
  to the cluster. This let the check sign in with dedicated test users created for this
  purpose, whose credentials are in the gitignored `.env.ui-test.local`. The nginx-specific
  behaviour (headers, SPA fallback, 404s) was verified separately against the deployed
  `hub.localtest.me`.
- **D5.9 Out of scope until later phases:** the Chat page (Phase 6), the permission editor
  and per-server error rate / latency on the Audit page (Phase 7).
- **D5.10 UX hardening after a full QA pass** (2026-10-12). Screenshots of every page at
  1280 px, plus automatic checks. Changes:
  - **Audit table fits at 1280 px.** Fixed column widths sized to real values, truncation
    with hover titles, `10.0 s` durations, compact timestamps. The Error code column had
    been clipped inside the card.
  - **Confirm before you lock someone out.** Disabling a user or changing a role now asks
    first and explains the consequence; previously it was one click and took effect at
    once.
  - **Accessible row expanders.** Real `<button aria-expanded>` controls, so rows expand
    from the keyboard.
  - **Layout and navigation:** a sticky sidebar (account and Log out always visible),
    per-page browser titles, dimmed disabled users, a flowing filter bar (no gap for
    members), and a network icon.
  - **Guidance:** a health summary on Servers (connected / unreachable / disabled, and
    which server to check), a "next: open Connect" hint after creating a key, and "ask your
    admin" on the login page.
  - Every item is verified by a browser check (23 of 23 pass).

### Phase 6 — Chat agent

- **D6.1 Provider: Groq by default, through any OpenAI-compatible endpoint.** The `openai`
  SDK is pointed at `LLM_BASE_URL` with `LLM_MODEL` and `LLM_API_KEY` (the key lives in
  `gateway-secrets`). Switching is a values change: Gemini
  (`https://generativelanguage.googleapis.com/v1beta/openai/`) or Ollama
  (`http://<host>:11434/v1`, no key). Groq was chosen over local Ollama for the 16 GB
  development machine: no 5 GB download, fast, and larger models call tools more reliably.
  It's a hosted, free-tier service, not open source (see the privacy note in the threat
  model).
- **D6.2 Chat uses exactly the /mcp path.** Tools come from `Core.listTools(role)`, the
  same permission-filtered list as `tools/list`. Every call goes through
  `Core.dispatch({source: "chat"})`, so it gets the same checks and an audit row with the
  user's id. If the model calls a tool it wasn't offered (hallucinated, or hidden from the
  role), the name still goes to `dispatch()`, which refuses it (`TOOL_NOT_FOUND` /
  `FORBIDDEN`) and audits it.
- **D6.3 No chat state on the server.**
  - The browser sends the conversation with each message: user and assistant *text* only,
    at most 40 messages of 8,000 characters (the client sends the last 20).
  - Tool calls and results are never accepted from the client, so they can't be forged.
  - Any replica can answer, and nothing is stored. Closing the tab, logging out, or
    reloading ends the conversation.
- **D6.4 SSE over POST.** `POST /api/chat` takes over the response and writes
  `event:/data:` blocks: `text`, `tool_call`, `tool_result`, `done`, `error`.
  - A `: keep-alive` comment every 15 s and `X-Accel-Buffering: no` keep events flowing
    through ingress-nginx, which has proxy buffering off and a 180 s timeout.
  - A client disconnect aborts the provider request and stops the loop.
  - The dashboard reads the stream with `fetch`, because `EventSource` can't POST.
- **D6.5 Loop behaviour.**
  - At most `CHAT_MAX_ITERATIONS` (8) model rounds, then the user is told it stopped.
  - Tool results are cut to `CHAT_MAX_RESULT_BYTES` (8 KB), at a UTF-8-safe boundary.
  - Tool errors go back to the model as `ERROR: [CODE] …`, so it can explain or retry.
  - Malformed JSON arguments are never sent to a tool. The model gets a correction
    (`INVALID_ARGUMENTS`); no audit row is written because no tool was called.
- **D6.6 Tool names.** Providers require function names to match `^[a-zA-Z0-9_-]{1,64}$`,
  and MCP names may contain `.`. Names are mapped (`.` → `-`, truncated, de-duplicated) and
  mapped back before dispatch.
- **D6.7 System prompt.** It states the user's role and today's UTC date (so "today" means
  `after=<date>T00:00:00Z`), requires tools for live data, forbids inventing data, asks for
  errors to be reported with their code, and says tool output is **data, not
  instructions**.
- **D6.8 Cost and abuse limits.** One running chat per user per replica (429
  `CHAT_BUSY`), the 8-round cap, a 60 s provider timeout (`LLM_TIMEOUT_MS`), and one SDK
  retry.
- **D6.9 Not configured means turned off, not broken.** With a hosted provider and no
  key, `/api/chat` answers 503 `CHAT_UNAVAILABLE` with an admin-facing reason (verified
  live). Local or cluster endpoints (Ollama) need no key.
- **D6.10 NetworkPolicy for the LLM.** The gateway may connect to TCP 443 on
  **public** addresses only (`0.0.0.0/0` except RFC 1918, CGNAT, and link-local). Verified:
  Groq is reachable; an in-cluster 443 Service and WordPress stay blocked. NetworkPolicy
  can't match hostnames, so the gateway could reach any public 443 endpoint. The
  production hardening is an egress proxy with a hostname allowlist, or an FQDN-aware CNI
  policy (Cilium); see Production changes. For Ollama on a known host, the values file
  narrows the rule to that host's /32 on 11434.
- **D6.11 Dashboard chat.**
  - Answers stream into place.
  - Model output goes through a tiny Markdown-to-React renderer: no HTML strings, so
    nothing can be injected.
  - A side panel lists each tool call of the current answer: server, tool, a spinner
    while running, duration, outcome, and an expandable args and result preview (opened
    automatically on errors).
  - Suggested prompts are role-aware, and there are Stop and New chat buttons. The
    conversation survives page switches and is cleared on logout.
- **D6.12 Customer-data masking before the LLM** (approved by the owner on 2026-10-12;
  `gateway/src/chat/privacy.ts`). Everything sent to the provider is masked first: tool
  results and the conversation history.
  - Customer names become `Customer_402913`; emails become
    `customer_402913@masked.invalid`, with the same number as the name.
  - Phone numbers become `[phone hidden]`.
  - Street lines, company, IP address and user agent are removed. City, state, postcode
    and country are kept for shipping questions. To allow this, mcp-woo now returns
    `billing.address` as an object rather than one string.
  - **Pseudonyms are deterministic.** They are an HMAC of the email (or the name) under a
    key derived from `SESSION_SECRET` with HKDF, so a customer keeps one pseudonym across
    turns and requests.
  - **Real values come back only for the user's own screen.** The gateway keeps a per-user,
    in-memory pseudonym→value map and swaps real values back in only on the text streamed
    to that user. A streaming unmasker holds back a pseudonym split across deltas.
  - **Re-sent history stays masked.** The `done` event carries `model_text`, the answer as
    the model wrote it, and the browser sends that back as history. So real names on
    screen never go back to the provider, even after a gateway restart.
  - The tool-call side panel shows the real result, because it goes to the user, not the
    provider.
  - **Tool arguments are not unmasked.** Notes the assistant writes keep customers as
    pseudonyms (trade-off: privacy over readability).
  - **Limits:**
    - Free text is best effort: known names, any email, and `+`-prefixed or 3-3-4 phone
      numbers are caught; an unknown name inside a customer note is not.
    - A user's own typed message is masked only for customers the vault already knows,
      plus any email or phone number.
    - The vault is per replica, so behind several replicas a pseudonym may stay
      unrevealed on screen. This fails safe.
  - `CHAT_PII_MASKING` (default `true`) turns it off. The Chat page reads
    `GET /api/chat/status` and says whether masking is on.
  - `/mcp` is not masked: MCP clients are the team's own tools.
- **D6.13 Model.** `llama-3.3-70b-versatile` is not offered to this Groq account
  (`/models`, checked 2026-10-12). The default is now `openai/gpt-oss-120b` (open
  weights, Apache-2.0, tool calling).
  - `LLM_REASONING_EFFORT=low` (new, optional; not sent when empty) keeps its reasoning
    tokens within the free tier's tokens-per-minute limit. The first UI run, at the
    default effort, hit a 429; the friendly rate-limit message was shown.
- **D6.14 Phone-width dashboard.**
  - Below 768 px the sidebar becomes a drawer opened from a top bar. It closes on
    navigation and is `inert` while closed.
  - The Chat tool-call panel becomes a collapsible strip above the input.
  - Tab lists scroll horizontally.
  - Verified: no page-level horizontal scroll at 390 px on Servers, Chat, My Keys,
    Connect and Audit.
- **D6.15 React effect returning a Promise.** Current Chrome returns a Promise from
  `scrollIntoView`. `useEffect(() => el.scrollIntoView())` therefore handed React a
  non-function "cleanup", and the Chat page went blank on the first message. Effects now
  use block bodies. Found by the headless UI run.
- **D7.1 Permission editor.** `GET /api/permissions` is open to any user (members see it
  read-only, as the spec's "which roles can call which tools" view). `PUT` and `DELETE
  /api/permissions/:tool` are admin-only.
  - Admins can always call everything (section 10), so the editable bit is "members may
    call this tool". `DELETE` drops the rule, and the tool falls back to
    `DEFAULT_MEMBER_TOOL_ACCESS`.
  - Rules are read from Postgres on every listing and call (`Core.loadPolicy`), so an
    edit applies at once to `/mcp` tools/list, direct calls (FORBIDDEN), the chat agent,
    and every replica. Tested in the integration tests and by `e2e-dod.sh`.
  - A rule may name a tool that isn't listed yet (any well-formed `<slug>__<tool>`), so
    an admin can restrict a tool before its server is added.
  - Changes are logged (`tool permission changed`, with the admin's id). They are not in
    `audit_log`, which records tool calls only.
- **D7.2 Metrics on a separate port.** `/metrics` is served on `METRICS_PORT` (9090) by a
  bare `node:http` listener that answers only `GET /metrics`.
  - The Ingress only routes to the API port, so `/metrics` can't be exposed by a routing
    mistake. The `gateway-metrics` NetworkPolicy admits only
    `networkPolicy.metricsScrapeNamespaces` (default `monitoring`).
  - `kubectl port-forward` still works for local viewing; it doesn't pass through
    NetworkPolicy.
  - The chart adds `prometheus.io/*` annotations to the pod and Service, and a named
    `metrics` Service port for a ServiceMonitor. Nothing requires Prometheus.
- **D7.3 Metric labels are bounded.** `server` is a registered slug, `tool` a name the
  upstream really exposes, and `code` one of the fixed error codes. Calls to made-up
  names are counted as `(unknown)`, so a caller can't create unbounded series.
  - `mcp_gateway_upstream_up` is computed at scrape time from the registry and this
    replica's manager, so deleted servers disappear.
  - Process metrics (`mcp_gateway_process_*`, `nodejs_*`) come from prom-client
    15.1.3 (Apache-2.0).
  - Counters are per replica; Prometheus sums them.
- **D7.4 Audit stats.** `GET /api/audit/stats?minutes=60` (5–1440) is computed in SQL from
  `audit_log`, per server:
  - calls;
  - errors = `error`, `timeout` and `unreachable`; error rate = errors / calls;
  - denied = `denied` and `disabled` (policy refusals, not server failures);
  - average latency over calls that reached the upstream (`ok`, `error`, `timeout`), so
    instant refusals don't flatter it.
  - Members get stats for their own calls only, like the audit log. The Audit page shows
    one card per server and refreshes every 30 s.
- **D7.5 `e2e-dod.sh`.**
  - It drives the live deployment with curl, jq and kubectl, following section 19 step by
    step, then the Phase 7 checks and audit attribution.
  - User A is the admin, from `.env`. User B is a member created per run and disabled at
    the end; their keys are revoked.
  - Secrets go to curl through stdin or 0600 files in a private temp dir, and are never
    printed or put on a command line.
  - Chat steps retry once, because LLMs are non-deterministic and free tiers rate-limit.
  - "Visible in WooCommerce admin" is checked through the WooCommerce REST API (the data
    wp-admin shows), with a short-lived admin key.
  - Created products, orders and notes are left in place as test data.
- **D8.1 Production policy as code.** `scripts/policy-check.mjs` renders every chart with
  both values files and checks the spec's rules over the output. It runs inside
  `helm-check.sh`, so it gates every release. The rules:
  - probes and requests/limits on every container;
  - the security-context rules;
  - no host access; tokens only where needed; pinned images, and pull policy per
    environment;
  - no Secrets in charts and no literal secret env values;
  - default-deny NetworkPolicies, no allow-all rules, ClusterIP-only Services;
  - TLS and hosts per environment; PVC storageClass; gateway replicas;
  - no ClusterRoles, and Roles limited to named resources.

  Exceptions must be listed in the script with a reason; currently there are none. It
  was checked against deliberately broken values (`:latest`, the wrong pull policy,
  NetworkPolicies off, the wrong replica count): every one was caught. It needs no
  cluster; the YAML parser is `yaml` 2.9.0 (ISC), a root dev dependency.
- **D8.2 WordPress system cron in production.**
  - With TLS on, WP-Cron's loopback request to `https://<storeHost>` can't work from
    inside the pod (D1.12). So `wordpress.systemCron.enabled` (on in prod) sets
    `DISABLE_WP_CRON`, and a CronJob calls `wp-cron.php` every 5 minutes through the
    in-cluster Service. Due events then run, including WooCommerce's Action Scheduler.
  - It reuses the WordPress image (its PHP CLI) with the same restricted security
    context, no service-account token, and NetworkPolicy access to WordPress:80 only.
  - Bug found while testing: passing `?doing_wp_cron=<time>` made WordPress return early,
    because it only honours that value when it matches a lock it set itself. The
    response was still HTTP 200, but nothing ran.
  - Verified locally: a past-due probe event was consumed by one Job run. Local keeps
    page-load cron with the loopback `hostAliases`.
- **D8.3 cert-manager HTTP-01 under default-deny.** The ACME solver pod runs in the
  namespace that owns the certificate (platform or store), where default-deny would block
  ingress-nginx from reaching it, and the certificate would never be issued. With TLS on,
  both charts add `acme-http01-solver`: ingress-nginx → pods labelled
  `acme.cert-manager.io/http01-solver: "true"`, port 8089, ingress only.
- **D8.4 Zero-downtime rollouts.**
  - The gateway, dashboard, woo-mcp and upstreams get a `preStop` `sleep 5`, so a
    terminating pod keeps serving until the Ingress and Service stop routing to it. Then
    SIGTERM starts the existing graceful shutdown.
  - Measured with 2 gateway replicas while continuously calling `/healthz` and
    `/api/me` through the Ingress: before, 2 of 8,266 requests failed; after, 0 of about
    20,000 across two rolling restarts.
  - The gateway's `terminationGracePeriodSeconds` (20) covers the 5 s preStop plus its
    10 s drain.
- **D8.5 Deploy tooling.**
  - `deploy-prod.sh` (idempotent; refuses Kind contexts, leftover placeholders and
    `latest`) installs:
    - ingress-nginx 4.15.1: LoadBalancer via k3s ServiceLB, with
      `externalTrafficPolicy: Local` so per-IP login limits see real client IPs, and
      snippet annotations off;
    - cert-manager v1.21.2, with CRDs;
    - a Let's Encrypt ClusterIssuer (HTTP-01; a staging URL is supported);
    - the Secrets and the five releases.
  - `--dry-run` validates everything server-side and changes nothing.
  - Verified: the dry run against Kind with prod values passed all steps (into scratch
    namespaces under Pod Security restricted) and changed nothing. ingress-nginx
    revision unchanged, cert-manager not installed.
  - `build-push.sh` builds versioned images (tests run in the build) and pushes. It
    refuses `latest`/`local` and the `your-org` placeholder.
  - Cross-architecture builds (Apple Silicon → amd64 VPS) need `docker buildx`. The
    classic builder can't do it; tried and confirmed. Building on the VPS avoids it.
- **D8.6 Private registry pull secret.** Optional `REGISTRY_SERVER`, `REGISTRY_USERNAME`
  and `REGISTRY_TOKEN` in `.env` make `create-secrets.sh` create a
  `kubernetes.io/dockerconfigjson` Secret `registry-pull` in all three namespaces.
  - The token reaches jq through the environment, never argv.
  - Setting only some of the three is refused.
  - Our four workload charts render `imagePullSecrets` from `global.image.pullSecrets`.
  - Verified with a fake token (decoded config correct, auth matches), then removed.
- **D8.7 Backups.** `scripts/backup.sh` writes three files, mode 0600 in a 0700
  directory, under `backups/`, which is gitignored:
  - a MariaDB dump (`--single-transaction`; the password via `MYSQL_PWD` inside the pod);
  - a `wp-content` tarball;
  - a Postgres custom-format dump.

  Each file is sanity-checked. A restore test into scratch databases matched live row
  counts exactly. `.env` is deliberately not included: without the same
  `CREDENTIAL_ENC_KEY`, the restored upstream credentials can't be decrypted, so `.env`
  is kept separately.
- **D8.8 Two gateway replicas.**
  - Shared state already lives in Postgres: sessions, login rate limits, permissions,
    the registry, audit. Migrations take an advisory lock; `/mcp` is stateless.
  - Per-replica by design:
    - upstream health: each replica's manager learns about a dead upstream from its own
      checks (30 s) or failed calls. A call that lands on a replica that hasn't noticed
      yet still ends in SERVER_UNREACHABLE, after at most the 3 s connect timeout;
    - the one-running-chat-per-user guard;
    - the chat pseudonym map (D6.12, fails safe);
    - Prometheus counters.
  - Verified: the full `e2e-dod.sh` passed 62/62 with 2 replicas.
- **D10.1 Multi-store provisioning (bonus): who does what.**
  - **Gateway:** owns the desired state, a `stores` table (migration `0001_stores`,
    expand-only), and the API (`GET/POST/DELETE /api/stores`).
  - **Reconciler:** runs in the gateway every 5 s.
  - **Provisioner:** a separate service (`provisioner/`, `charts/provisioner`) that does
    every Kubernetes and Helm action. The gateway itself still has **no** Kubernetes API
    token.
  - **The flow:**
    1. `POST /api/stores {name}` stores a row (`provisioning`, deadline now + 15 min)
       with a fresh woo-mcp bearer token (AES-256-GCM, AAD `store:<id>`).
    2. The reconciler calls the provisioner's `PUT /v1/stores/store-<name>` until it
       answers `ready`.
    3. The gateway registers `http://woo-mcp.store-<name>.svc.cluster.local:8080/mcp` as
       upstream `store-<name>`, so the tools are `store-<name>__list_orders` and so on.
       It adds admin-only rules for that store's `create_product` and
       `update_order_status`, matching the main store.
  - **Delete:**
    1. `DELETE /api/stores/:id` → `deleting`.
    2. The reconciler first unregisters the upstream and its permission rules, so the
       tools vanish on the next request.
    3. Then it calls the provisioner's `DELETE`: `helm uninstall` for both releases, then
       delete the namespace.
    4. The row is removed once the provisioner reports `gone`.
- **D10.2 Fencing the provisioner, the only component with cluster rights.**
  - **Cluster-wide ClusterRole `team-mcp-provisioner`:** namespaces get/create/delete,
    `create rolebindings`, and `bind` on exactly one ClusterRole. Nothing else: it can't
    even list namespaces.
  - **`team-mcp-store-tenant`:** the namespaced rights Helm needs. It's never bound
    cluster-wide; the provisioner binds it to itself inside each store namespace it
    creates.
  - **A ValidatingAdmissionPolicy** (in-tree, no webhook) denies every
    create/update/delete by the provisioner's ServiceAccount that doesn't target a
    `store-*` namespace or an object in one. It also requires new namespaces to carry
    `team-mcp/tenant=true`.
  - **Kubernetes' own escalation check** stops it from binding anything it doesn't hold,
    such as `cluster-admin`.
  - **Probed live by impersonating the ServiceAccount.** Denied:
    - reading platform Secrets;
    - deleting `platform` or `store`;
    - creating `evil`;
    - binding the tenant role in `platform`;
    - binding `cluster-admin` inside a store namespace;
    - an unlabelled `store-*` namespace.

    Allowed: only the intended path.
  - `scripts/policy-check.mjs` pins the cluster role rule for rule, and fails if the
    policy or its Deny binding goes missing.
- **D10.3 Each store namespace.**
  - Pod Security `restricted`, labels `team-mcp/tenant=true` and `team-mcp/store`.
  - The store chart's deny-by-default NetworkPolicies, so other stores can't reach in:
    WordPress takes only ingress-nginx, woo-mcp only the gateway.
  - A **ResourceQuota**: 1 CPU / 2 GiB requested, 6 CPU / 4 GiB limits, 10 pods, 3 PVCs,
    20 GiB storage, no LoadBalancer or NodePort Services. Plus a **LimitRange** (max 2
    CPU / 2 GiB per container). Both come from the store chart's `tenant.enabled`.
  - Its own Secrets, generated by the provisioner: MariaDB passwords, the WP admin
    account, the salt, and the gateway's bearer.
  - Releases: `store-<name>` (store chart) and `store-<name>-mcp` (woo-mcp chart), the
    same charts as the main store. Environment settings come from the values file through
    the provisioner's `tenant-values` ConfigMap. Host: `store-<name>` +
    `global.stores.hostSuffix`.
  - Gateway egress reaches woo-mcp only in namespaces labelled `team-mcp/tenant=true`
    (the provisioner API: port 8080 only).
- **D10.4 Guardrails.**
  - `maxPerUser` (local 2) and `maxTotal` (local 3, sized to the 8 GB VM). Any signed-in
    user may create stores; members see and delete their own, admins see and delete all.
  - Names are DNS labels, 2–24 characters.
  - The `store-` slug prefix is reserved: the Servers page can't create one, and can't
    edit or delete a store's server.
- **D10.5 Timeouts, retries and restarts.**
  - **Creating is retry-safe.** POSTing the same name returns the existing store, or
    restarts a failed one with a new deadline. The unique slug makes a double create
    impossible.
  - **Each provisioner call is idempotent:** create-if-missing namespace, binding and
    Secrets; `helm upgrade --install`. The install runs in the background (`--wait`,
    12 min per chart).
  - **Up to 3 attempts per try.** They're counted in a ConfigMap in the store namespace
    and keyed to the gateway's deadline, so a retry gets a fresh budget. Then `failed`
    with Helm's last error line.
  - **Provisioner restart mid-install.** Its Helm process dies and leaves the release
    `pending-*`. The next call finds no running job, uninstalls the pending release (the
    PVCs are kept by `resource-policy: keep`) and installs again.
  - **Gateway restart.** State is in Postgres; any replica resumes, with per-store leases
    (`FOR UPDATE SKIP LOCKED`, 60 s).
  - **A store that never reaches `ready`** before its deadline becomes `failed` with
    "Timed out after 15 min (last step: …)". Retry or delete it.
  - **The provisioner is a single replica (`Recreate`).** It tracks running Helm jobs in
    memory; everything else is in the cluster.
- **D10.6 Keeping provisioned stores up to date.**
  - **Fingerprint.** A store's "desired version" is a fingerprint: a hash of the charts
    bundled in the provisioner image, the environment's tenant values, and the store's
    host. It's recorded in the store's state ConfigMap after each successful install.
  - **Re-check.** The gateway re-checks ready stores every `global.stores.resyncMinutes`
    (local 2, prod 10).
  - **Upgrade.** If the fingerprint changed (a new provisioner image or edited values),
    the provisioner runs `helm upgrade` in the background. The store stays `ready` and
    its tools stay listed. Its status line shows "Upgrading…", or "Update failed: …"
    without taking it down.
  - **Stores from before this change** adopt the current fingerprint without an upgrade.
  - **Verified live:** a tenant-only value changed on the provisioner release (woo-mcp's
    memory limit) reached `store-alpha` within one re-check interval. Release revision
    1 → 2, storefront HTTP 200 throughout, the main store untouched. Reverting the value
    rolled it back the same way.
- **D10.7 Several stores in one chat.**
  - **The bug:** with more than one store, "create a product" became ambiguous, and the
    model once picked `store-alpha__create_product`. The core e2e caught it.
  - **The fix:** the system prompt now says `woocommerce__*` is the main store and
    `store-<name>__*` are separate stores. Data-changing requests without a named store
    go to the main store, and the answer names the stores used.
  - **Verified:** an unspecified "create a product" goes to `woocommerce__create_product`.

