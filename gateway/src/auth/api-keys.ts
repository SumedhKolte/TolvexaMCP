import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { apiKeyMatches, apiKeyPrefix, generateApiKey } from "../crypto/tokens.js";
import type { Db } from "../db/client.js";
import { apiKeys, users } from "../db/schema.js";
import { isUniqueViolation } from "../http/errors.js";
import type { UserRow } from "./users.js";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export interface PublicApiKey {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function toPublicKey(k: ApiKeyRow): PublicApiKey {
  return {
    id: k.id,
    userId: k.userId,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}

/** Creates a key; the full key is in the return value and is never retrievable again. */
export async function createApiKey(db: Db, userId: string, name: string): Promise<{ row: ApiKeyRow; key: string }> {
  // Prefixes are 8 random chars (36^8): a collision is astronomically unlikely, but the
  // unique index makes it safe, and we simply draw again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const g = generateApiKey();
    try {
      const [row] = await db.insert(apiKeys).values({ userId, name, prefix: g.prefix, keyHash: g.hash }).returning();
      return { row: row as ApiKeyRow, key: g.key };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("could not allocate a unique key prefix");
}

export async function listApiKeys(db: Db, userId: string): Promise<ApiKeyRow[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
}

export async function findApiKey(db: Db, id: string): Promise<ApiKeyRow | undefined> {
  const [k] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return k;
}

export async function revokeApiKey(db: Db, id: string): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
}

export type KeyAuthResult =
  | { ok: true; user: UserRow; keyId: string }
  | { ok: false; reason: "invalid" | "revoked" | "disabled" };

/**
 * Verifies a presented API key on every request (no caching):
 *   format check -> row by prefix -> constant-time hash compare -> revoked? -> user disabled?
 * "revoked" and "invalid" are both answered with 401 by the caller; a disabled user gets
 * 403 (spec section 13).
 */
export async function authenticateApiKey(db: Db, candidate: string): Promise<KeyAuthResult> {
  const prefix = apiKeyPrefix(candidate);
  if (!prefix) return { ok: false, reason: "invalid" };
  const [row] = await db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.prefix, prefix));
  if (!row || !apiKeyMatches(candidate, row.key.keyHash)) return { ok: false, reason: "invalid" };
  if (row.key.revokedAt) return { ok: false, reason: "revoked" };
  if (row.user.disabledAt) return { ok: false, reason: "disabled" };

  // last_used_at is informational: update at most once a minute per key to avoid a
  // write on every MCP request.
  const staleBefore = new Date(Date.now() - 60_000);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiKeys.id, row.key.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, staleBefore))));
  return { ok: true, user: row.user, keyId: row.key.id };
}
