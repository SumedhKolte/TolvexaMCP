import { and, eq, gt, lt } from "drizzle-orm";
import { newSessionToken, sessionIdFor } from "../crypto/tokens.js";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { UserRow } from "./users.js";

export const SESSION_COOKIE = "tmg_session";

export async function createSession(db: Db, userId: string, ttlHours: number, secret: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db.insert(sessions).values({ id: sessionIdFor(token, secret), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * The user behind a session cookie, or undefined. Checked against the DB on every
 * request: an expired session, a deleted session (logout), or a disabled user are
 * rejected immediately. No auth decision is cached beyond the request.
 */
export async function userForSession(db: Db, token: string, secret: string): Promise<UserRow | undefined> {
  if (!token || token.length > 100) return undefined;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionIdFor(token, secret)), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.disabledAt) return undefined;
  return row.user;
}

export async function deleteSession(db: Db, token: string, secret: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionIdFor(token, secret)));
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
