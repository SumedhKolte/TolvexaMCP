<?php
/**
 * Make the store admin's password match WP_ADMIN_PASSWORD (from the wordpress Secret).
 * Run with `wp eval-file`. The password is read from the environment, so it never appears
 * on a command line or in a log.
 *
 * The password is only written when it differs: wp_set_password() also destroys the
 * user's sessions, and an unconditional write would log the admin out on every upgrade.
 * Consequence (documented): the Secret is the source of truth. To rotate, change .env,
 * run create-secrets.sh, then helm upgrade.
 */

$login    = (string) getenv( 'WP_ADMIN_USER' );
$password = (string) getenv( 'WP_ADMIN_PASSWORD' );

if ( '' === $password ) {
	WP_CLI::error( 'WP_ADMIN_PASSWORD is empty' );
}

$user = get_user_by( 'login', $login );
if ( ! $user ) {
	WP_CLI::error( "admin user '{$login}' not found" );
}

if ( wp_check_password( $password, $user->user_pass, $user->ID ) ) {
	WP_CLI::log( '[store-init] admin password matches the Secret' );
	return;
}

wp_set_password( $password, $user->ID );
WP_CLI::log( '[store-init] admin password set from the Secret' );
