import { and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditLog, users } from "../db/schema.js";
import type { AuditEntry } from "./types.js";

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values(e);
}

export interface AuditQuery {
  userId?: string;
  serverSlug?: string;
  outcome?: AuditEntry["outcome"];
  from?: Date;
  to?: Date;
  limit: number;
  /** id of the last row of the previous page (rows are returned newest first). */
  cursor?: number;
}

export interface AuditItem {
  id: number;
  ts: string;
  userId: string | null;
  userEmail: string | null;
  apiKeyId: string | null;
  source: string;
  serverSlug: string | null;
  tool: string | null;
  argsSummary: string | null;
  durationMs: number;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Keyset pagination on the bigserial id (newest first). Unlike OFFSET it stays fast and
 * doesn't skip or repeat rows while new calls are being inserted.
 */
export async function queryAudit(db: Db, q: AuditQuery): Promise<{ items: AuditItem[]; nextCursor: number | null }> {
  const where: SQL[] = [];
  if (q.userId) where.push(eq(auditLog.userId, q.userId));
  if (q.serverSlug) where.push(eq(auditLog.serverSlug, q.serverSlug));
  if (q.outcome) where.push(eq(auditLog.outcome, q.outcome));
  if (q.from) where.push(gte(auditLog.ts, q.from));
  if (q.to) where.push(lte(auditLog.ts, q.to));
  if (q.cursor) where.push(lt(auditLog.id, q.cursor));

  const rows = await db
    .select({ a: auditLog, email: users.email })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  return {
    items: page.map(({ a, email }) => ({
      id: a.id,
      ts: a.ts.toISOString(),
      userId: a.userId,
      userEmail: email,
      apiKeyId: a.apiKeyId,
      source: a.source,
      serverSlug: a.serverSlug,
      tool: a.tool,
      argsSummary: a.argsSummary,
      durationMs: a.durationMs,
      outcome: a.outcome,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?.a.id ?? null) : null,
  };
}

export interface ServerStats {
  server: string;
  calls: number;
  /** error + timeout + unreachable: failures of the server or the call itself. */
  errors: number;
  /** errors / calls, 0..1. */
  error_rate: number;
  /** Policy refusals (FORBIDDEN) and calls to a disabled server: not server errors. */
  denied: number;
  /** Average over calls that reached the upstream (ok, error, timeout); null if none. */
  avg_latency_ms: number | null;
}

/**
 * Per-server error rate and average latency over the last `minutes`, computed from
 * audit_log (stand-out B, Audit page). userId pins the stats to one user (members).
 */
export async function auditStats(db: Db, q: { minutes: number; userId?: string; now?: Date }): Promise<ServerStats[]> {
  const since = new Date((q.now ?? new Date()).getTime() - q.minutes * 60_000);
  const rows = await db
    .select({
      server: sql<string>`coalesce(${auditLog.serverSlug}, '(unknown)')`,
      calls: sql<number>`count(*)::int`,
      errors: sql<number>`(count(*) filter (where ${auditLog.outcome} in ('error', 'timeout', 'unreachable')))::int`,
      denied: sql<number>`(count(*) filter (where ${auditLog.outcome} in ('denied', 'disabled')))::int`,
      avgLatency: sql<number | null>`round(avg(${auditLog.durationMs}) filter (where ${auditLog.outcome} in ('ok', 'error', 'timeout')))::int`,
    })
    .from(auditLog)
    .where(and(gte(auditLog.ts, since), q.userId ? eq(auditLog.userId, q.userId) : undefined))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((r) => ({
    server: r.server,
    calls: r.calls,
    errors: r.errors,
    error_rate: r.calls ? r.errors / r.calls : 0,
    denied: r.denied,
    avg_latency_ms: r.avgLatency,
  }));
}
