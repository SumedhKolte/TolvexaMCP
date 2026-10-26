# Threat model

What this system protects, from whom, and how. The five topics the spec requires are
under "Gateway":
- [Shared upstream credentials](#shared-upstream-credentials)
- [Why client tokens are not passed through](#why-client-tokens-are-not-passed-through)
- [Untrusted upstream tool descriptions](#untrusted-upstream-tool-descriptions-prompt-injection)
- [What one member can do to another](#what-one-member-can-do-to-another)
- [What happens if an admin adds a malicious server](#what-happens-if-an-admin-adds-a-malicious-server)

After them come the per-component sections, and the production
[policy checklist](#policy-checklist), which is checked by code.

## Assets

- Upstream credentials (WooCommerce REST keys, upstream bearer tokens)
- Team member API keys and dashboard sessions
- Store data (orders, customer PII) and the store admin account
- Audit log integrity

## Trust boundaries

1. **Internet → ingress-nginx.** Everything is unauthenticated until proven otherwise.
2. **Browser → gateway `/api`:** a session cookie (HttpOnly, SameSite=Lax, Secure with
   TLS).
3. **MCP client → gateway `/mcp`:** a per-user API key (`wk_…`), checked on every request.
4. **Gateway → upstreams:** the gateway holds every upstream credential, encrypted at rest
   and decrypted only in memory for its own requests. Clients' keys are **never**
   forwarded.
5. **Upstream → gateway:** tool lists, descriptions, and results are **untrusted data**.

## Gateway

### Credentials at rest
- **Upstream credentials:** AES-256-GCM, with the key only in the `gateway-secrets` Secret.
  The AAD binds each ciphertext to its row. API responses expose only `credential_set`.
- **API keys:** SHA-256 of the full key (high-entropy secret). The full key is shown once.
- **Passwords:** argon2id.
- **Sessions:** HMAC of the cookie token, keyed by `SESSION_SECRET`.
- **A Postgres dump alone yields:** no upstream credentials (needs `CREDENTIAL_ENC_KEY`), no
  usable API keys or cookies, and only argon2 hashes.

### Shared upstream credentials
Each upstream has **one** credential, registered by an admin and shared by the whole team
through the gateway. For example, the WooCommerce MCP bearer token, and behind it a single
WooCommerce REST key with read/write rights.

- **Where it lives:**
  - AES-256-GCM-encrypted in Postgres (AAD = `upstream:<id>`, so a ciphertext can't be
    moved to another row);
  - the key is only in the `gateway-secrets` Secret;
  - decrypted only in gateway memory, and only for requests to that upstream's own URL;
  - never returned by the API (only `credential_set: true`), never logged, never sent to
    clients or the LLM.
- **What sharing costs:**
  - The upstream sees every call as "the gateway". Per-member attribution exists only in
    the gateway's audit log, which records the user, key, source, tool, redacted args,
    outcome and duration.
  - Per-member restrictions must therefore be enforced by the gateway (the permission
    table in `dispatch()`), not by the upstream.
  - The WooCommerce REST key is read/write, so the gateway's permission table is what
    stops members from writing.
- **Blast radius:**
  - A leaked upstream credential works for anyone who can reach that upstream. Inside
    the cluster that's only the gateway, by NetworkPolicy; woo-mcp isn't exposed through
    the Ingress.
  - A gateway compromise exposes all upstream credentials. That's why the gateway runs
    non-root with a read-only filesystem, no service-account token, and egress limited
    to its upstreams, Postgres, and the public 443 range for the LLM.
- **Rotation:** change the value in `.env`, run `create-secrets.sh`, and restart the
  gateway (built-in WooCommerce), or edit the server in the dashboard (others). The
  WooCommerce REST key rotates by deleting `WC_CONSUMER_KEY` from `woo-mcp-secrets` and
  upgrading the store chart (docs/upgrade-rollback.md).

### Why client tokens are not passed through
Members authenticate to the gateway with their own key, and the gateway calls upstreams
with **its own** stored credential. Passing a client's token through would mean:
- every member needs a credential for every upstream (the problem the gateway removes);
- upstreams would see and could replay member tokens;
- revoking one member would require changes at every upstream.

With the gateway in the middle, revocation is one DB write, effective on the next request.

### SSRF (admin-entered URLs)
Policy: design.md D3.14. Even a malicious **admin** can't point the gateway at:
- loopback, link-local, or cloud metadata addresses;
- arbitrary private IPs (IP literals are rejected; names must be cluster Services or
  allowlisted);
- public names that resolve to private addresses.

The check runs on every new connection, which blocks DNS rebinding.

Remaining limitations:
- Any Service in the cluster (`*.svc.cluster.local`) can be registered. NetworkPolicy is
  the second fence: the gateway's egress is limited to woo-mcp and `upstreams/*:8080`, so
  registering `postgres.platform` or `mariadb.store` fails to connect even though it
  passes the name check (the gateway → MariaDB/WordPress path was tested and is blocked).
- Error messages from failed connections are shown to admins in `last_error`. They contain
  socket errors, not response bodies, so the gateway can't be used to read internal pages.

### Untrusted upstream tool descriptions (prompt injection)
Tool names, descriptions and results come from upstreams and are **untrusted**. They flow
into members' MCP clients and into the chat model. Mitigations:
- descriptions are capped at 1024 characters;
- the upstream's URL and credential are scrubbed from them;
- tools with malformed names are rejected;
- tool names are namespaced by slug, so one server can't shadow another's tool.

- the chat system prompt says tool descriptions and results are data, not instructions;
- tool results sent to the model are cut to 8 KB, and the loop stops after 8 rounds;
- tool arguments the model produces are validated as JSON objects before `dispatch()`.

Not mitigated: an instruction-like description or result ("ignore previous instructions…")
can still steer a model. Models don't reliably obey "this is data".
- The real control is **authorization in `dispatch()`**. Whatever the model is talked
  into calling, it can only run tools the **user's** role allows. Hidden tools are refused
  even when called by name (tested). Everything is audited with source `chat` and the
  user's id.
- External MCP clients (Cursor, Claude Code) run their own models. Their tool-approval
  prompts are the member's last line of defence there, and the gateway's permissions
  still apply.

### What one member can do to another
- **Read:** nothing private of another member's.
  - Key lists, key revocation, audit queries and audit stats are pinned to the caller
    (tested, including a spoofed `userId`).
  - Chat conversations live only in each user's browser.
  - The chat's pseudonym map is per user, so one member can't reveal customers that came
    up in someone else's chat.
- **Shared data is shared:** store data and team notes are visible to everyone whose role
  allows those tools.
- **Writes:** only through tools their role allows.
  - With the default policy, members can call tools that have no rule, such as
    `notes__create_note`.
  - Admins can restrict any tool on the Permissions page; it takes effect on the next
    request.
- **Indirect prompt injection (the most realistic attack).** A member writes a note
  containing instructions. Another member, or an admin, later asks the chat assistant to
  summarise notes, and the model may follow them.
  - The model can still only call tools the **reader's** role allows, and every call is
    audited under the reader with source `chat`.
  - This is why admins should be the most careful when chatting over shared content, and
    why the side panel shows every tool call as it happens.
- **Cost and load:** each user can run one chat answer at a time, and the loop is
  capped. But a member can call tools through `/mcp` in a loop: there's no per-user
  tool-call rate limit. The audit log and metrics show who did it, and an admin can
  revoke the key or disable the user at once.

### What happens if an admin adds a malicious server
- **Can:**
  - expose tools with misleading descriptions (see above);
  - return misleading results;
  - receive the arguments members send to its tools;
  - slow listings by up to 3 s (the listing then skips it).
- **Cannot:**
  - read other upstreams' credentials (each credential is sent only to its own URL);
  - reach Postgres, MariaDB, or WordPress through the gateway (NetworkPolicy + SSRF);
  - see member API keys (never forwarded);
  - make its tools callable by roles that aren't permitted.
- **Also:** its descriptions and results can try to steer the chat model and members'
  clients (see "Untrusted upstream tool descriptions"). The chat sends its results to the
  LLM provider, masked for customer fields only.
- **Detection and response:**
  - every call is audited, and the server's error rate and latency are on the Audit page;
  - restricting its tools to admins, or disabling or deleting the server, removes its
    tools from every client and the chat on the next request.

### Sessions, CSRF, and login
- **CSRF:** cookies are `SameSite=Lax` and mutating routes take JSON only, with no CORS.
- **Login:** rate-limited per IP and per email in Postgres (shared by all replicas). The
  client IP comes from exactly 1 trusted proxy hop. Unknown emails and wrong passwords
  give the same error and timing.
- **Sessions:** 12 h, ended immediately on logout or when the user is disabled.

### Platform NetworkPolicy (tested)
- **Allowed:** ingress-nginx → gateway; gateway → Postgres, woo-mcp, and `upstreams/*:8080`.
- **Blocked:**
  - every other namespace → Postgres or gateway;
  - gateway → internet, MariaDB, or WordPress (so it can't bypass woo-mcp);
  - non-gateway platform pods → Postgres.
- **Label caveat (as with woo-mcp):** policies identify the gateway and Postgres by pod
  label, so pod-creation rights in `platform` are admin-only (Phase 8 RBAC review).

## Store namespace

### Workload security: no exceptions

The spec allowed root and writable-filesystem exceptions for WordPress and MariaDB. None
were needed. Every store pod passes Pod Security **restricted**, which is enforced on the
namespace:

| Workload | User | Root FS | Writable paths (emptyDir unless noted) | Notes |
|---|---|---|---|---|
| mariadb | 999 | read-only | `/var/lib/mysql` (PVC), `/run/mysqld`, `/tmp` | |
| wordpress | 33 | read-only | `/var/www/html`, `wp-content` (PVC), Apache run/lock, `/tmp` | sysctl `ip_unprivileged_port_start=0` to bind :80 without capabilities |
| store-init Job | 33 | read-only | `/var/www/html`, `wp-content` (PVC), `/tmp` | the only pod in `store` with an API token |

All containers drop ALL capabilities, set `allowPrivilegeEscalation: false`, and use
seccomp RuntimeDefault. Only the store-init pod mounts a ServiceAccount token.

The sysctl is namespaced and on Kubernetes' "safe" list. It only lowers the
privileged-port floor *inside the pod's own network namespace*.

### store-init RBAC

- **Rule:** one Role rule, `patch` on `secrets` with `resourceNames: [woo-mcp-secrets]`.
- **No `create`:** RBAC can't restrict `create` by resourceNames, so granting it would allow
  creating any Secret in the namespace. `create-secrets.sh` creates the Secret first.
- **No `get`/`list`:** the Job receives the current key pair via `secretKeyRef` env,
  resolved by the kubelet.
- **Worst case:** a compromised Job could overwrite the WooCommerce key in that one Secret,
  which breaks woo-mcp until the next upgrade. It can't read other Secrets or touch other
  objects.
- **Verified:** `kubectl auth can-i` returns no for get, list, create, and delete, for other
  Secrets, and for pods.

### Network policy (deny by default)

| Flow | Allowed |
|---|---|
| ingress-nginx → wordpress:80 | yes |
| store-init → wordpress:80, mariadb:3306 | yes |
| wordpress → mariadb:3306 | yes |
| store-init → Kubernetes API (endpoint port 6443) | yes |
| store-init → internet :80/:443 (RFC 1918 ranges excluded) | yes: **the only internet egress in the namespace**, needed by `wp plugin install woocommerce` (downloads.wordpress.org) |
| any pod → DNS (kube-dns :53) | yes |
| anything else, including wordpress → internet and other namespaces → mariadb/wordpress | **denied** (tested) |

**Residual risk.** The store-init internet rule is by port, not by host. NetworkPolicy
can't match DNS names, so the Job could reach any public host on 80/443.

Mitigations:
- The Job runs only pinned code: images and the WooCommerce version are fixed.
- It runs briefly, at install and upgrade time.
- The web pod, which handles untrusted traffic, has no internet egress.

A stricter alternative is to bake WooCommerce into a custom image and install it from a
local zip, removing the rule entirely.

### Secrets handling in the store

- **Origin:** every credential comes from Kubernetes Secrets created from `.env`. None are
  in the chart, the values files, or git.
- **Store admin password:** never placed on argv and never logged.
  - **Incident during Phase 1:** `wp core install --prompt=...` echoed the password into
    the Job log. It was caught during verification. The flow was changed (design.md D1.10),
    the password was rotated, and the pods holding the old log were deleted.
  - **Lesson:** inspect logs of any step that handles a credential.
- **WooCommerce REST secret:** stored only in the Secret; WooCommerce stores the consumer
  key hashed. The `ensure-api-key.php` helper prints the new pair on stdout only, captured
  by the shell, and sends it to the API over stdin. The SA token goes in a header file, not
  on argv.
- **wp-admin:** `DISALLOW_FILE_EDIT` and `DISALLOW_FILE_MODS` stop the theme/plugin editor
  and plugin installs from becoming a code-execution path for a stolen admin session.

### woo-mcp

- **Who can call it:** only pods labelled `app.kubernetes.io/name=gateway` in the `platform`
  namespace (NetworkPolicy), and only with the bearer token (constant-time comparison).
  Both controls are needed.
  - NetworkPolicy identifies the gateway **by label**. Anyone allowed to create pods in
    `platform` could label a pod `gateway` and reach woo-mcp at the network layer. This
    was tested: such a pod connects. They would still need the bearer token.
  - Therefore the RBAC for creating pods and reading Secrets in `platform` must stay
    admin-only (Phase 8 checklist).
- **Upstream credential exposure:** the WooCommerce consumer secret never leaves woo-mcp,
  not even on the wire, because OAuth 1.0a signs requests instead of sending the secret.
  The consumer key travels only in the `Authorization` header. Neither appears in tool
  output, errors (redacted defensively), or logs (tested).
- **Blast radius of a stolen bearer token:** full read/write over products and orders
  through the five tools (`read_write` WooCommerce key). It can't delete products, issue
  refunds with money movement, or reach other WordPress APIs. Rotation: change
  `WOO_MCP_BEARER_TOKEN` in `.env` → `create-secrets.sh`. woo-mcp re-reads its mounted
  Secret; the gateway side is covered in Phase 3.
- **woo-mcp's own egress:** WordPress :80 and DNS only, with no internet and no MariaDB
  (tested). A compromised woo-mcp can do what the REST key allows and nothing more on the
  network.

### Upstreams namespace

- **Isolation:** `mcp-notes` and `mcp-slow` accept connections only from gateway pods and
  can't open connections to anything but DNS. A compromised upstream can't reach other
  upstreams, the gateway, Postgres, the store, or the internet (all 10 flows tested). It
  can only answer the gateway, which treats everything it says as untrusted data.
- **Bearer tokens:** each upstream has its own token (`NOTES_` / `SLOW_MCP_BEARER_TOKEN`),
  held only in that upstream's Secret and, encrypted, in the gateway DB. The gateway never
  holds them in plaintext env, and a token for one upstream is useless at another.
- **`slow__crash` (deliberate kill switch):** it exists only for the demo.
  - Registered only when `ALLOW_CRASH=true` (local values; off in prod values and in the
    image default).
  - Admin-only at the gateway: hidden from members, `[FORBIDDEN]` if called directly
    (tested), and every attempt is audited.
  - Blast radius: one restart of the mcp-slow container. Other upstreams keep working
    (tested).
- **mcp-notes data:** notes are shared by everyone who can call `notes__*` (members, by
  default). Treat them as team-visible. Storage is capped (1000 notes) against memory
  exhaustion.

### Dashboard

- **XSS:**
  - React escapes all rendered data, including tool descriptions from upstreams and audit
    `args_summary`. There's no `dangerouslySetInnerHTML` anywhere.
  - CSP `script-src 'self'` blocks injected scripts even if escaping failed somewhere.
  - The session cookie is `HttpOnly`, so scripts can't read it.
- **Clickjacking:** `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Secrets on screen:**
  - Each secret is shown once, masked afterwards, and dropped from memory on close.
  - Screen-capture and automation tools can still record a one-time secret while it's
    displayed. This happened during verification: a Playwright page snapshot captured a
    test key, which was then revoked. Revoke any key that was on screen during a recording.
- **Bundle:** no configuration or secrets (verified against every `.env` value).
- **Members:** see server names, statuses, and tool names, but not upstream URLs or
  credential settings; get no Team page; their audit view is pinned to themselves
  server-side.

### Chat agent

- **Prompt injection** through tool results (an order note, a product description, a
  hostile upstream's text) or tool descriptions. Mitigations:
  - **The model can't exceed the user.** Every tool call is authorized by `dispatch()`
    against the logged-in user's role. Tools the role can't use are never offered, and
    are refused if called anyway (tested). The worst case is "the model did something the
    user was allowed to do anyway", and it's audited under the user with source `chat`.
  - The system prompt marks tool output as data, not instructions. That reduces the risk
    but doesn't guarantee anything.
  - Results are truncated (8 KB) and the loop is capped (8 rounds).
  - Residual risk: a member chatting with injected content could be steered into calling
    allowed tools, e.g. writing a misleading note. Admin sessions carry more power, so
    admins should be the most careful with untrusted content in chat.
- **Data leaving the cluster.** With a hosted provider (Groq by default), the chat sends
  the conversation and tool results to that provider. Customer data is masked first
  (D6.12):
  - names and emails become stable pseudonyms;
  - phone numbers and street lines never leave;
  - city, state, postcode and country do.

  Residual exposure:
  - order contents and totals, product data, and team notes are sent as they are;
  - free text (e.g. a customer note) is masked best effort only;
  - whatever the user types is sent, apart from known customers, emails and phone
    numbers.

  Provider side: set Zero Data Retention in the Groq console (Data Controls) and mention
  the AI processor in the store's privacy policy (draft: `docs/privacy-notice.md`). For
  full data locality, use the Ollama preset. `/mcp` traffic never leaves the cluster and
  is not masked.
- **Pseudonym map.** It is held in gateway memory only, per user (a member can't reveal
  customers from an admin's chat), bounded at 5,000 entries, and never logged or sent to
  the provider. The pseudonym key is derived from `SESSION_SECRET` (HKDF, separate label),
  so rotating that secret also changes every pseudonym.
- **The LLM API key** is only in `gateway-secrets`. It's never logged (provider errors are
  mapped to fixed messages without bodies) and never sent to the browser.
- **Network:** the gateway may reach public addresses on 443, for the provider only;
  private ranges stay blocked (D6.10).
- **Abuse and cost:** one running chat per user, 8 model rounds per message, and a 60 s
  provider timeout.
- **History forgery:** the browser can only send user and assistant text. Tool calls and
  results are created server-side, so a client can't fake a tool result.

### Permissions and metrics

- **Permission edits.**
  - Only admins can change rules. `PUT` and `DELETE /api/permissions/:tool` need an admin
    session; a member gets 403 (tested).
  - Rules are enforced in `dispatch()` and in every listing, never only in the UI.
  - Admins keep access to every tool by design. A compromised admin session can open
    tools to members, and that is logged with the admin's id.
- **Metrics exposure.**
  - `/metrics` lives on its own port. The Ingress has no route to it (checked: `/metrics`
    through the hub returns the dashboard, not metrics), and the `gateway-metrics`
    NetworkPolicy admits only the scrape namespaces.
  - Metrics reveal server slugs, tool names, call counts, error codes and process stats.
    They contain no user ids, emails, arguments or results.
  - Labels are bounded, so a client can't blow up memory or the time-series database by
    calling made-up tool names.

### Plain HTTP in local dev

The local store is served over plain HTTP (`global.tls.enabled: false`). Consequences:
- WooCommerce REST Basic auth isn't accepted over HTTP (design decision in Phase 2).
- Cookies aren't `Secure`.

Production enables TLS through cert-manager, and WordPress then sees `https` through
`X-Forwarded-Proto`, which ingress-nginx sets and overwrites.

### Multi-store provisioning (bonus)

- **The provisioner is the most privileged workload.** It's the only pod with a
  Kubernetes API token that can create namespaces and install charts. Three independent
  fences apply (design D10.2), all probed live by impersonation:
  1. a minimal cluster role;
  2. the tenant role bound only inside each `store-*` namespace;
  3. a ValidatingAdmissionPolicy that denies anything outside `store-*` namespaces.

  Even with its token stolen, it can't read platform Secrets, delete the `platform` or
  main `store` namespaces, or gain `cluster-admin`. It can, by design, read and change
  every provisioned store: that's its job.
- **Who can call it.** Only gateway pods (NetworkPolicy), with a 32+ byte shared token,
  compared in constant time. Store names are validated on both sides (DNS label,
  `store-` prefix). The provisioner refuses to adopt or delete a namespace that isn't
  labelled as a provisioned store.
- **Members can create stores** (up to `maxPerUser`, and `maxTotal` overall), so a
  member can consume cluster capacity up to those caps. Each store's ResourceQuota bounds
  what one store can use, and there are no LoadBalancer or NodePort Services. Admins see
  and can delete every store.
- **Isolation between stores:**
  - separate namespaces, each with its own default-deny NetworkPolicies (only
    ingress-nginx → WordPress, and gateway → woo-mcp);
  - separate MariaDB credentials, WP admin and salts, generated per store;
  - separate woo-mcp bearer tokens, encrypted in the gateway.

  A compromised store can't reach another store's database or woo-mcp.
- **Tools of new stores.** Reads are open to members and writes are admin-only (rules
  created with the store). They're adjustable on Permissions.
- **Storefront admin passwords** are generated into each store's `wordpress-secrets` and
  aren't shown anywhere. An operator reads them with `kubectl` when needed.
- **Deletion is irreversible:** the namespace and its PVCs go. The UI asks for
  confirmation, and only the owner or an admin can delete.

## Local development exposure

- **Colima listens on all host interfaces.** Its port forwarder exposes the local
  hub and store to the LAN (design D0.11). Use local dev on trusted networks only;
  everything locally is plain HTTP with generated secrets.
- **Test credentials stay local.** `.env` and `.env.ui-test.local` are gitignored and
  never leave the machine.

## Policy checklist

How each rule is checked:
- **[auto]** `scripts/policy-check.mjs`, run by `scripts/helm-check.sh`. It renders every
  chart with **both** values files and fails on any violation.
- **[live]** tested against the running cluster (the phase is noted).
- **[doc]** a documented decision.

**Workloads**

| Rule | Status | How |
|---|---|---|
| Liveness + readiness probes on every long-running container (gateway `/healthz` + `/readyz`; WordPress `/wp-login.php`; MariaDB `mysqladmin ping`; woo-mcp, upstreams and dashboard `/healthz`) | ✅ | [auto] 8/8 in both envs |
| CPU and memory requests **and** limits on every container, including init containers and the wp-cron CronJob | ✅ | [auto] 11 local / 12 prod containers |
| `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities: drop [ALL]` with nothing added, `seccompProfile: RuntimeDefault` | ✅ | [auto] every container |
| `readOnlyRootFilesystem: true` | ✅ | [auto] every container, **including WordPress and MariaDB** (writable paths are emptyDirs or PVCs) |
| No privileged containers, hostNetwork, hostPID, hostIPC or hostPath | ✅ | [auto] |
| Pod Security Admission `restricted` (enforce) on platform, store and upstreams | ✅ | [live] namespace labels set by `create-secrets.sh`; prod manifests passed a server-side dry run in `restricted` namespaces with no warnings (Phase 8) |
| Service account tokens not mounted (`automountServiceAccountToken: false`), except the store-init Job | ✅ | [auto] |
| Images pinned to a version (no `:latest`); our images `Always` pulled from a registry in prod | ✅ | [auto]; `build-push.sh` refuses `latest`/`local` |
| Zero-downtime rollouts: readiness gates, 5 s `preStop`, graceful SIGTERM | ✅ | [live] 0 failed requests out of about 20,000 across two rolling restarts with 2 gateway replicas (Phase 8) |

**Exceptions:**
- **None to the container rules.**
- WordPress uses one namespaced **safe sysctl**, `net.ipv4.ip_unprivileged_port_start=0`,
  so Apache can bind port 80 as uid 33 without `NET_BIND_SERVICE` or root. Pod Security
  `restricted` allows it (design D1.2).

**Network**

| Rule | Status | How |
|---|---|---|
| Default-deny ingress **and** egress in every namespace with workloads, plus DNS-only egress to kube-dns | ✅ | [auto] platform, store, upstreams; [live] the CNI enforces it (checked by `up-local.sh` on every fresh cluster) |
| Only the flows in spec section 5 | ✅ | [live] probed in Phases 1–4 and 7: gateway → woo-mcp/upstreams/postgres; wordpress → mariadb; woo-mcp → wordpress; upstreams can't reach platform, store or each other |
| No allow-all rules | ✅ | [auto] |
| Internet egress only where needed: gateway → 443 public only, for the LLM (private, CGNAT and link-local ranges excluded); store-init → 80/443 public only (WooCommerce download, private ranges excluded) + the API server on 6443 | ✅ | [doc] D6.10, D1.14; [live] Phase 6: Groq reachable, in-cluster IPs blocked |
| `/metrics` reachable only from the `monitoring` namespace, never through the Ingress | ✅ | [live] agnhost probes from two namespaces (Phase 7) |
| cert-manager HTTP-01 solver pods reachable from ingress-nginx (port 8089) in platform and store, prod only | ✅ | [auto] rendered in prod; [doc] D8.3 |
| Every Service is ClusterIP; only ingress-nginx is exposed | ✅ | [auto] |
| ingress-nginx: snippet annotations disabled; client IP preserved (`externalTrafficPolicy: Local`) for login rate limits | ✅ | `deploy-prod.sh` |

**RBAC**

| Rule | Status | How |
|---|---|---|
| No ClusterRoles or ClusterRoleBindings, except the provisioner's when `global.stores.enabled` (multi-store bonus): `team-mcp-provisioner` pinned rule for rule, `team-mcp-store-tenant` never bound cluster-wide, and the store-* admission policy present | ✅ | [auto]; [live] impersonation probes (design D10.2) |
| Only one Role: `store/store-init`, verb `patch` on `secrets` restricted to `resourceNames: [woo-mcp-secrets]` (no get/list/watch/create/delete) | ✅ | [auto]; the Secret is pre-created by `create-secrets.sh`, so `create` isn't needed |
| Nothing else uses the Kubernetes API: every other pod has no token (store-init and the provisioner are the two allowed exceptions) | ✅ | [auto] |
| Third-party controllers (ingress-nginx, cert-manager) use their upstream charts' RBAC, pinned versions | ⚠️ accepted | [doc] ingress-nginx is retired upstream; reassess (design D0.3) |

**Secrets and TLS**

| Rule | Status | How |
|---|---|---|
| No Secret objects in any chart; no secrets in images, values or git | ✅ | [auto] no `kind: Secret` rendered; `.env` and `*.local` are gitignored |
| No literal secret-looking env values; every credential comes from `secretKeyRef`, a mounted Secret, or `$(VAR)` expansion of one | ✅ | [auto] |
| Secrets created only by `create-secrets.sh` from `.env` (0600 temp files, never argv, never printed); registry pull secret likewise | ✅ | [live] Phase 8 test with a fake token |
| TLS on every prod host (cert-manager ClusterIssuer), HTTP → HTTPS redirect and HSTS by ingress-nginx; Secure cookies in prod | ✅ | [auto] TLS and issuer annotation; `COOKIE_SECURE` follows `global.tls.enabled` |
| Backups are 0600 files in a 0700 directory, gitignored; `.env` is backed up separately | ✅ | [live] `backup.sh` + restore test (Phase 8) |

**Known, accepted risks:**
- **No pod disruption budgets.** A single-node VPS has no voluntary evictions to protect
  against.
- **WordPress, MariaDB and Postgres are single replicas** on ReadWriteOnce volumes. They
  are recreated during upgrades, so expect a short outage then.
- **mcp-notes keeps its notes on a 1 Gi PersistentVolumeClaim** (single writer, so it
  runs one replica and uses the `Recreate` strategy). They survive pod deletion and
  upgrades, but not the loss of the node; `scripts/backup.sh` doesn't cover this volume
  yet.
