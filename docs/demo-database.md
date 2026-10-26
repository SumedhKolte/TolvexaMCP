# Showing the databases

How to show the reviewers where the data lives, that it persists, and that secrets are
never stored in plain text. Takes about 3 minutes in a demo. The assignment asks for:
"the store's database and WordPress content use persistent storage", API keys "stored
hashed", and upstream credentials "encrypted at rest". This page proves each of those.

## There are two databases and two kinds of volume

| What | Where | Holds | Persistent volume |
|---|---|---|---|
| Gateway database | Postgres 16, namespace `platform` | users, API keys (hashed), registered servers (credentials encrypted), permissions, audit log, extra stores | `postgres-data`, 2 Gi |
| Shop database | MariaDB 11.8, namespace `store` | WooCommerce products, orders, customers, settings | `mariadb-data`, 5 Gi |
| WordPress files | namespace `store` | plugins (WooCommerce), uploads, themes | `wordpress-content`, 5 Gi |
| Team notes | namespace `upstreams` | notes written through `notes__create_note` | `mcp-notes-data`, 1 Gi |

## 1. One command: the guided tour

```bash
bash scripts/show-db.sh
```

It prints three sections. You can also run one at a time: `gateway`, `store`, `volumes`.

**Gateway database.** Say what each table is for as it scrolls past:
- **Row counts.** All 8 tables, with what each holds.
- **users.** The password column is an argon2id hash (`$argon2id$v=19$m=65536,…`). The
  password itself is never stored.
- **api_keys.** Only a 16-character prefix of a SHA-256 hash is shown. The full key was
  displayed once, at creation. *"If this database leaks, nobody can use these keys."*
- **upstreams.** The credential is shown as `cred_bytes = 80` and a few ciphertext bytes:
  AES-256-GCM, with the key held only in a Kubernetes Secret. *"Even with database access
  you can't read the WooCommerce token."*
- **tool_permissions.** The role policy: members read orders and products, only admins
  create products, change order status, or crash the slow server.
- **audit_log.** The newest calls with user, source (`mcp` or `chat`), tool, outcome and
  duration. This is the same data the dashboard's Audit page shows.

**Shop database.** Products and orders as WooCommerce stores them (orders are in the
`wp_wc_orders` tables). The query shows only the city, so no customer names, emails or
street addresses appear on screen.

**Volumes.** Each volume, its size, and which pod mounts it.

## 2. The persistence proof

```bash
bash scripts/show-db.sh persist
```

This is the most convincing 30 seconds. It:
1. prints row counts (users, servers, keys, permission rules, audit rows, products, orders,
   settings, the notes file size);
2. deletes the Postgres, MariaDB and mcp-notes pods;
3. waits until the old pods are completely gone, and prints old pod → new pod, so you can
   see they are different pods;
4. prints the counts again and says **PASS** only if they are identical.

*Say:* "The pods are disposable; the data is on the volumes." The gateway stays up while
this happens (its database pool reconnects), and the storefront comes back within seconds.

It restarts databases, so it refuses to run on anything but a local Kind cluster.

## 3. A graphical client (optional)

For a visual look, use any database client (TablePlus, DBeaver, DataGrip). The databases
are not exposed outside the cluster, so open a tunnel first. Keep it in its own terminal
tab and close it afterwards.

**Postgres** (the gateway's database):

```bash
kubectl -n platform port-forward svc/postgres 5432:5432
```

Connect to host `127.0.0.1`, port `5432`, database `gateway`, user `gateway`. To get the
password into your clipboard without it ever appearing on screen:

```bash
kubectl -n platform get secret postgres-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d | pbcopy
```

**MariaDB** (the shop):

```bash
kubectl -n store port-forward svc/mariadb 3306:3306
```

Host `127.0.0.1`, port `3306`, database `wordpress`, user `wordpress`. Password:

```bash
kubectl -n store get secret mariadb-secrets -o jsonpath='{.data.MARIADB_PASSWORD}' | base64 -d | pbcopy
```

Only read in a client. Don't edit the audit log, keys or permissions by hand: the
gateway is the only writer by design.

## Don't show these on screen

- `.env` and `.env.ui-test.local` (real passwords and the LLM key).
- `kubectl get secret … -o yaml` or any `-o jsonpath` that prints a value. Secrets are
  only base64, not encrypted, so showing one reveals it. Use the clipboard commands above.
- The terminal tab where MCP Inspector prints its session token.

If asked "where is the secret then?", show that it exists without printing it:

```bash
kubectl -n platform get secret gateway-secrets -o jsonpath='{.data}' | jq 'keys'
```

That lists the key names (`ADMIN_PASSWORD`, `CREDENTIAL_ENC_KEY`, …) and no values.

## Questions the reviewers may ask

- **"Is this a proper database?"** Yes: Postgres for the gateway and MariaDB for the
  shop, each on its own PersistentVolumeClaim, with migrations (Drizzle) applied at
  start-up under an advisory lock. Both are single replicas on ReadWriteOnce volumes, so
  they are persistent, not highly available. Production would add replication and
  scheduled off-site backups (`scripts/backup.sh`, tested with a restore).
- **"What survives what?"** A deleted pod: everything (shown above). `helm uninstall`:
  the main store's and the gateway's volumes are kept (`helm.sh/resource-policy: keep`).
  Deleting the Kind cluster: nothing, because the volumes are on the cluster's disk. That
  is what backups are for.
- **"Why SHA-256 for keys but argon2 for passwords?"** API keys are 43 random characters
  (about 256 bits), so a fast hash is safe and lets the gateway look a key up on every
  request. Passwords are chosen by people, so they get a slow, memory-hard hash.
