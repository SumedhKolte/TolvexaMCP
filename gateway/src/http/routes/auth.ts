import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { burnPasswordCheck, verifyPassword } from "../../auth/passwords.js";
import { clearLoginFailures, isLoginBlocked, loginKeys, recordLoginFailure } from "../../auth/rate-limit.js";
import { createSession, deleteSession, SESSION_COOKIE } from "../../auth/sessions.js";
import { findUserByEmail, normalizeEmail } from "../../auth/users.js";
import type { Core } from "../../core.js";
import { HttpError, parseBody } from "../errors.js";
import { currentUser, requireSession } from "../guards.js";
import { userView } from "../views.js";

const LoginBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export function authRoutes(app: FastifyInstance, core: Core): void {
  const cfg = core.config;
  const limits = { max: cfg.LOGIN_MAX_FAILURES, windowMinutes: cfg.LOGIN_WINDOW_MINUTES };

  app.post("/api/auth/login", async (req, reply) => {
    const body = parseBody(LoginBody, req.body);
    const email = normalizeEmail(body.email);
    const keys = loginKeys(req.ip, email);

    if (await isLoginBlocked(core.db, keys, limits)) {
      throw new HttpError(429, "RATE_LIMITED", "Too many failed logins. Try again later.", {
        "retry-after": String(limits.windowMinutes * 60),
      });
    }

    const user = await findUserByEmail(core.db, email);
    const valid = user ? await verifyPassword(user.passwordHash, body.password) : (await burnPasswordCheck(body.password), false);
    if (!user || !valid) {
      await recordLoginFailure(core.db, keys);
      // Same message for "no such user" and "wrong password": no account enumeration.
      throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    if (user.disabledAt) throw new HttpError(403, "USER_DISABLED", "This account is disabled");

    await clearLoginFailures(core.db, `email:${email}`);
    const { token, expiresAt } = await createSession(core.db, user.id, cfg.SESSION_TTL_HOURS, cfg.SESSION_SECRET);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, // not readable by page scripts
      sameSite: "lax", // not sent on cross-site POSTs (CSRF)
      secure: cfg.COOKIE_SECURE, // true in prod (https)
      path: "/",
      expires: expiresAt,
    });
    return { user: userView(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(core.db, token, cfg.SESSION_SECRET);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireSession(core) }, async (req) => ({ user: userView(currentUser(req)) }));
}
