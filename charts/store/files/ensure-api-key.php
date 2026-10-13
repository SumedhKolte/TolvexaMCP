<?php
/**
 * Ensure woo-mcp has a working read_write WooCommerce REST key. Run with `wp eval-file`.
 *
 * WooCommerce stores consumer keys hashed (wc_api_hash), so an existing key can never be
 * read back. The Secret is therefore the source of truth:
 *   - Secret key pair matches a read_write row  -> do nothing, print nothing.
 *   - Otherwise (first run, DB reset, Secret reset) -> delete the keys this script owns,
 *     create a fresh pair, and print it as JSON on stdout for the shell to store.
 *
 * Log lines go to STDERR only; STDOUT carries the secret and nothing else, and the shell
 * never echoes it.
 */

global $wpdb;

$table       = $wpdb->prefix . 'woocommerce_api_keys';
$description = 'woo-mcp (managed by store-init)';
$log         = static function ( string $msg ): void {
	fwrite( STDERR, "[store-init] {$msg}\n" );
};

$ck = (string) getenv( 'WC_CONSUMER_KEY' );
$cs = (string) getenv( 'WC_CONSUMER_SECRET' );

if ( '' !== $ck && '' !== $cs ) {
	$row = $wpdb->get_row(
		$wpdb->prepare( "SELECT consumer_secret, permissions FROM {$table} WHERE consumer_key = %s", wc_api_hash( $ck ) )
	);
	if ( $row && hash_equals( $row->consumer_secret, $cs ) && 'read_write' === $row->permissions ) {
		$log( 'REST key in Secret is valid; nothing to do' );
		return;
	}
	$log( 'REST key in Secret does not match the database; rotating' );
} else {
	$log( 'no REST key in Secret yet; creating one' );
}

$user = get_user_by( 'login', (string) getenv( 'WP_ADMIN_USER' ) );
if ( ! $user ) {
	WP_CLI::error( 'admin user not found' );
}

// Remove only keys this script created earlier; keys made by hand in wp-admin stay.
$wpdb->delete( $table, array( 'description' => $description ) );

$ck = 'ck_' . wc_rand_hash();
$cs = 'cs_' . wc_rand_hash();

$ok = $wpdb->insert(
	$table,
	array(
		'user_id'         => $user->ID,
		'description'     => $description,
		'permissions'     => 'read_write',
		'consumer_key'    => wc_api_hash( $ck ),
		'consumer_secret' => $cs,
		'truncated_key'   => substr( $ck, -7 ),
	),
	array( '%d', '%s', '%s', '%s', '%s', '%s' )
);
if ( ! $ok ) {
	WP_CLI::error( 'could not insert REST key' );
}

$log( 'REST key created (…' . substr( $ck, -7 ) . ')' );
echo wp_json_encode( array( 'ck' => $ck, 'cs' => $cs ) );
