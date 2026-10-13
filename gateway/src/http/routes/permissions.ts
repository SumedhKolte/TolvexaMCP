import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Core } from "../../core.js";
import { toolPermissions } from "../../db/schema.js";
import { parseToolName } from "../../router/tool-name.js";
import { HttpError, parseBody } from "../errors.js";
import { currentUser, requireAdmin, requireSession } from "../guards.js";

/**
 * The permission table (stand-out A): which roles may call which tool.
 *
 *   GET    /api/permissions          every known tool with its effective roles (any user;
 *                                    members see it read-only)
 *   PUT    /api/permissions/:tool    admin: {"member": true|false} -> stores a rule
 *   DELETE /api/permissions/:tool    admin: drops the rule -> back to the default policy
 *
 * Admins can always call every tool (spec section 10), so the editable part is whether
 * members may. Rules are read on every request (Core.loadPolicy), so an edit applies to
 * tools/list, /mcp calls and the chat agent immediately, on every replica.
 */
const PutBody = z.object({ member: z.boolean() });

function toolParam(req: FastifyRequest): string {
  const name = (req.params as { tool: string }).tool;
  // Only well-formed exposed names ("<slug>__<tool>"); rules for tools that don't exist
  // yet are allowed on purpose, so an admin can restrict a tool before it appears.
  if (name.length > 100 || !parseToolName(name)) throw new HttpError(400, "BAD_REQUEST", "tool must be an exposed tool name like woocommerce__list_orders");
  return name;
}

export function permissionRoutes(app: FastifyInstance, core: Core): void {
  app.get("/api/permissions", { preHandler: requireSession(core) }, async () => {
    const rows = await core.syncUpstreams();
    const rules = new Map((await core.db.select().from(toolPermissions)).map((r) => [r.toolName, r]));
    const defaultAccess = core.config.DEFAULT_MEMBER_TOOL_ACCESS;
    const policy = await core.loadPolicy();

    type Entry = { name: string; server: string; server_name: string | null; description: string | null; available: boolean };
    const entries = new Map<string, Entry>();
    for (const row of rows) {
      for (const t of row.enabled ? core.manager.cachedTools(row.id) : []) {
        entries.set(t.exposedName, { name: t.exposedName, server: row.slug, server_name: row.name, description: t.description || null, available: true });
      }
    }
    // Tools that have a rule but aren't listed right now (server down, disabled or gone).
    for (const name of rules.keys()) {
      if (entries.has(name)) continue;
      const slug = parseToolName(name)?.slug ?? "";
      entries.set(name, { name, server: slug, server_name: rows.find((r) => r.slug === slug)?.name ?? null, description: null, available: false });
    }

    const tools = [...entries.values()]
      .sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
      .map((e) => {
        const rule = rules.get(e.name);
        return {
          ...e,
          roles: policy.isAllowed("member", e.name) ? ["admin", "member"] : ["admin"],
          source: rule ? "rule" : "default",
          updated_at: rule?.updatedAt.toISOString() ?? null,
        };
      });
    return { default_member_access: defaultAccess, tools };
  });

  app.put("/api/permissions/:tool", { preHandler: requireAdmin(core) }, async (req) => {
    const tool = toolParam(req);
    const { member } = parseBody(PutBody, req.body);
    const allowedRoles = member ? ["admin", "member"] : ["admin"];
    await core.db
      .insert(toolPermissions)
      .values({ toolName: tool, allowedRoles })
      .onConflictDoUpdate({ target: toolPermissions.toolName, set: { allowedRoles, updatedAt: new Date() } });
    req.log.info({ tool, member, by: currentUser(req).id }, "tool permission changed");
    return { tool, roles: allowedRoles, source: "rule" };
  });

  app.delete("/api/permissions/:tool", { preHandler: requireAdmin(core) }, async (req) => {
    const tool = toolParam(req);
    await core.db.delete(toolPermissions).where(eq(toolPermissions.toolName, tool));
    req.log.info({ tool, by: currentUser(req).id }, "tool permission reset to default");
    const member = core.config.DEFAULT_MEMBER_TOOL_ACCESS === "allow";
    return { tool, roles: member ? ["admin", "member"] : ["admin"], source: "default" };
  });
}
