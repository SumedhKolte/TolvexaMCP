import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const csv = z
  .string()
  .default("")
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

/**
 * Every environment variable the gateway reads, validated once at startup. A missing or
 * malformed value stops the process immediately with a list of what's wrong (and never
 * echoes secret values). Secrets come from the gateway-secrets Secret; everything else
 * comes from chart values.
 */
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Prometheus /metrics listener; separate from PORT so the Ingress can never route to it. */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // --- secrets ---
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  CREDENTIAL_ENC_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "must be base64 of exactly 32 bytes"),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12, "must be at least 12 characters"),
  WOO_MCP_BEARER_TOKEN: z.string().min(16),
  LLM_API_KEY: z.string().default(""),

  // --- built-in upstream ---
  WOO_MCP_URL: z.url().default("http://woo-mcp.store.svc.cluster.local:8080/mcp"),

  // --- auth ---
  COOKIE_SECURE: bool,
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  /** Reverse proxies in front of the gateway (ingress-nginx = 1). Used for client IPs. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  // --- upstreams ---
  UPSTREAM_HOST_ALLOWLIST: csv,
  ALLOW_PUBLIC_UPSTREAMS: bool,
  HEALTH_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  DEFAULT_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  /** TCP connect timeout to upstreams (see HttpConnector): detects dead upstreams fast. */
  UPSTREAM_TCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  /** Members' access to tools that have no row in tool_permissions. */
  DEFAULT_MEMBER_TOOL_ACCESS: z.enum(["allow", "deny"]).default("allow"),

  // --- chat agent (any OpenAI-compatible endpoint: Groq, Gemini, Ollama, ...) ---
  LLM_BASE_URL: z.url().default("https://api.groq.com/openai/v1"),
  LLM_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** reasoning_effort for reasoning models; "" = don't send it (providers/models that reject it). */
  LLM_REASONING_EFFORT: z.enum(["", "low", "medium", "high"]).default(""),
  CHAT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(20).default(8),
  CHAT_MAX_RESULT_BYTES: z.coerce.number().int().min(512).default(8_192),
  /** Mask customer names, emails, phones and street addresses before they reach the LLM (D6.12). */
  CHAT_PII_MASKING: z.enum(["true", "false", "1", "0"]).default("true").transform((v) => v === "true" || v === "1"),

  // --- multi-store provisioning (bonus; off unless PROVISIONER_URL is set) ---
  PROVISIONER_URL: z.union([z.literal(""), z.url()]).default(""),
  /** Shared secret for gateway -> provisioner calls (from gateway-secrets). */
  PROVISIONER_TOKEN: z.string().default(""),
  /** Storefront host = "store-<name>" + this suffix (e.g. .localtest.me, .team.example.com). */
  STORE_HOST_SUFFIX: z.string().regex(/^\.[a-z0-9.-]+$/, "must start with a dot, e.g. .localtest.me").default(".localtest.me"),
  MAX_STORES_PER_USER: z.coerce.number().int().min(0).default(2),
  MAX_STORES_TOTAL: z.coerce.number().int().min(0).default(4),
  STORE_PROVISION_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(15 * 60_000),
  STORE_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  /** How often ready stores are re-checked (and upgraded if charts/values changed). */
  STORE_RESYNC_INTERVAL_MS: z.coerce.number().int().min(10_000).default(10 * 60_000),

  // --- public URL shown on the Connect page ---
  PUBLIC_BASE_URL: z.url().default("http://hub.localtest.me"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Paths and messages only: never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  if (parsed.data.PROVISIONER_URL && parsed.data.PROVISIONER_TOKEN.length < 32) {
    throw new Error("invalid configuration:\n  PROVISIONER_TOKEN: must be at least 32 characters when PROVISIONER_URL is set");
  }
  return parsed.data;
}
