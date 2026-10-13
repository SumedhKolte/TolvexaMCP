import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres bytea <-> Buffer (node-postgres returns Buffer, PGlite returns Uint8Array). */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (v) => Buffer.from(v),
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercased; unique. */
    email: text("email").notNull().unique(),
    /** argon2id. */
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [check("users_role_check", sql`${t.role} in ('admin', 'member')`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** HMAC-SHA256(SESSION_SECRET, cookie token), hex. The token itself is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId), index("sessions_expires_at_idx").on(t.expiresAt)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** 8 random chars, in clear, used to find the row. */
    prefix: text("prefix").notNull().unique(),
    /** SHA-256 hex of the full key. */
    keyHash: text("key_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_user_id_idx").on(t.userId)],
);

export const upstreams = pgTable(
  "upstreams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull().unique(),
    url: text("url").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    credType: text("cred_type", { enum: ["none", "header", "bearer"] }).notNull().default("none"),
    credHeaderName: text("cred_header_name"),
    /** AES-256-GCM ciphertext || auth tag (crypto/credentials.ts). */
    credEncrypted: bytea("cred_encrypted"),
    credNonce: bytea("cred_nonce"),
    /** Per-upstream tool call timeout (spec: default 10 s, configurable). */
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    /** Seeded by the gateway (the WooCommerce server); shown with a "built-in" label. */
    builtin: boolean("builtin").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("upstreams_slug_check", sql`${t.slug} ~ '^[a-z0-9-]{2,30}$'`),
    check("upstreams_cred_type_check", sql`${t.credType} in ('none', 'header', 'bearer')`),
    check("upstreams_timeout_check", sql`${t.timeoutMs} between 100 and 300000`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: ts("ts").notNull().defaultNow(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    source: text("source", { enum: ["mcp", "chat"] }).notNull(),
    serverSlug: text("server_slug"),
    tool: text("tool"),
    argsSummary: text("args_summary"),
    durationMs: integer("duration_ms").notNull(),
    outcome: text("outcome", { enum: ["ok", "error", "denied", "timeout", "unreachable", "disabled"] }).notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (t) => [
    index("audit_log_ts_idx").on(t.ts),
    index("audit_log_user_id_idx").on(t.userId),
    index("audit_log_server_slug_idx").on(t.serverSlug),
    check("audit_log_source_check", sql`${t.source} in ('mcp', 'chat')`),
    check(
      "audit_log_outcome_check",
      sql`${t.outcome} in ('ok', 'error', 'denied', 'timeout', 'unreachable', 'disabled')`,
    ),
  ],
);

/** Stand-out A: exposed tool name -> roles allowed to call it (router/permissions.ts). */
export const toolPermissions = pgTable("tool_permissions", {
  toolName: text("tool_name").primaryKey(),
  allowedRoles: text("allowed_roles").array().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Failed logins, for rate limiting across replicas (an in-memory counter would let an
 * attacker spread attempts over gateway replicas). key = "ip:<addr>" or "email:<addr>".
 */
export const loginFailures = pgTable(
  "login_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: text("key").notNull(),
    ts: ts("ts").notNull().defaultNow(),
  },
  (t) => [index("login_failures_key_ts_idx").on(t.key, t.ts)],
);

/**
 * Provisioned WooCommerce stores (bonus: multi-store). One row per store; the gateway's
 * reconciler drives it through provisioning -> ready (or failed), and deleting -> gone,
 * by calling the provisioner service. See docs/design.md D10.x.
 */
export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "store-<name>": also the namespace, the upstream slug and the tool prefix. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Public storefront host, e.g. store-a.localtest.me. */
    host: text("host").notNull(),
    status: text("status", { enum: ["provisioning", "ready", "failed", "deleting"] }).notNull(),
    /** Last progress note or failure reason, shown in the dashboard. */
    statusReason: text("status_reason"),
    /** woo-mcp bearer token for this store, AES-256-GCM (AAD "store:<id>"). */
    tokenEncrypted: bytea("token_encrypted").notNull(),
    /** Set once the store's woo-mcp is registered as an upstream. */
    upstreamId: uuid("upstream_id").references(() => upstreams.id, { onDelete: "set null" }),
    /** Provisioning fails with a reason after this time. */
    deadlineAt: ts("deadline_at").notNull(),
    /** Reconciler lease: only the replica holding it works on this store. */
    leaseUntil: ts("lease_until"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("stores_status_check", sql`${t.status} in ('provisioning', 'ready', 'failed', 'deleting')`),
    index("stores_owner_idx").on(t.ownerId),
  ],
);
