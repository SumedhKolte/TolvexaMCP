#!/usr/bin/env bash
# Back up everything that holds state: the store database (MariaDB), the uploads and
# plugins volume (wp-content), and the gateway database (Postgres: users, keys, servers,
# permissions, audit log). Run before every upgrade (docs/upgrade-rollback.md).
#
# Usage: backup.sh [output-dir]      default: ./backups/<UTC timestamp>/
#
# Files are written 0600 in a 0700 directory. Database credentials are read inside the
# pods from their own environment and passed via MYSQL_PWD (never on a command line).
# Secrets themselves are NOT backed up: they live in your .env, which you must keep
# somewhere safe separately (a password manager), or the encrypted upstream credentials
# in Postgres can't be decrypted after a restore.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE_NS="${STORE_NS:-store}"; PLATFORM_NS="${PLATFORM_NS:-platform}"
OUT="${1:-$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)}"

ok()  { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$OUT"
chmod 700 "$OUT"

# Store database: consistent InnoDB snapshot without locking the shop.
kubectl -n "$STORE_NS" exec deploy/mariadb -c mariadb -- sh -c \
  'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction --routines --triggers --databases "$MARIADB_DATABASE"' |
  gzip >"$OUT/store-mariadb.sql.gz"
zcat <"$OUT/store-mariadb.sql.gz" | tail -1 | grep -q 'Dump completed' || die "MariaDB dump is incomplete"
ok "store database -> store-mariadb.sql.gz ($(du -h "$OUT/store-mariadb.sql.gz" | cut -f1))"

# wp-content: uploads, plugins (WooCommerce), themes.
kubectl -n "$STORE_NS" exec deploy/wordpress -c wordpress -- tar -C /var/www/html -czf - wp-content >"$OUT/wp-content.tar.gz"
tar -tzf "$OUT/wp-content.tar.gz" | grep -q '^wp-content/plugins/woocommerce/' || die "wp-content archive looks wrong (no WooCommerce plugin)"
ok "wp-content -> wp-content.tar.gz ($(du -h "$OUT/wp-content.tar.gz" | cut -f1))"

# Gateway database: custom format (compressed; restore with pg_restore).
kubectl -n "$PLATFORM_NS" exec deploy/postgres -c postgres -- sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$OUT/gateway-postgres.dump"
[ "$(head -c 5 "$OUT/gateway-postgres.dump")" = "PGDMP" ] || die "Postgres dump is not a valid custom-format archive"
ok "gateway database -> gateway-postgres.dump ($(du -h "$OUT/gateway-postgres.dump" | cut -f1))"

echo "    Backup: $OUT"
