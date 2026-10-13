import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { hashPassword } from "../auth/passwords.js";
import { decryptCredential, encryptCredential } from "../crypto/credentials.js";
import { DEFAULT_RULES } from "../router/permissions.js";
import type { Db } from "./client.js";
import { toolPermissions, upstreams, users } from "./schema.js";

export interface SeedInput {
  adminEmail: string;
  adminPassword: string;
  wooMcpUrl: string;
  wooMcpToken: string;
  encKey: Buffer;
}

export const BUILTIN_SLUG = "woocommerce";

/**
 * First-boot seeding. Idempotent: safe on every start and on every replica (the caller
 * holds a Postgres advisory lock, so replicas never seed concurrently).
 *
 *  - admin user: created only when the users table is empty. ADMIN_PASSWORD is used for
 *    this one insert and never again (changing it later has no effect).
 *  - built-in WooCommerce upstream: created if missing. Its URL and bearer token are
 *    managed by the deployment (WOO_MCP_URL / WOO_MCP_BEARER_TOKEN), so they're
 *    re-applied on boot when they differ; that's how the token is rotated. Whether it's
 *    enabled stays an admin decision and is never touched.
 *  - default tool permissions: inserted if missing; admin edits are never overwritten.
 */
export async function seed(db: Db, input: SeedInput): Promise<string[]> {
  const actions: string[] = [];

  const [userCount] = await db.select({ n: count() }).from(users);
  if ((userCount?.n ?? 0) === 0) {
    await db.insert(users).values({
      email: input.adminEmail.trim().toLowerCase(),
      passwordHash: await hashPassword(input.adminPassword),
      role: "admin",
    });
    actions.push("created admin user");
  }

  const [woo] = await db.select().from(upstreams).where(eq(upstreams.slug, BUILTIN_SLUG));
  if (!woo) {
    const id = randomUUID();
    const enc = encryptCredential(input.wooMcpToken, input.encKey, id);
    await db.insert(upstreams).values({
      id,
      slug: BUILTIN_SLUG,
      name: "WooCommerce",
      url: input.wooMcpUrl,
      enabled: true,
      credType: "bearer",
      credEncrypted: enc.ciphertext,
      credNonce: enc.nonce,
      builtin: true,
    });
    actions.push("registered built-in woocommerce upstream");
  } else if (woo.builtin) {
    let current: string | null = null;
    try {
      current = woo.credEncrypted && woo.credNonce
        ? decryptCredential({ ciphertext: woo.credEncrypted, nonce: woo.credNonce }, input.encKey, woo.id)
        : null;
    } catch {
      current = null; // e.g. CREDENTIAL_ENC_KEY rotated: re-encrypt with the new key
    }
    if (current !== input.wooMcpToken || woo.url !== input.wooMcpUrl || woo.credType !== "bearer") {
      const enc = encryptCredential(input.wooMcpToken, input.encKey, woo.id);
      await db
        .update(upstreams)
        .set({ url: input.wooMcpUrl, credType: "bearer", credHeaderName: null, credEncrypted: enc.ciphertext, credNonce: enc.nonce, updatedAt: new Date() })
        .where(eq(upstreams.id, woo.id));
      actions.push("updated built-in woocommerce url/credential from deployment config");
    }
  }

  const inserted = await db
    .insert(toolPermissions)
    .values(DEFAULT_RULES.map((r) => ({ toolName: r.toolName, allowedRoles: r.allowedRoles })))
    .onConflictDoNothing()
    .returning({ t: toolPermissions.toolName });
  if (inserted.length) actions.push(`inserted ${inserted.length} default tool permission(s)`);

  return actions;
}
