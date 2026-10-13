import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { loginFailures } from "../db/schema.js";

/**
 * Login rate limiting: at most `max` failed logins per client IP AND per email within a
 * sliding window (spec: 5 per 15 minutes). Counted in Postgres so the limit holds across
 * gateway replicas. Per-email limiting stops password guessing on one account from many
 * IPs; per-IP limiting stops one client spraying many accounts.
 */
export interface LoginLimits {
  max: number;
  windowMinutes: number;
}

export const loginKeys = (ip: string, email: string) => [`ip:${ip}`, `email:${email}`];

export async function isLoginBlocked(db: Db, keys: string[], limits: LoginLimits): Promise<boolean> {
  const since = new Date(Date.now() - limits.windowMinutes * 60_000);
  const rows = await db
    .select({ key: loginFailures.key, n: count() })
    .from(loginFailures)
    .where(and(inArray(loginFailures.key, keys), gt(loginFailures.ts, since)))
    .groupBy(loginFailures.key);
  return rows.some((r) => Number(r.n) >= limits.max);
}

export async function recordLoginFailure(db: Db, keys: string[]): Promise<void> {
  await db.insert(loginFailures).values(keys.map((key) => ({ key })));
}

/** After a successful login, that account's failure count starts over (the IP's doesn't). */
export async function clearLoginFailures(db: Db, key: string): Promise<void> {
  await db.delete(loginFailures).where(eq(loginFailures.key, key));
}

export async function purgeOldLoginFailures(db: Db, windowMinutes: number): Promise<void> {
  await db.delete(loginFailures).where(lt(loginFailures.ts, new Date(Date.now() - windowMinutes * 60_000)));
}
