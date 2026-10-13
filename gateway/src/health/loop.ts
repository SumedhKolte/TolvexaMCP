import type { FastifyBaseLogger } from "fastify";
import { purgeOldLoginFailures } from "../auth/rate-limit.js";
import { purgeExpiredSessions } from "../auth/sessions.js";
import type { Core } from "../core.js";

/**
 * Every HEALTH_INTERVAL_MS (30 s): re-sync the registry, then health-check every enabled
 * upstream (initialize if needed + tools/list, 3 s timeout) IN PARALLEL, so one slow
 * server doesn't delay the others. Upstreams in backoff are retried by their own timers.
 * Also purges expired sessions and old login failures.
 * A tick is skipped if the previous one is still running.
 */
export function startHealthLoop(core: Core, log: FastifyBaseLogger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await core.syncUpstreams();
      await core.manager.checkAll();
      await purgeExpiredSessions(core.db);
      await purgeOldLoginFailures(core.db, core.config.LOGIN_WINDOW_MINUTES);
    } catch (err) {
      log.warn({ err }, "health tick failed");
    } finally {
      running = false;
    }
  };
  void tick(); // first check right away, so status is known soon after startup
  const timer = setInterval(() => void tick(), core.config.HEALTH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
