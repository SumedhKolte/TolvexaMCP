# Upgrade and rollback

How to move between versions safely, and how local differs from production. The
production walkthrough itself is in the README ("Production (k3s VPS)").

## Local vs production

| Aspect | Local (Kind) | Production (k3s VPS) |
|---|---|---|
| Domain | `hub.localtest.me`, `store.localtest.me` | `hub.team.example.com`, `store.team.example.com` (placeholder) |
| Ingress class / TLS | nginx, plain http | nginx, TLS from cert-manager (`letsencrypt-prod` ClusterIssuer) |
| storageClass | cluster default (`standard`) | `local-path` |
| Secrets source | `.env` → `scripts/create-secrets.sh` (`--generate` fills random values) | the same: a `.env` kept only on the deploy machine and in a password manager → `create-secrets.sh`; optional `REGISTRY_*` adds an image pull secret |
| Replicas | 1 everywhere | gateway 2, others 1 |
| Image registry | `team-mcp/*:local`, loaded with `kind load` | `ghcr.io/your-org/team-mcp/*:<version>` (placeholder) |
| Pull policy | IfNotPresent | Always |
| Resource sizes | low requests (long-running pods: 0.26 CPU / 816 MiB requested) | higher requests and limits: 1.3 CPU / 1.9 GiB requested, about 11.7 CPU / 5.2 GiB in limits (with the gateway at 2 replicas). VPS: 2 vCPU / 4 GB minimum |
| WP-Cron | runs on page loads; a `hostAliases` loopback keeps it in the pod | `wordpress.systemCron`: a CronJob calls `wp-cron.php` every 5 min (design D8.2) |
| Ingress controller | ingress-nginx on Kind (hostPort) | ingress-nginx behind k3s ServiceLB, `externalTrafficPolicy: Local` (real client IPs) |
| Deploy command | `scripts/up-local.sh` | `scripts/deploy-prod.sh` (`--dry-run` first) |

## Upgrade procedure

Every release uses a new image tag; never rebuild an existing tag. With
`pullPolicy: Always` and an unchanged tag, the pods wouldn't roll, and a rollback would
have nothing distinct to return to.

1. **Check** the charts and policies: `bash scripts/helm-check.sh` must end with "All
   policy checks passed".
2. **Back up**: `bash scripts/backup.sh`. It writes three files under `backups/<time>/`
   (gitignored, mode 0600): the store database, `wp-content`, and the gateway database.
   Copy the folder off the server.
3. **Build and push** the new tag:
   `bash scripts/build-push.sh ghcr.io/<you>/team-mcp 0.2.0`. Each image's tests run
   during the build.
4. **Bump** `global.image.tag` in `values/values-prod.yaml`. Bump third-party versions
   (WordPress, WooCommerce, MariaDB, Postgres) in separate releases, never together with
   your own changes.
5. **Dry run**: `bash scripts/deploy-prod.sh --dry-run`.
6. **Deploy**: `ACME_EMAIL=… bash scripts/deploy-prod.sh`. Helm waits for each release
   to be ready.
   - The gateway rolls one pod at a time (2 replicas, readiness on `/readyz`).
   - A 5 s `preStop` keeps a terminating pod serving until the Ingress has stopped
     routing to it.
   - Measured locally: 0 failed requests out of about 20,000 across two rolling restarts.
     Without the preStop hook, 2 out of 8,266 failed.
7. **Verify** both URLs, sign in, and check
   `kubectl get pods -A | grep -v Running` is empty.

**Zero downtime:**
- The gateway, dashboard, woo-mcp and upstreams roll without downtime.
- **WordPress, MariaDB and Postgres use `Recreate`**, because their volumes are
  ReadWriteOnce: two pods must never share a data directory. Upgrading them means a
  short outage of the store or the gateway database; plan for it.

Store specifics:
- **Every `helm upgrade` of the store re-runs the store-init Job.** It is idempotent: it
  re-asserts settings and changes nothing else. Read its log with
  `kubectl -n store logs job/store-init`.
- **Upgrading WooCommerce:** bump `storeInit.woocommerceVersion`, then `helm upgrade`. The
  Job reinstalls the pinned version (`--force`) and runs `wp wc update` (DB migrations).
- **Upgrading WordPress:** bump `wordpress.image.tag`. Core is copied fresh from the image on
  every pod start (design.md D1.6), and the Job uses the same image. WordPress runs its DB
  upgrade on the first admin visit.
- **Rotating the store admin password:** edit `WP_ADMIN_PASSWORD` in `.env`, run
  `scripts/create-secrets.sh`, then `helm upgrade`.
- **Rotating the WooCommerce REST key:** remove `WC_CONSUMER_KEY` from `store/woo-mcp-secrets`,
  then `helm upgrade`. The Job creates a new key and deletes the old one.

Gateway specifics:
- **Migrations:** the gateway applies new Drizzle migrations at startup, under an advisory
  lock, before it serves traffic. Write migrations to be **expand-only** (add columns or
  tables; don't drop or rename in the same release), so the previous version keeps working
  during a rolling update and after a rollback.
- **Rotating the WooCommerce bearer token:** change `WOO_MCP_BEARER_TOKEN` in `.env`, run
  `create-secrets.sh`, then restart the gateway
  (`kubectl -n platform rollout restart deploy/gateway`). The seeder re-applies the
  built-in credential on boot, and woo-mcp re-reads its mounted Secret.

**Provisioned stores (multi-store bonus):**
- They follow automatically. After a deploy, every ready store is upgraded to the
  provisioner's bundled charts and the current values within `global.stores.resyncMinutes`,
  one store at a time and in the background (design D10.6). Watch progress on the Stores
  page.
- **Back up a store** before risky WordPress or WooCommerce bumps:
  ```bash
  STORE_NS=store-<name> bash scripts/backup.sh
  ```
  The store's own Secrets are kept in its namespace. To roll a store back, restore the
  backup into it, as in the data rollback below.

## Rollback procedure

**Application rollback** (bad code, same database schema):

```bash
helm history platform -n platform
```
```bash
helm rollback platform <previous-revision> -n platform --wait
```

The same works for `store`, `woo-mcp`, `mcp-notes` and `mcp-slow`. Alternatively, set
the previous `global.image.tag` and run `deploy-prod.sh` again, which keeps Git and the
cluster in agreement. Gateway migrations are expand-only (below), so the previous gateway
version runs fine on the newer schema.

**Data rollback** (a migration or plugin update damaged data). Restore from the backup
taken in step 2:

- *Store database:*
  ```bash
  gunzip -c backups/<time>/store-mariadb.sql.gz | kubectl -n store exec -i deploy/mariadb -c mariadb -- sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -uroot'
  ```
  The dump includes `CREATE DATABASE`/`USE`, so it restores into the same database.
  Scale WordPress to 0 first (`kubectl -n store scale deploy/wordpress --replicas=0`),
  and back to 1 afterwards.
- *wp-content:*
  ```bash
  kubectl -n store exec -i deploy/wordpress -c wordpress -- tar -C /var/www/html -xzf - < backups/<time>/wp-content.tar.gz
  ```
- *Gateway database:*
  ```bash
  kubectl -n platform exec -i deploy/postgres -c postgres -- sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backups/<time>/gateway-postgres.dump
  ```
  Scale the gateway to 0 first, and back to its replica count afterwards. The restored
  upstream credentials only decrypt with the same `CREDENTIAL_ENC_KEY`, so keep `.env`
  with your backups.

Tested in Phase 8: both dumps restored into scratch databases (`restore_test`) and
matched the live row counts exactly. MariaDB: 27 posts, 402 options, 9 orders. Postgres:
11 users, 24 keys, 3 upstreams, 6 permissions, 165 audit rows.

Store specifics: `helm rollback store <rev>` restores manifests and image tags. It does
**not** undo database migrations. WooCommerce and WordPress don't support schema
downgrades, so take a MariaDB dump before bumping either version:
`kubectl -n store exec deploy/mariadb -- mariadb-dump ...`. The PVCs are kept on
uninstall (`helm.sh/resource-policy: keep`).

## Pinned third-party versions

| Component | Version | Where pinned |
|---|---|---|
| ingress-nginx chart | 4.15.1 | `scripts/up-local.sh`, `scripts/deploy-prod.sh` |
| cert-manager chart (prod only) | v1.21.2 (released 2026-09-11) | `scripts/deploy-prod.sh` |
| k3s (prod only) | stable channel at install time; record it with `k3s --version` | `get.k3s.io` |
| WordPress image | `wordpress:7.1.3-php8.5-apache` | `charts/store/values.yaml` |
| wp-cli image | `wordpress:cli-2.12.0-php8.5` | `charts/store/values.yaml` |
| MariaDB image | `mariadb:11.8.9` | `charts/store/values.yaml` |
| WooCommerce plugin | 11.2.1 | `charts/store/values.yaml` (`storeInit.woocommerceVersion`) |
| Node base image (all Node services) | `node:22.23.3-alpine3.24` | `*/Dockerfile` |
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.1 | `mcp-woo/package.json` + `pnpm-lock.yaml` |
| MCP Inspector (verification only) | 2.8.0 | commands in README / docs |
| Postgres image | `postgres:16.15-bookworm` | `charts/postgres/values.yaml` |
| Dashboard web server | `nginxinc/nginx-unprivileged:1.31.6-alpine3.24` | `dashboard/Dockerfile` |
| Dashboard libs | React 18.3.1, React Router 7.18.4, TanStack Query 5.104, Vite 8.3, Tailwind 4.3 | `dashboard/package.json` + `pnpm-lock.yaml` |
| Gateway libs | fastify 5.12, drizzle-orm 0.45, pg 8.23, argon2 0.45, undici 8.11 | `gateway/package.json` + `pnpm-lock.yaml` |
