import type { FastifyBaseLogger } from "fastify";
import type { StoreService } from "./service.js";

/**
 * Every STORE_RECONCILE_INTERVAL_MS (5 s): move stores that are provisioning or deleting
 * one step forward. Several replicas can run this at once; per-store leases keep them from
 * working on the same store. A tick is skipped while the previous one is still running.
 */
export function startStoreLoop(stores: StoreService, intervalMs: number, log: FastifyBaseLogger): () => void {
  if (!stores.enabled) return () => undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await stores.reconcileOnce();
    } catch (err) {
      log.warn({ err }, "store reconcile tick failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
