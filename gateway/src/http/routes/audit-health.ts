import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditStats, queryAudit } from "../../audit/service.js";
import type { Core } from "../../core.js";
import { parseBody } from "../errors.js";
import { currentUser, requireSession } from "../guards.js";

const AuditQuery = z.object({
  userId: z.uuid().optional(),
  serverSlug: z.string().max(30).optional(),
  outcome: z.enum(["ok", "error", "denied", "timeout", "unreachable", "disabled"]).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

const StatsQuery = z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) });

export function auditAndHealthRoutes(app: FastifyInstance, core: Core): void {
  // Per-server error rate and average latency (default: the last hour). Members get
  // stats for their own calls only, like the audit log itself.
  app.get("/api/audit/stats", { preHandler: requireSession(core) }, async (req) => {
    const me = currentUser(req);
    const q = parseBody(StatsQuery, req.query);
    const servers = await auditStats(core.db, { minutes: q.minutes, userId: me.role === "admin" ? undefined : me.id });
    return { minutes: q.minutes, scope: me.role === "admin" ? "all" : "own", servers };
  });

  // Admins see everything; a member's query is always pinned to their own user id,
  // whatever userId they pass.
  app.get("/api/audit", { preHandler: requireSession(core) }, async (req) => {
    const me = currentUser(req);
    const q = parseBody(AuditQuery, req.query);
    return queryAudit(core.db, {
      userId: me.role === "admin" ? q.userId : me.id,
      serverSlug: q.serverSlug,
      outcome: q.outcome,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
      cursor: q.cursor,
    });
  });

  // Liveness: the process is up. No dependencies, so a database outage never restarts pods.
  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness: Postgres answers. A pod without its database is taken out of the Service.
  app.get("/readyz", async (_req, reply) => {
    try {
      await Promise.race([
        core.db.execute(sql`select 1`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2_000).unref()),
      ]);
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "not ready", reason: "database unavailable" };
    }
  });
}
