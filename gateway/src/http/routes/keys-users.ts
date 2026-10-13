import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createApiKey, findApiKey, listApiKeys, revokeApiKey } from "../../auth/api-keys.js";
import {
  countOtherActiveAdmins,
  createUser,
  findUserById,
  listUsersWithKeyCounts,
  updateUser,
} from "../../auth/users.js";
import type { Core } from "../../core.js";
import { generatePassword } from "../../crypto/tokens.js";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, parseBody } from "../errors.js";
import { currentUser, requireAdmin, requireSession } from "../guards.js";
import { keyView, userView } from "../views.js";

const Uuid = z.uuid();
const CreateKeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  user_id: z.uuid().optional(),
});
const CreateUserBody = z.object({
  email: z.email().max(254),
  role: z.enum(["admin", "member"]),
  password: z.string().min(12).max(1024).optional(),
});
const PatchUserBody = z
  .object({ role: z.enum(["admin", "member"]).optional(), disabled: z.boolean().optional() })
  .refine((b) => b.role !== undefined || b.disabled !== undefined, "nothing to change");

export function keyAndUserRoutes(app: FastifyInstance, core: Core): void {
  const session = requireSession(core);
  const admin = requireAdmin(core);

  // ---------------- API keys: own keys for everyone; any user's keys for admins ----------------

  app.get("/api/keys", { preHandler: session }, async (req) => {
    const me = currentUser(req);
    const q = req.query as { userId?: string };
    let userId = me.id;
    if (q.userId && q.userId !== me.id) {
      if (me.role !== "admin") throw forbidden("Members can only list their own keys");
      userId = parseBody(Uuid, q.userId);
    }
    return { keys: (await listApiKeys(core.db, userId)).map(keyView) };
  });

  app.post("/api/keys", { preHandler: session }, async (req, reply) => {
    const me = currentUser(req);
    const body = parseBody(CreateKeyBody, req.body);
    const ownerId = body.user_id ?? me.id;
    if (ownerId !== me.id) {
      if (me.role !== "admin") throw forbidden("Members can only create keys for themselves");
      const owner = await findUserById(core.db, ownerId);
      if (!owner) throw notFound("User not found");
    }
    const { row, key } = await createApiKey(core.db, ownerId, body.name);
    reply.code(201);
    // The only time the full key is ever returned.
    return { key: keyView(row), secret: key };
  });

  app.delete("/api/keys/:id", { preHandler: session }, async (req) => {
    const me = currentUser(req);
    const id = parseBody(Uuid, (req.params as { id: string }).id);
    const key = await findApiKey(core.db, id);
    // Same 404 for "doesn't exist" and "not yours": members can't probe others' key ids.
    if (!key || (key.userId !== me.id && me.role !== "admin")) throw notFound("Key not found");
    await revokeApiKey(core.db, id);
    return { ok: true };
  });

  // ---------------- Users (admin only) ----------------

  app.get("/api/users", { preHandler: admin }, async () => {
    const users = await listUsersWithKeyCounts(core.db);
    return {
      users: users.map((u) => ({ id: u.id, email: u.email, role: u.role, disabled: u.disabled, created_at: u.createdAt, active_keys: u.activeKeys })),
    };
  });

  app.post("/api/users", { preHandler: admin }, async (req, reply) => {
    const body = parseBody(CreateUserBody, req.body);
    const password = body.password ?? generatePassword();
    try {
      const user = await createUser(core.db, { email: body.email, role: body.role, password });
      reply.code(201);
      // Returned once so the admin can hand it over; it's stored only as an argon2 hash.
      return { user: userView(user), initial_password: password };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("A user with this email already exists");
      throw err;
    }
  });

  app.patch("/api/users/:id", { preHandler: admin }, async (req) => {
    const me = currentUser(req);
    const id = parseBody(Uuid, (req.params as { id: string }).id);
    const body = parseBody(PatchUserBody, req.body);
    const target = await findUserById(core.db, id);
    if (!target) throw notFound("User not found");
    const losesAdmin = target.role === "admin" && (body.role === "member" || body.disabled === true);
    if (losesAdmin && (await countOtherActiveAdmins(core.db, id)) === 0) {
      throw badRequest("Can't remove the last active admin");
    }
    if (id === me.id && body.disabled) throw badRequest("You can't disable your own account");
    const updated = await updateUser(core.db, id, body);
    if (!updated) throw notFound("User not found");
    return { user: userView(updated) };
  });
}
