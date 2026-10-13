#!/usr/bin/env bash
# store-init: idempotent WordPress + WooCommerce setup, run as a Helm post-install /
# post-upgrade hook. Every step checks current state before changing anything, so a
# re-run (any `helm upgrade`) is a no-op apart from re-asserting settings.
#
# Inputs (env): STORE_URL, STORE_TITLE, STORE_CURRENCY, STORE_COUNTRY, STORE_ADDRESS,
#   STORE_CITY, STORE_POSTCODE, WC_VERSION, WORDPRESS_SERVICE_URL, WOO_MCP_SECRET,
#   SAMPLE_{NAME,SLUG,PRICE,DESCRIPTION}, WP_ADMIN_{USER,PASSWORD,EMAIL},
#   WC_CONSUMER_{KEY,SECRET} (optional: the current values from the woo-mcp Secret),
#   plus the WORDPRESS_DB_* variables read by wp-config.php.
set -euo pipefail

log() { printf '[store-init] %s\n' "$*"; }
die() { printf '[store-init] ERROR: %s\n' "$*" >&2; exit 1; }

# 1. Wait for the database and WordPress. ---------------------------------------------
wait_for() { # <description> <command...>
  local what="$1"; shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then log "$what is reachable"; return 0; fi
    sleep 5
  done
  die "$what not reachable after 5 minutes"
}
db_up() {
  php -r 'mysqli_report(MYSQLI_REPORT_OFF);
    $c = @mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"),
                         getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME"));
    exit($c ? 0 : 1);'
}
# Any HTTP answer below 500 means Apache + PHP are serving (before install, wp-login.php
# answers 302 to the installer, which also counts).
wp_up() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$WORDPRESS_SERVICE_URL/wp-login.php")"
  [ "$code" -ge 200 ] && [ "$code" -lt 500 ]
}
wait_for "database" db_up
wait_for "WordPress" wp_up

# 2. Install WordPress core tables. -----------------------------------------------------
if wp core is-installed 2>/dev/null; then
  log "WordPress already installed"
else
  # No --admin_password: it would sit on argv, and wp-cli's --prompt echoes the full
  # command (password included) into the log. WordPress generates a throwaway password
  # here, and ensure-admin.php replaces it straight after, reading the real one from env.
  wp core install --url="$STORE_URL" --title="$STORE_TITLE" \
    --admin_user="$WP_ADMIN_USER" --admin_email="$WP_ADMIN_EMAIL" --skip-email >/dev/null
  log "WordPress installed"
fi
wp eval-file /opt/store-init/ensure-admin.php

# Pretty permalinks: WooCommerce REST lives under /wp-json/, which needs them.
if [ "$(wp option get permalink_structure)" != "/%postname%/" ]; then
  wp rewrite structure '/%postname%/' --quiet
  log "permalinks set to /%postname%/"
fi
wp rewrite flush --quiet

# 3. WooCommerce plugin (pinned version). ------------------------------------------------
if ! wp plugin is-installed woocommerce; then
  wp plugin install woocommerce --version="$WC_VERSION" --activate
  log "WooCommerce $WC_VERSION installed and activated"
else
  current="$(wp plugin get woocommerce --field=version)"
  if [ "$current" != "$WC_VERSION" ]; then
    wp plugin install woocommerce --version="$WC_VERSION" --force
    log "WooCommerce changed $current -> $WC_VERSION"
  else
    log "WooCommerce $WC_VERSION already installed"
  fi
  if ! wp plugin is-active woocommerce; then
    wp plugin activate woocommerce
    log "WooCommerce activated"
  fi
fi
# Apply any pending WooCommerce DB migrations (no-op when up to date).
wp wc update --quiet

# 4-5. Store settings. `option update` is naturally idempotent. ---------------------------
opt() { wp option update "$@" --quiet; }
opt woocommerce_currency "$STORE_CURRENCY"
opt woocommerce_default_country "$STORE_COUNTRY"
opt woocommerce_store_address "$STORE_ADDRESS"
opt woocommerce_store_city "$STORE_CITY"
opt woocommerce_store_postcode "$STORE_POSTCODE"
# New stores start in "coming soon" mode, which hides the shop from visitors.
opt woocommerce_coming_soon no
opt woocommerce_store_pages_only no
# Shipping is disabled so checkout needs no shipping zones (see docs/design.md D1.5).
opt woocommerce_ship_to_countries disabled
opt woocommerce_enable_guest_checkout yes
opt woocommerce_allow_tracking no
opt woocommerce_show_marketplace_suggestions no
opt woocommerce_onboarding_profile '{"skipped":true}' --format=json
# Cash on Delivery.
opt woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json
log "store settings applied (currency $STORE_CURRENCY, COD enabled)"

# Shop/Cart/Checkout/My account pages: the tool only creates pages that are missing.
wp wc tool run install_pages --user="$WP_ADMIN_USER" --quiet
log "WooCommerce pages ensured"

# 6. REST API key for woo-mcp, stored in the woo-mcp Secret. -----------------------------
# ensure-api-key.php prints nothing to stdout if the Secret's key is valid, or a JSON
# object with the new key pair if it had to create one. Logs go to stderr.
new_key_json="$(wp eval-file /opt/store-init/ensure-api-key.php)"
if [ -n "$new_key_json" ]; then
  sa=/var/run/secrets/kubernetes.io/serviceaccount
  ns="$(cat "$sa/namespace")"
  hdr="$(mktemp)"
  printf 'Authorization: Bearer %s\n' "$(cat "$sa/token")" > "$hdr"
  # Body goes through stdin and the token through a header file: neither is on argv.
  # Merge patch: only the two WC keys change; the bearer token is left as is.
  php -r '$k = json_decode(stream_get_contents(STDIN), true);
    echo json_encode(["data" => [
      "WC_CONSUMER_KEY" => base64_encode($k["ck"]),
      "WC_CONSUMER_SECRET" => base64_encode($k["cs"])]]);' <<<"$new_key_json" \
  | curl -sS --fail-with-body -o /dev/null --max-time 15 \
      --cacert "$sa/ca.crt" -H @"$hdr" \
      -H 'Content-Type: application/merge-patch+json' \
      -X PATCH --data-binary @- \
      "https://kubernetes.default.svc/api/v1/namespaces/$ns/secrets/$WOO_MCP_SECRET" \
    || { rm -f "$hdr"; die "could not patch Secret $WOO_MCP_SECRET"; }
  rm -f "$hdr"
  log "new REST key written to Secret $WOO_MCP_SECRET"
fi

# 7. Sample product. ---------------------------------------------------------------------
count="$(wp post list --post_type=product --name="$SAMPLE_SLUG" --post_status=any --format=count)"
if [ "$count" = "0" ]; then
  id="$(wp wc product create --user="$WP_ADMIN_USER" --name="$SAMPLE_NAME" --slug="$SAMPLE_SLUG" \
        --regular_price="$SAMPLE_PRICE" --description="$SAMPLE_DESCRIPTION" --status=publish --porcelain)"
  log "sample product created (id $id)"
else
  log "sample product already exists"
fi

log "done"
