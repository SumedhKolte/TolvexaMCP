import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { secretReader } from "./secrets.js";
import { createApp } from "./server.js";
import { WooClient } from "./woo-client.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  // Fail fast with a readable reason (no stack trace) so the pod's log says what's wrong.
  log({ msg: "startup failed", error: (err as Error).message });
  process.exit(1);
}
const readSecret = secretReader(config.secretsDir);

const woo = new WooClient({
  baseUrl: config.wcBaseUrl,
  signatureBaseUrl: config.wcSignatureBaseUrl,
  timeoutMs: config.wcTimeoutMs,
  credentials: async () => {
    const [consumerKey, consumerSecret] = await Promise.all([
      readSecret("WC_CONSUMER_KEY"),
      readSecret("WC_CONSUMER_SECRET"),
    ]);
    return consumerKey && consumerSecret ? { consumerKey, consumerSecret } : undefined;
  },
});

const app = createApp({ woo, getBearerToken: () => readSecret("WOO_MCP_BEARER_TOKEN") });

const server = app.listen(config.port, () => {
  log({ msg: "listening", port: config.port, wc_base_url: config.wcBaseUrl, secrets: config.secretsDir ? "files" : "env" });
});

// Kubernetes sends SIGTERM on rollout: stop accepting, let in-flight requests finish.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log({ msg: "shutting down", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
