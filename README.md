# Team MCP Gateway with WooCommerce Hosting

One MCP endpoint for a whole team. An admin registers MCP servers once, in a dashboard.
Every team member then uses all of them through a single URL with their own API key, from
Cursor, Claude Code, MCP Inspector, or the built-in chat assistant, without ever seeing an
upstream credential. Every call is checked against the member's role and written to an
audit log.

It comes with a real WooCommerce store to work on. WordPress + WooCommerce + MariaDB, with
a custom WooCommerce MCP server, so "what orders came in today?" or "create a product
called Sticker Pack at 4.99" work end to end. Two demo upstreams (notes, slow) show
cross-server prompts and failure handling.

It runs on Kubernetes everywhere: Kind on a Mac for development, k3s on a single VPS for
production, with the same Helm charts and only the values file differing. Every component
is free and open source; the chat uses Groq's free API tier, or any OpenAI-compatible
endpoint, including a local Ollama.

## Contents

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Using it](#using-it): [place an order](#place-an-order-storefront), [the dashboard](#the-dashboard),
  [connect an external MCP client](#connect-an-external-mcp-client),
  [use the chat agent](#use-the-chat-agent), [permissions](#permissions),
  [metrics](#metrics-prometheus), [end-to-end check](#end-to-end-check)
- [Production (k3s VPS)](#production-k3s-vps)
- [Stand-out and bonus items](#stand-out-and-bonus-items)
- [Repository layout and docs](#repository-layout)
- [Troubleshooting](#troubleshooting)

## Architecture

```
 browser / Cursor / Claude Code / MCP Inspector                    shopper's browser
                 │  https://hub…  (cookie or API key)                     │ https://store…
                 ▼                                                        ▼
        ┌──────────────────────── ingress-nginx ─────────────────────────────┐
        │  /api /mcp /healthz → gateway        / → dashboard        store → WordPress
        └────────────────────────────────────────────────────────────────────┘
 platform ns                                       store ns
 ┌───────────────────────────────┐                 ┌────────────────────────────────┐
 │ gateway (Fastify, Node 22)    │── bearer ──────▶│ woo-mcp ──OAuth1──▶ WordPress   │
 │  auth · registry · audit      │                 │                    + WooCommerce│
 │  dispatch(): every tool call  │                 │                       │         │
 │  /mcp · /api · /api/chat(SSE) │                 │                    MariaDB      │
 │  :9090 /metrics               │                 └────────────────────────────────┘
 │        │            │         │                 upstreams ns
 │   Postgres     dashboard      │── bearer ──────▶ mcp-notes · mcp-slow
 └───────│───────────────────────┘
         └── chat only ──▶ LLM provider (Groq by default; customer data masked first)
```

- **One code path.** `/mcp` (API keys) and the chat agent (dashboard sessions) both call
  `dispatch()`. It parses `<server>__<tool>`, checks the server is enabled and reachable,
  checks the caller's role against the permission table, calls the tool with a timeout,
  maps errors to stable codes, and writes exactly one audit row.
- **Credentials stay in the gateway.** Upstream credentials are encrypted (AES-256-GCM)
  in Postgres and only ever sent to their own server. Members' keys are never forwarded.
- **Deny by default.** Every namespace starts with deny-all NetworkPolicies plus explicit
  allows. Pods run non-root with read-only filesystems under Pod Security "restricted".
  Secrets come only from `.env`, through `scripts/create-secrets.sh`.

Details: [docs/design.md](docs/design.md) (architecture, tool naming, failure handling,
tradeoffs, every decision) and [docs/threat-model.md](docs/threat-model.md).

## Local setup

**Prerequisites (macOS):** Homebrew, Node 22 and pnpm (`corepack enable`), and about
8 GB of RAM for the VM.

```bash
brew install colima docker kind kubectl helm@3 jq
```
```bash
brew link --force helm@3
```

Helm **3** is required; the plain `helm` formula is now Helm 4.

**Install, configure, start:**

```bash
pnpm install
```
```bash
bash scripts/create-secrets.sh --generate
```

This writes `.env` (gitignored) with random secrets. Open it and set `LLM_API_KEY` to a
free Groq key from console.groq.com if you want the chat assistant; leave it empty to run
without chat.

```bash
bash scripts/up-local.sh
```

The first run takes about 10–15 minutes. It does the following, and is safe to re-run
after any change:
- starts Colima and a Kind cluster, and checks that NetworkPolicies are enforced;
- installs ingress-nginx and creates the Secrets;
- builds the six images, running each one's tests during the build, and loads them into
  Kind;
- installs the six Helm releases (including the store provisioner) and waits until
  they're ready;
- registers the notes and slow servers.

**URLs:**
- Store: <http://store.localtest.me>. Store admin: <http://store.localtest.me/wp-admin>
  (`WP_ADMIN_USER` / `WP_ADMIN_PASSWORD` from `.env`).
- Dashboard: <http://hub.localtest.me> (`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`).
- MCP endpoint: `http://hub.localtest.me/mcp`.

`*.localtest.me` resolves to 127.0.0.1, so no `/etc/hosts` changes are needed. Locally
everything is plain HTTP; production uses TLS.

**Stop or remove:** `bash scripts/teardown-local.sh` deletes the cluster. Add
`--stop-colima` to stop the VM too.

## Using it

### Place an order (storefront)

1. Open <http://store.localtest.me> and add **Team MCP Mug** (or any product) to the cart.
2. Check out as a guest with any address, choosing **Cash on delivery**.
3. The order appears in wp-admin under WooCommerce → Orders, with status *Processing*.
   It also shows up for the gateway's tools, for example
   `woocommerce__list_orders {"after": "<today>T00:00:00Z"}`.

### The dashboard

Sign in at <http://hub.localtest.me>. On a phone the sidebar becomes a menu. A switch at the bottom of the sidebar picks light, dark or match-system.

| Page | Who | What |
|---|---|---|
| Overview | everyone | landing page: servers up, tools available, calls and error rate in the last hour, recent activity, quick actions |
| Servers | everyone (edit: admin) | registered MCP servers with live status, tools and last error; add (tested on save), edit, disable, delete, refresh health |
| Stores | everyone (members: their own) | create a separate WooCommerce store in about a minute; delete it (bonus, below) |
| Chat | everyone | the AI assistant (below) |
| Team | admin | users and roles, every user's keys; disabling a user ends their sessions and keys at once |
| Permissions | everyone (edit: admin) | which roles can call which tool |
| My Keys | everyone | personal API keys: create (shown once), revoke |
| Connect | everyone | ready-to-paste config for Cursor, Claude Code, MCP Inspector and curl |
| Audit Log | everyone (members see only their own calls) | every tool call, with filters, plus error rate and latency per server for the last hour |

To add a team member, go to Team → Create user. The initial password is shown once; hand it
over. The member signs in, creates a key under My Keys, and copies a config from Connect.

### Connect an external MCP client

You need only two things: the URL `http://hub.localtest.me/mcp` (https and your domain in
production) and your own API key from **My Keys**. The key is shown once and looks like
`wk_xxxxxxxx_…`.

- **Cursor** (`~/.cursor/mcp.json`):
  ```json
  { "mcpServers": { "team-gateway": { "url": "http://hub.localtest.me/mcp",
      "headers": { "Authorization": "Bearer <your key>" } } } }
  ```
- **Claude Code:**
  ```bash
  claude mcp add --transport http team-gateway http://hub.localtest.me/mcp --header "Authorization: Bearer <your key>"
  ```
- **MCP Inspector:** run the command below, then pick transport "Streamable HTTP", URL
  `http://hub.localtest.me/mcp`, and header `Authorization: Bearer <your key>`.
  ```bash
  npx @modelcontextprotocol/inspector@2.8.0
  ```

You'll see every enabled server's tools that your role allows, named
`<server>__<tool>`, such as `woocommerce__list_orders` or `notes__create_note`. One
prompt can use several servers, for example "summarize today's orders and save it as a
team note". Revoking the key (My Keys, or an admin on Team) makes the very next call
fail with 401.

Without the UI, from a terminal:

```bash
bash -c 'jq -n --arg e "$(grep ^ADMIN_EMAIL= .env | cut -d= -f2-)" --rawfile p <(grep ^ADMIN_PASSWORD= .env | cut -d= -f2- | tr -d "\n") "{email:\$e,password:\$p}" | curl -s -c /tmp/hub.jar -H "content-type: application/json" --data-binary @- http://hub.localtest.me/api/auth/login'
```
```bash
curl -s -b /tmp/hub.jar -H 'content-type: application/json' -d '{"name":"my-laptop"}' http://hub.localtest.me/api/keys
```

The second command prints `secret`, your key, once. The password goes to curl through
stdin, never on the command line. Delete `/tmp/hub.jar` when you're done.

### Use the chat agent

1. Put a Groq API key in `.env` as `LLM_API_KEY=gsk_…`. It's free at console.groq.com;
   never paste it anywhere else.
2. Run `bash scripts/create-secrets.sh`, then
   `kubectl -n platform rollout restart deploy/gateway`.
3. Open **Chat** and try a suggestion, or ask your own question:
   - "What orders came in today?"
   - "Create a product called Sticker Pack priced at 4.99." (admin)
   - "Summarize today's orders and save it as a team note."

The answer streams in. The side panel lists each tool the assistant called, with its
outcome, duration, arguments and the real result. The assistant can only use the tools
**your** role allows; anything else is refused by `dispatch()` and logged with source
`chat`.

**Customer data is masked before it reaches the provider:**
- names and emails become pseudonyms such as `Customer_402913`;
- phone numbers and street addresses are removed.

Your screen still shows the real names. Turn this off only with
`gateway.config.chatPiiMasking: false`, and update your privacy policy first (draft:
[docs/privacy-notice.md](docs/privacy-notice.md)).

The model defaults to `openai/gpt-oss-120b` on Groq (`gateway.config.llmModel`). Any
OpenAI-compatible endpoint works: set `llmBaseUrl` and `llmModel`. For a local Ollama,
see `charts/gateway/values.yaml`. With no key and a hosted provider, chat is switched off
and says why.

### Stores (multi-store bonus)

**Stores → Create store → a name** (for example `outlet`). In about a minute you get:
- a full WordPress + WooCommerce store at `http://store-outlet.localtest.me`, with a
  sample product;
- its own namespace and resource quota;
- its tools for the whole team: `store-outlet__list_orders`, `…__create_product`, and
  so on. Write tools are admin-only by default.

The chat can then use several stores at once, for example *"Compare today's orders
between store-outlet and the main store"*. **Delete** removes the tools immediately,
then the whole store, data included. Limits: 2 stores per user, 3 in total locally
(`global.stores` in the values file).

Each store's wp-admin password is generated and kept in its namespace:

```bash
kubectl -n store-outlet get secret wordpress-secrets -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d
```

The username is `storeadmin`. Check it end to end with `bash scripts/e2e-stores.sh`.
That script creates two stores, orders on both, compares them in chat, and deletes one.

### Permissions

Admins can always call every tool. On **Permissions**, an admin decides per tool whether
members may call it. The defaults are:
- members can read products and orders;
- only admins can create products, change order status, or crash the slow server.

Tools without a rule follow `defaultMemberToolAccess` (`allow`). A change applies on the
next request, everywhere: restricted tools disappear from members' `tools/list` and the
chat, and calling one by name returns `[FORBIDDEN]`.

### Metrics (Prometheus)

The gateway serves Prometheus metrics on a separate port (9090). The Ingress never routes
to it, and a NetworkPolicy only lets pods in the `monitoring` namespace scrape it.
Prometheus isn't required. To look at the metrics locally:

```bash
kubectl -n platform port-forward deploy/gateway 9090:9090
```
```bash
curl -s http://127.0.0.1:9090/metrics | grep '^mcp_gateway_'
```

- `mcp_gateway_tool_calls_total{server,tool,outcome}`
- `mcp_gateway_tool_call_duration_seconds{server}` (histogram)
- `mcp_gateway_upstream_up{server}` (1 = connected)
- `mcp_gateway_tool_errors_total{code}`

Counters are per pod and reset when it's replaced. Prometheus handles that with
`rate()`/`sum()`. The pod and Service carry `prometheus.io/scrape|port|path` annotations;
a Prometheus Operator `ServiceMonitor` can select the Service by its
`app.kubernetes.io/name: gateway` label, with `port: metrics`. For a view that survives
restarts, use the "Last hour by server" cards on the Audit page, which come from the
audit log.

### End-to-end check

```bash
bash scripts/e2e-dod.sh
```

It runs the whole definition of done against the live cluster, with two users, and
prints PASS/FAIL for each of 62 steps:
- a storefront COD order;
- the chat agent creating a product and finding today's orders;
- a member's external MCP client using two upstreams;
- key revocation, disabling a server, and killing the slow server;
- the permission editor and metrics;
- audit attribution.

It needs the admin login in `.env`, and `LLM_API_KEY` for the chat steps. It leaves test
products, orders, a note and a disabled user behind, so never run it against production.
Unit and integration tests: `pnpm -r test` (199 tests across the six packages).

## Production (k3s VPS)

The same charts as local; only `values/values-prod.yaml` differs (comparison in
[docs/upgrade-rollback.md](docs/upgrade-rollback.md)). Everything is free and open source:
k3s, ingress-nginx, cert-manager and Let's Encrypt.

**You need:**
- A VPS with Ubuntu 24.04 LTS, at least 2 vCPU / 4 GB RAM / 40 GB disk (4 vCPU / 8 GB is
  comfortable). The workloads request 1.3 CPU and 1.9 GiB in total, and k3s,
  ingress-nginx and cert-manager need about 1 GiB more.
- A domain with two DNS A records pointing at the VPS, for example
  `hub.team.example.com` and `store.team.example.com`.
- A container registry. ghcr.io is free; public packages need no pull secret.
- On the machine you deploy from (the VPS itself is fine): git, Helm 3, kubectl, jq,
  openssl, and Node 22 with pnpm. To build the images you also need Docker.

**1. Firewall and k3s** (on the VPS). Open only 22, 80 and 443. Install k3s without its
bundled Traefik, because this project uses ingress-nginx. k3s brings local-path storage
(the prod storageClass), ServiceLB, and NetworkPolicy enforcement out of the box.

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```
```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik --write-kubeconfig-mode 600" sh -
```
```bash
mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown "$USER" ~/.kube/config && chmod 600 ~/.kube/config
```

Keep the API port (6443) closed to the internet. To deploy from your laptop, use an SSH
tunnel (`ssh -L 6443:127.0.0.1:6443 vps`) instead of opening it.

**2. Get the code and dependencies.** `pnpm install` is needed for the values and policy
checks.

```bash
git clone <your fork> team-mcp && cd team-mcp && pnpm install
```

**3. Build and push the images** with a version tag; never `latest`.

```bash
docker login ghcr.io
```
```bash
bash scripts/build-push.sh ghcr.io/<you>/team-mcp 0.1.0
```

Build on a machine with the same CPU architecture as the VPS (for example on the VPS
itself), or add `--platform linux/amd64`. That flag needs `docker buildx`. Each image's
tests run during the build. If the packages stay private, set `REGISTRY_*` in `.env` and
`global.image.pullSecrets: [registry-pull]` in `values-prod.yaml`.

**4. Set your values.** In `values/values-prod.yaml`, set:
- `global.hubHost` and `global.storeHost` to your domain;
- `global.image.registry` and `global.image.tag` to what you pushed.

The deploy script refuses to run while `example.com` or `your-org` placeholders remain.

**5. Secrets.** Copy `.env.example` to `.env` and fill in a few values yourself:
- `ADMIN_EMAIL` (your dashboard login);
- `WP_ADMIN_EMAIL`;
- `LLM_API_KEY` (a free Groq key; leave it empty to turn chat off).

Then generate every other value randomly. This creates the namespaces and Secrets
straight away:

```bash
bash scripts/create-secrets.sh --generate
```

Keep `.env` safe, for example in a password manager. It is the only copy of the
secrets, and without `CREDENTIAL_ENC_KEY` the stored upstream credentials can't be
decrypted.

**6. Deploy.** First do a dry run, which validates everything on the server and changes
nothing:

```bash
bash scripts/deploy-prod.sh --dry-run
```

Then the real deploy. `ACME_EMAIL` is your Let's Encrypt contact address.

```bash
ACME_EMAIL=you@example.com bash scripts/deploy-prod.sh
```

The script installs or updates:
- ingress-nginx 4.15.1, with the client IP preserved for the login rate limits;
- cert-manager v1.21.2, plus a Let's Encrypt ClusterIssuer (HTTP-01);
- the Secrets;
- the five releases, waiting for each to be ready.

To test certificates first without hitting Let's Encrypt's rate limits, add
`ACME_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory`.

**7. Check it.**

```bash
kubectl get certificate -A
```

Both certificates should show `READY True` within a few minutes. Then:
- Open `https://<hubHost>` and sign in as `ADMIN_EMAIL`. The password is
  `ADMIN_PASSWORD` in `.env`.
- Open `https://<storeHost>` and place a test order.
- WooCommerce is registered automatically. To add the notes and slow servers, go to
  Servers → Add server with these settings:
  - URL `http://mcp-notes.upstreams.svc.cluster.local:8080/mcp` (or `mcp-slow…`);
  - credential type Bearer;
  - token `NOTES_MCP_BEARER_TOKEN` (or `SLOW_MCP_BEARER_TOKEN`) from `.env`.
- Don't run `scripts/e2e-dod.sh` against production. It creates test users, products and
  orders, and kills a pod.

**Upgrades, backups and rollback:** see [docs/upgrade-rollback.md](docs/upgrade-rollback.md)
(`scripts/backup.sh`, then build a new tag, then `deploy-prod.sh`).

**Before every release:**

```bash
bash scripts/helm-check.sh
```

It runs Helm lint and template for both values files, plus the production policy check
(probes, limits, security contexts, NetworkPolicies, RBAC, TLS, storage, replicas).

## Stand-out and bonus items

| Item | Status | Where |
|---|---|---|
| **A. Tool permissions** (per-role, editable, enforced in `dispatch()` and `tools/list`) | ✅ done | `gateway/src/router/permissions.ts`, `gateway/src/http/routes/permissions.ts`, `dashboard/src/pages/Permissions.tsx`; tests in `gateway/test/permissions.test.ts`, `gateway/test/api.integration.test.ts` ("permission editor"), e2e section 5; design D7.1 |
| **B. Observability** (Prometheus `/metrics`, ServiceMonitor-compatible annotations, per-server error rate and latency from the audit log) | ✅ done | `gateway/src/metrics/`, `charts/gateway` (port + annotations), `charts/platform` (`gateway-metrics` NetworkPolicy), `dashboard/src/pages/Audit.tsx`; design D7.2–D7.4 |
| Security hardening (SSRF guard, encrypted credentials, hashed keys, non-root, deny-by-default NetworkPolicies, least-privilege Job RBAC, constant-time bearer comparison, redacted audit args) | ✅ core | `gateway/src/registry/ssrf.ts`, `gateway/src/crypto/`, `charts/*/templates/networkpolicies.yaml`, `charts/store/templates/store-init.yaml`; `scripts/policy-check.mjs`; [threat model](docs/threat-model.md) |
| Customer-data masking for the chat (requested addition) | ✅ done | `gateway/src/chat/privacy.ts`; design D6.12; [privacy notice draft](docs/privacy-notice.md) |
| **Bonus: multi-store provisioning** | ✅ done | `provisioner/` (service), `charts/provisioner` (RBAC, admission policy, NetworkPolicies), `gateway/src/stores/` (API, reconciler), `charts/store/templates/tenant.yaml` (quota), `dashboard/src/pages/Stores.tsx`; tests in `provisioner/test/`, `gateway/test/api.integration.test.ts` ("multi-store"), `scripts/e2e-stores.sh`; design D10.1–D10.5 |

## Repository layout

| Path | What |
|---|---|
| `gateway/` | Gateway service: auth, registry, `dispatch()`, `/mcp`, `/api`, chat, metrics |
| `dashboard/` | React dashboard (served by unprivileged nginx with a strict CSP) |
| `mcp-woo/`, `mcp-notes/`, `mcp-slow/` | Upstream MCP servers (WooCommerce, team notes, slow and failing demo) |
| `provisioner/` | Store provisioner (bonus): one WooCommerce store per namespace, with Helm |
| `charts/` | Helm charts: `platform` (umbrella: gateway, dashboard, postgres), `store`, `woo-mcp`, generic `upstream-mcp`, `provisioner` |
| `values/` | `values-local.yaml`, `values-prod.yaml`: the only per-environment differences |
| `scripts/` | `show-db.sh` (database tour and persistence proof), `up-local.sh`, `teardown-local.sh`, `create-secrets.sh`, `register-upstreams.sh`, `load-images.sh`, `helm-check.sh` + `policy-check.mjs`, `e2e-dod.sh`, `e2e-stores.sh`, `deploy-prod.sh`, `build-push.sh`, `backup.sh` |
| `docs/` | see below |

**Docs:**
- [design.md](docs/design.md): architecture, tool naming, failure handling, tradeoffs,
  production changes, and every decision.
- [threat-model.md](docs/threat-model.md): assets, trust boundaries, the five spec topics,
  and the production policy checklist.
- [upgrade-rollback.md](docs/upgrade-rollback.md): local vs production, upgrade,
  rollback, restore, pinned versions.
- [demo-script.md](docs/demo-script.md): the live demo, step by step.
- [demo-video-script.md](docs/demo-video-script.md): a tight ~9-minute script for the
  required demo video.
- [demo-database.md](docs/demo-database.md): how to show the databases, volumes and the
  persistence proof (`scripts/show-db.sh`).
- [privacy-notice.md](docs/privacy-notice.md): privacy policy draft for the AI assistant.
- [NOTES.md](NOTES.md): build log with verification results per phase.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `helm` errors about the chart or `--wait` flags | Helm 4 is installed: `brew link --force helm@3` |
| `up-local.sh` stops at "NetworkPolicy is NOT enforced" | the cluster's CNI ignores policies; delete the cluster (`teardown-local.sh`) and re-run |
| `hub.localtest.me` doesn't load | `kubectl get pods -A`; all should be Running. Re-run `up-local.sh` (idempotent) |
| Chat says "not configured yet" | `LLM_API_KEY` is empty: set it, run `create-secrets.sh`, restart the gateway |
| Chat says the rate limit was reached | Groq free tier: wait a minute; `llmReasoningEffort: low` keeps usage down |
| A server shows *unreachable* | Servers page → expand it for `last_error`; it retries with backoff (up to 60 s), or click refresh |
| `[TIMEOUT]` from `slow__echo` | intended: it sleeps 15 s, past the 10 s default timeout |
| A port-forward stops with "lost connection to pod" | the pod was replaced (redeploy or restart); run it again, using `deploy/gateway` |
| Store setup problems | `kubectl -n store logs job/store-init` |
