import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type SecretName = "WC_CONSUMER_KEY" | "WC_CONSUMER_SECRET" | "WOO_MCP_BEARER_TOKEN";

/**
 * Returns a function that reads a secret on every call.
 *
 * In Kubernetes the Secret is mounted as a directory (not via env and not via subPath),
 * because only directory mounts are refreshed by the kubelet when the Secret changes.
 * Re-reading per request means a rotated WooCommerce key (written by the store-init Job)
 * or bearer token takes effect within the kubelet sync period, with no restart.
 * The files are tiny and served from the page cache, so this is cheap.
 *
 * Without a secrets dir (local `pnpm dev`), values come from environment variables.
 */
export function secretReader(secretsDir: string | undefined) {
  return async (name: SecretName): Promise<string | undefined> => {
    if (!secretsDir) {
      const v = process.env[name]?.trim();
      return v ? v : undefined;
    }
    try {
      const v = (await readFile(join(secretsDir, name), "utf8")).trim();
      return v ? v : undefined;
    } catch {
      return undefined; // missing key in the Secret: treated as "not configured"
    }
  };
}

export type SecretReader = ReturnType<typeof secretReader>;
