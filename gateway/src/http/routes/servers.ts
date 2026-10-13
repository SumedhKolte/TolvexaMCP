import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LIST_WAIT_MS, type Core } from "../../core.js";
import type { UpstreamRow } from "../../registry/service.js";
import { SLUG_RE } from "../../router/tool-name.js";
import { conflict, parseBody } from "../errors.js";
import { currentUser, requireAdmin, requireSession } from "../guards.js";
import { serverView, toolView } from "../views.js";

const Uuid = z.uuid();
const timeoutMs = z.number().int().min(100).max(300_000);
const credType = z.enum(["none", "header", "bearer"]);

/** "My Notes Server!" -> "my-notes-server" (the dashboard suggests the same). */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z.string().regex(SLUG_RE, "lowercase letters, digits and dashes, 2-30 characters").optional(),
    url: z.string().trim().max(2048),
    cred_type: credType.default("none"),
    cred_header_name: z.string().max(64).nullish(),
    credential: z.string().max(4096).nullish(),
    timeout_ms: timeoutMs.optional(),
  })
  .transform((b) => ({ ...b, slug: b.slug ?? slugify(b.name) }))
  .refine((b) => SLUG_RE.test(b.slug), { message: "slug: could not derive a valid slug from the name; pass one", path: ["slug"] })
  // "store-*" belongs to provisioned stores (Stores page), so a manual server can't take it.
  .refine((b) => !b.slug.startsWith("store-"), { message: "slug: the store- prefix is reserved for stores created on the Stores page", path: ["slug"] });

const PatchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().max(2048).optional(),
  cred_type: credType.optional(),
  cred_header_name: z.string().max(64).nullish(),
  credential: z.string().max(4096).nullish(),
  timeout_ms: timeoutMs.optional(),
});

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms).unref())]);
}

export function serverRoutes(app: FastifyInstance, core: Core): void {
  const session = requireSession(core);
  const admin = requireAdmin(core);
  const { manager, registry } = core;

  const idParam = (req: { params: unknown }) => parseBody(Uuid, (req.params as { id: string }).id);

  /** Sync, then give never-checked servers a bounded chance to report a real status. */
  async function freshRows(): Promise<UpstreamRow[]> {
    const rows = await core.syncUpstreams();
    const pending = rows.filter((r) => r.enabled && manager.status(r.id) === "pending");
    await Promise.allSettled(pending.map((r) => withTimeout(manager.check(r.id), LIST_WAIT_MS)));
    return rows;
  }

  /** After a write: apply it to the manager and test-connect once (bounded). */
  async function afterWrite(row: UpstreamRow) {
    await core.syncUpstreams();
    if (row.enabled) await withTimeout(manager.check(row.id), 8_000); // connect 5 s + list 3 s
    return serverView(row, manager.snapshot(row.id), true);
  }

  app.get("/api/servers", { preHandler: session }, async (req) => {
    const isAdmin = currentUser(req).role === "admin";
    const rows = await freshRows();
    return { servers: rows.map((r) => serverView(r, manager.snapshot(r.id), isAdmin)) };
  });

  // Saved even if the test connection fails, so an unreachable server can be registered
  // and shows up as unreachable (spec). The SSRF check, however, is a hard failure.
  app.post("/api/servers", { preHandler: admin }, async (req, reply) => {
    const b = parseBody(CreateBody, req.body);
    const row = await registry.create({
      slug: b.slug,
      name: b.name,
      url: b.url,
      credType: b.cred_type,
      credHeaderName: b.cred_header_name ?? null,
      credential: b.credential ?? null,
      timeoutMs: b.timeout_ms,
    });
    reply.code(201);
    return { server: await afterWrite(row) };
  });

  // Store servers are managed by the Stores page (D10.x): editing or deleting one here
  // would leave the store pointing at nothing. Enable/disable stays available.
  const notStoreManaged = async (id: string) => {
    const row = await registry.get(id);
    if (row.slug.startsWith("store-")) throw conflict("This server belongs to a provisioned store; manage it on the Stores page");
  };

  app.patch("/api/servers/:id", { preHandler: admin }, async (req) => {
    const b = parseBody(PatchBody, req.body);
    await notStoreManaged(idParam(req));
    const row = await registry.update(idParam(req), {
      name: b.name,
      url: b.url,
      credType: b.cred_type,
      credHeaderName: b.cred_header_name,
      credential: b.credential,
      timeoutMs: b.timeout_ms,
    });
    return { server: await afterWrite(row) };
  });

  app.post("/api/servers/:id/enable", { preHandler: admin }, async (req) => ({
    server: await afterWrite(await registry.setEnabled(idParam(req), true)),
  }));

  // Disabled servers are never contacted; their tools vanish from every listing at once.
  app.post("/api/servers/:id/disable", { preHandler: admin }, async (req) => {
    const row = await registry.setEnabled(idParam(req), false);
    await core.syncUpstreams();
    return { server: serverView(row, manager.snapshot(row.id), true) };
  });

  app.delete("/api/servers/:id", { preHandler: admin }, async (req) => {
    const id = idParam(req);
    await notStoreManaged(id);
    await registry.delete(id);
    manager.remove(id); // closes the client and drops the cached tools now
    return { ok: true };
  });

  app.post("/api/servers/:id/refresh", { preHandler: admin }, async (req) => {
    const row = await registry.get(idParam(req));
    await core.syncUpstreams();
    if (row.enabled) await withTimeout(manager.check(row.id), 8_000);
    return { server: serverView(row, manager.snapshot(row.id), true) };
  });

  // Members may read tool names too; `allowed` says whether their role can call each one.
  app.get("/api/servers/:id/tools", { preHandler: session }, async (req) => {
    const me = currentUser(req);
    const row = await registry.get(idParam(req));
    await freshRows();
    const policy = await core.loadPolicy();
    const tools = row.enabled ? manager.cachedTools(row.id) : [];
    return { tools: tools.map((t) => toolView(t, { allowed: policy.isAllowed(me.role, t.exposedName) })) };
  });

  // The aggregated, permission-filtered list: exactly what this user's MCP client sees.
  app.get("/api/tools", { preHandler: session }, async (req) => {
    const tools = await core.listTools(currentUser(req).role);
    return { tools: tools.map((t) => toolView(t)) };
  });
}
