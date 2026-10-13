import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE, userForSession } from "../auth/sessions.js";
import type { UserRow } from "../auth/users.js";
import type { Core } from "../core.js";
import { forbidden, unauthorized } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireSession: the logged-in dashboard user. */
    user?: UserRow;
  }
}

/** Dashboard routes: valid, unexpired session cookie of a non-disabled user (checked in the DB every request). */
export function requireSession(core: Core) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await userForSession(core.db, token, core.config.SESSION_SECRET) : undefined;
    if (!user) throw unauthorized();
    req.user = user;
  };
}

export function requireAdmin(core: Core) {
  const session = requireSession(core);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await session(req, reply);
    if (req.user?.role !== "admin") throw forbidden("Admin only");
  };
}

/** Narrowing helper for handlers behind requireSession. */
export function currentUser(req: FastifyRequest): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}
