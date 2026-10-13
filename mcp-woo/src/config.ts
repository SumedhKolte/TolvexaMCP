import { z } from "zod";

/**
 * Runtime configuration, validated once at startup. A missing or malformed value stops
 * the process with a readable message instead of failing later on the first request.
 *
 * Secrets (WooCommerce key pair, bearer token) are NOT part of this config: they are read
 * per request from SECRETS_DIR (see secrets.ts) so a rotated Secret is picked up without
 * a restart.
 */
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Where requests are sent, e.g. http://wordpress.store.svc.cluster.local */
  WC_BASE_URL: z.url(),
  /**
   * The URL WooCommerce uses when it re-computes the OAuth signature: the site's home URL,
   * with the scheme forced to http for non-TLS requests. This differs from WC_BASE_URL
   * because we call WordPress by its in-cluster Service name. Defaults to WC_BASE_URL.
   */
  WC_SIGNATURE_BASE_URL: z.url().optional(),
  WC_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  /** Directory of mounted Secret files. Unset: secrets come from env vars (local dev). */
  SECRETS_DIR: z.string().min(1).optional(),
});

export type Config = {
  port: number;
  wcBaseUrl: string;
  wcSignatureBaseUrl: string;
  wcTimeoutMs: number;
  secretsDir: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const c = parsed.data;
  const trim = (u: string) => u.replace(/\/+$/, "");
  return {
    port: c.PORT,
    wcBaseUrl: trim(c.WC_BASE_URL),
    wcSignatureBaseUrl: trim(c.WC_SIGNATURE_BASE_URL ?? c.WC_BASE_URL),
    wcTimeoutMs: c.WC_TIMEOUT_MS,
    secretsDir: c.SECRETS_DIR,
  };
}
