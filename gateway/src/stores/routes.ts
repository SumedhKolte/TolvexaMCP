import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Core } from "../core.js";
import { parseBody } from "../http/errors.js";
import { currentUser, requireSession } from "../http/guards.js";
import { STORE_NAME_RE, type StoreService } from "./service.js";

/**
 *   GET    /api/stores        stores (admins: all; members: their own) + limits
 *   POST   /api/stores        {"name"}: 202, provisioning starts; the same name again is a
 *                             no-op (or restarts a failed store): retry-safe
 *   DELETE /api/stores/:id    owner or admin: 202, deletion starts
 */
const CreateBody = z.object({
  name: z
    .string()
    .trim()
    .regex(STORE_NAME_RE, "2-24 characters: lowercase letters, digits and dashes, starting with a letter"),
});
const id = (req: FastifyRequest) => parseBody(z.uuid(), (req.params as { id: string }).id);

export function storeRoutes(app: FastifyInstance, core: Core, service: StoreService): void {
  const session = requireSession(core);

  app.get("/api/stores", { preHandler: session }, async (req) => {
    const me = currentUser(req);
    return { stores: await service.list(me), limits: await service.limits(me) };
  });

  app.post("/api/stores", { preHandler: session }, async (req, reply) => {
    const me = currentUser(req);
    const { name } = parseBody(CreateBody, req.body);
    const { store, created } = await service.create(me, name);
    reply.code(created ? 202 : 200);
    return { store: service.view(store) };
  });

  app.delete("/api/stores/:id", { preHandler: session }, async (req, reply) => {
    const row = await service.requestDelete(currentUser(req), id(req));
    reply.code(202);
    return { store: service.view(row) };
  });
}
