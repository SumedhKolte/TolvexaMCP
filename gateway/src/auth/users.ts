import { and, count, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiKeys, sessions, users } from "../db/schema.js";
import type { Role } from "../router/permissions.js";
import { hashPassword } from "./passwords.js";

export type UserRow = typeof users.$inferSelect;

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, email: u.email, role: u.role, disabled: u.disabledAt !== null, createdAt: u.createdAt.toISOString() };
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const [u] = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return u;
}

export async function findUserById(db: Db, id: string): Promise<UserRow | undefined> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

export async function createUser(db: Db, input: { email: string; role: Role; password: string }): Promise<UserRow> {
  const [u] = await db
    .insert(users)
    .values({ email: normalizeEmail(input.email), role: input.role, passwordHash: await hashPassword(input.password) })
    .returning();
  return u as UserRow;
}

export async function listUsersWithKeyCounts(db: Db): Promise<(PublicUser & { activeKeys: number })[]> {
  const rows = await db
    .select({ user: users, activeKeys: count(apiKeys.id) })
    .from(users)
    .leftJoin(apiKeys, and(eq(apiKeys.userId, users.id), isNull(apiKeys.revokedAt)))
    .groupBy(users.id)
    .orderBy(users.createdAt);
  return rows.map((r) => ({ ...toPublicUser(r.user), activeKeys: Number(r.activeKeys) }));
}

/** Active admins other than `exceptId`: used to refuse removing the last admin. */
export async function countOtherActiveAdmins(db: Db, exceptId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.disabledAt), ne(users.id, exceptId)));
  return Number(r?.n ?? 0);
}

export async function updateUser(db: Db, id: string, patch: { role?: Role; disabled?: boolean }): Promise<UserRow | undefined> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.role) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? new Date() : null;
  const [u] = await db.update(users).set(set).where(eq(users.id, id)).returning();
  // Disabling also ends every dashboard session right away (API keys are rejected
  // because every key check looks at the user's disabled flag).
  if (u && patch.disabled) await db.delete(sessions).where(eq(sessions.userId, id));
  return u;
}
