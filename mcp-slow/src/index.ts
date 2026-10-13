import { z } from "zod";
import { tokenReader } from "./auth.js";
import { createMcpApp } from "./http.js";
import { log } from "./log.js";
import { abortableSleep, registerSlowTools } from "./tools.js";

const bool = z.enum(["true", "false", "1", "0", ""]).default("false").transform((v) => v === "true" || v === "1");

const parsed = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    SECRETS_DIR: z.string().min(1).optional(),
    ECHO_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(15_000),
    FLAKY_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.5),
    /** Registers the crash tool. Off unless explicitly enabled (it's set in the chart values). */
    ALLOW_CRASH: bool,
    /**
     * Wait this long before listening, like a slow-booting service. Makes a restart
     * visible: while it boots, the pod isn't Ready, so the gateway sees it as unreachable.
     */
    STARTUP_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(0),
  })
  .safeParse(process.env);
if (!parsed.success) {
  log({ msg: "startup failed", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  process.exit(1);
}
const env = parsed.data;

const app = createMcpApp({
  serverInfo: { name: "mcp-slow", version: "0.1.0" },
  registerTools: (server, ctx) =>
    registerSlowTools(server, { echoDelayMs: env.ECHO_DELAY_MS, flakyFailureRate: env.FLAKY_FAILURE_RATE, allowCrash: env.ALLOW_CRASH }, ctx),
  getBearerToken: tokenReader(env.SECRETS_DIR),
  log,
});

log({ msg: "booting", startup_delay_ms: env.STARTUP_DELAY_MS, allow_crash: env.ALLOW_CRASH, echo_delay_ms: env.ECHO_DELAY_MS });
await abortableSleep(env.STARTUP_DELAY_MS);
const server = app.listen(env.PORT, () => log({ msg: "listening", port: env.PORT }));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log({ msg: "shutting down", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
