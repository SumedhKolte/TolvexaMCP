import { loadConfig, type Config } from "./config/index.js";
import { parseEncryptionKey } from "./crypto/credentials.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations, withMigrationLock } from "./db/migrate.js";
import { seed } from "./db/seed.js";
import { startHealthLoop } from "./health/loop.js";
import { buildApp } from "./http/app.js";
import { startMetricsServer } from "./metrics/server.js";
import { startStoreLoop } from "./stores/loop.js";
import { Registry } from "./registry/service.js";
import { HttpConnector } from "./upstream/connector.js";
import { UpstreamManager } from "./upstream/manager.js";

function fatal(msg: string, error: string): never {
  // One JSON line, like pino, without a stack trace or any config values.
  process.stderr.write(`${JSON.stringify({ level: 60, time: Date.now(), msg, error })}\n`);
  process.exit(1);
}

async function main() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fatal("startup failed", (err as Error).message);
  }

  const encKey = parseEncryptionKey(config.CREDENTIAL_ENC_KEY);
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const ssrf = { allowlist: config.UPSTREAM_HOST_ALLOWLIST, allowPublic: config.ALLOW_PUBLIC_UPSTREAMS };

  const registry = new Registry(db, encKey, ssrf, config.DEFAULT_TOOL_TIMEOUT_MS);
  const manager = new UpstreamManager(new HttpConnector(ssrf, config.UPSTREAM_TCP_CONNECT_TIMEOUT_MS));
  const { app, core, metrics, stores } = await buildApp({ db, config, registry, manager });

  // Migrate + seed exactly once across replicas (advisory lock), before serving.
  try {
    const actions = await withMigrationLock(pool, async () => {
      await runMigrations(db);
      return seed(db, {
        adminEmail: config.ADMIN_EMAIL,
        adminPassword: config.ADMIN_PASSWORD,
        wooMcpUrl: config.WOO_MCP_URL,
        wooMcpToken: config.WOO_MCP_BEARER_TOKEN,
        encKey,
      });
    });
    app.log.info({ actions }, "database migrated and seeded");
  } catch (err) {
    fatal("database migration/seed failed", (err as Error).message);
  }

  const stopHealth = startHealthLoop(core, app.log);
  const stopStores = startStoreLoop(stores, config.STORE_RECONCILE_INTERVAL_MS, app.log);
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  const metricsServer = await startMetricsServer(metrics, config.METRICS_PORT, "0.0.0.0", (err) => app.log.error({ err }, "metrics render failed"));
  app.log.info({ port: config.METRICS_PORT }, "metrics listening");

  // Graceful shutdown on rollout: stop accepting, finish in-flight requests, close clients.
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      app.log.info({ signal: sig }, "shutting down");
      stopHealth();
      stopStores();
      setTimeout(() => process.exit(0), 10_000).unref();
      await app.close();
      metricsServer.close();
      await manager.close();
      await pool.end();
      process.exit(0);
    });
  }
}

void main();
