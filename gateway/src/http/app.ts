import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../config/index.js";
import { Core } from "../core.js";
import type { Db } from "../db/client.js";
import { pseudonymKey } from "../chat/privacy.js";
import { GatewayMetrics } from "../metrics/index.js";
import { chatRoutes } from "../chat/route.js";
import { permissionRoutes } from "./routes/permissions.js";
import { parseEncryptionKey } from "../crypto/credentials.js";
import { HttpProvisionerClient, type ProvisionerClient } from "../stores/provisioner-client.js";
import { storeRoutes } from "../stores/routes.js";
import { StoreService } from "../stores/service.js";
import { OpenAiCompatibleModel, type ChatModel } from "../chat/model.js";
import { mcpRoutes } from "../mcp-server/handler.js";
import type { Registry } from "../registry/service.js";
import type { UpstreamManager } from "../upstream/manager.js";
import { HttpError } from "./errors.js";
import { auditAndHealthRoutes } from "./routes/audit-health.js";
import { authRoutes } from "./routes/auth.js";
import { keyAndUserRoutes } from "./routes/keys-users.js";
import { serverRoutes } from "./routes/servers.js";

export interface AppParts {
  db: Db;
  config: Config;
  registry: Registry;
  manager: UpstreamManager;
  logger?: boolean | object;
  /** Injected in tests; built from LLM_* config otherwise. */
  chatModel?: ChatModel | null;
  /** Injected in tests; built from PROVISIONER_* config otherwise (null = stores off). */
  provisioner?: ProvisionerClient | null;
  now?: () => Date;
}

/**
 * Chat needs a key for hosted providers; local endpoints (Ollama on localhost or a cluster
 * Service) need none. Without a usable configuration chat is turned off with a clear
 * reason instead of failing on every message.
 */
export function chatModelFromConfig(config: Config): { model: ChatModel | null; reason?: string } {
  const host = new URL(config.LLM_BASE_URL).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host.endsWith(".svc.cluster.local") || host.endsWith(".internal");
  if (!config.LLM_API_KEY && !local) {
    return { model: null, reason: "Chat is not configured yet: an admin needs to set LLM_API_KEY for the AI provider." };
  }
  return {
    model: new OpenAiCompatibleModel({ baseURL: config.LLM_BASE_URL, model: config.LLM_MODEL, apiKey: config.LLM_API_KEY, timeoutMs: config.LLM_TIMEOUT_MS,
      reasoningEffort: config.LLM_REASONING_EFFORT || undefined,
    }),
  };
}

/**
 * Builds the HTTP app (not listening). Used by index.ts and by the integration tests,
 * which pass a PGlite database and a fake upstream connector.
 */
export async function buildApp(parts: AppParts): Promise<{ app: FastifyInstance; core: Core; metrics: GatewayMetrics; stores: StoreService }> {
  const app = Fastify({
    logger: parts.logger ?? {
      level: parts.config.LOG_LEVEL,
      // Never log credentials: API keys, session cookies, upstream tokens.
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    // Client IP (for login rate limits) comes from X-Forwarded-For, trusting exactly as
    // many proxy hops as are really in front of us (ingress-nginx = 1), so a client
    // can't spoof its IP by sending the header itself.
    trustProxy: (_address: string, hop: number) => hop < parts.config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });
  await app.register(cookie);

  const core = new Core(parts.db, parts.config, parts.registry, parts.manager, app.log);
  const metrics = new GatewayMetrics({ upstreams: () => core.upstreamStates() });
  core.metrics = metrics;

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
  });

  // One error format everywhere: {"error":{"code","message"}}. Unknown errors are logged
  // with detail but answered generically (no stack traces to clients).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).headers(err.headers).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: "BAD_REQUEST", message: e.message ?? "Bad request" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } }));

  authRoutes(app, core);
  keyAndUserRoutes(app, core);
  serverRoutes(app, core);
  auditAndHealthRoutes(app, core);
  permissionRoutes(app, core);
  const { config } = parts;
  const provisioner =
    parts.provisioner !== undefined
      ? parts.provisioner
      : config.PROVISIONER_URL
        ? new HttpProvisionerClient(config.PROVISIONER_URL, config.PROVISIONER_TOKEN)
        : null;
  const stores = new StoreService(
    core,
    parseEncryptionKey(config.CREDENTIAL_ENC_KEY),
    provisioner,
    {
      maxPerUser: config.MAX_STORES_PER_USER,
      maxTotal: config.MAX_STORES_TOTAL,
      provisionTimeoutMs: config.STORE_PROVISION_TIMEOUT_MS,
      resyncMs: config.STORE_RESYNC_INTERVAL_MS,
      hostSuffix: config.STORE_HOST_SUFFIX,
      publicScheme: new URL(config.PUBLIC_BASE_URL).protocol.replace(":", ""),
    },
    app.log,
    parts.now,
  );
  storeRoutes(app, core, stores);
  mcpRoutes(app, core);
  const chat = parts.chatModel !== undefined ? { model: parts.chatModel } : chatModelFromConfig(parts.config);
  chatRoutes(app, core, {
    model: chat.model,
    unavailableReason: "reason" in chat ? chat.reason : undefined,
    maxIterations: parts.config.CHAT_MAX_ITERATIONS,
    maxResultBytes: parts.config.CHAT_MAX_RESULT_BYTES,
    pseudonymKey: parts.config.CHAT_PII_MASKING ? pseudonymKey(parts.config.SESSION_SECRET) : undefined,
  });

  return { app, core, metrics, stores };
}
