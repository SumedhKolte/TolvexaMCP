import { createHmac, randomBytes } from "node:crypto";

/**
 * One-legged OAuth 1.0a request signing, exactly as WooCommerce verifies it.
 *
 * Why OAuth and not HTTP Basic: WooCommerce only accepts Basic auth (or consumer_key /
 * consumer_secret query params) when the request is TLS (`is_ssl()`); over plain HTTP it
 * requires OAuth 1.0a. woo-mcp talks to WordPress over the in-cluster HTTP Service, so it
 * signs requests. Bonus: the consumer secret never travels on the wire at all.
 * (Verified against a real request; see docs/design.md D2.2.)
 *
 * WooCommerce's verifier (class-wc-rest-authentication.php, check_oauth_signature):
 *   base string = METHOD & enc(signatureUrl) & enc(join("&", enc(k) "=" enc(v)))
 *   - params    = query-string params + oauth_* params (the JSON body is not signed)
 *   - sorted by raw key (strcmp)
 *   - enc       = RFC 3986 percent-encoding (PHP rawurlencode)
 *   - signatureUrl = home URL + request path, scheme forced to http for non-TLS requests
 *   - key       = consumer_secret + "&" (no token secret in one-legged OAuth)
 */

/** RFC 3986 encoding (= PHP rawurlencode): encodeURIComponent also escapes !'()* there. */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function signatureBaseString(
  method: string,
  signatureUrl: string,
  params: Record<string, string>,
): string {
  const pairs = Object.keys(params)
    .sort() // ASCII keys: same order as PHP strcmp
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k] as string)}`);
  return [method.toUpperCase(), rfc3986(signatureUrl), rfc3986(pairs.join("&"))].join("&");
}

export interface OAuthRequest {
  method: string;
  /** Signature URL without query string (see module doc). */
  signatureUrl: string;
  /** Query-string params that will be sent with the request. */
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  /** Injected in tests; generated otherwise. */
  nonce?: string;
  timestamp?: number;
}

/** Returns the value for the `Authorization` header: `OAuth oauth_consumer_key="…", …`. */
export function oauthAuthorizationHeader(r: OAuthRequest): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: r.consumerKey,
    // WooCommerce keeps used nonces for 15 minutes; 32 hex chars from a CSPRNG.
    oauth_nonce: r.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(r.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const base = signatureBaseString(r.method, r.signatureUrl, { ...r.query, ...oauth });
  const signature = createHmac("sha256", `${r.consumerSecret}&`).update(base).digest("base64");
  const fields = { ...oauth, oauth_signature: signature };
  return (
    "OAuth " +
    Object.entries(fields)
      .map(([k, v]) => `${k}="${rfc3986(v)}"`)
      .join(", ")
  );
}
