import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import type { Db } from "../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { seed } from "../src/db/seed.js";
import type { ChatModel, ModelTurn } from "../src/chat/model.js";
import { buildApp } from "../src/http/app.js";
import type { GatewayMetrics } from "../src/metrics/index.js";
import { startMetricsServer } from "../src/metrics/server.js";
import { ProvisionerError, type ProvisionerClient, type ProvisionStatus } from "../src/stores/provisioner-client.js";
import type { StoreService } from "../src/stores/service.js";
import { Registry } from "../src/registry/service.js";
import { UpstreamManager, type Connector } from "../src/upstream/manager.js";
import { UpstreamTransportError } from "../src/upstream/types.js";

/**
 * Integration tests: real Fastify app, real migrations on PGlite (in-process Postgres),
 * real MCP SDK clients against /mcp. Only the upstream MCP servers are faked.
 */

const ADMIN = { email: "admin@test.local", password: "admin-password-123" };
const WOO_TOKEN = "woo-token-0123456789abcdef";
const NOTES_TOKEN = "notes-secret-token-xyz";

const t = (name: string): Tool => ({ name, description: `${name} tool`, inputSchema: { type: "object" } });
const upstreamTools: Record<string, Tool[]> = {
  woocommerce: ["list_products", "create_product", "list_orders", "get_order", "update_order_status"].map(t),
  notes: ["create_note", "list_notes", "search_notes"].map(t),
};
const up: Record<string, boolean> = { woocommerce: true, notes: true };
// Provisioned stores expose the same five WooCommerce tools under their own slug.
for (const slug of ["store-alpha", "store-beta", "store-gamma", "store-delta"]) {
  upstreamTools[slug] = upstreamTools.woocommerce as Tool[];
  up[slug] = true;
}

/** Scripted provisioner: each slug answers from its queue, then "installing" / "deleting". */
const provisioner: ProvisionerClient & {
  ensureScript: Map<string, ProvisionStatus[]>;
  removeScript: Map<string, ProvisionStatus[]>;
  calls: string[];
  down: boolean;
} = {
  ensureScript: new Map<string, ProvisionStatus[]>(),
  removeScript: new Map<string, ProvisionStatus[]>(),
  calls: [] as string[],
  down: false,
  async ensure(slug: string, req: { host: string; wooMcpToken: string; attemptBudget: string }): Promise<ProvisionStatus> {
    this.calls.push(`ensure ${slug} ${req.host} token=${req.wooMcpToken.length}`);
    if (this.down) throw new ProvisionerError("provisioner unreachable (connection failed)");
    return this.ensureScript.get(slug)?.shift() ?? { phase: "installing", detail: "Installing WordPress and WooCommerce" };
  },
  async remove(slug: string): Promise<ProvisionStatus> {
    this.calls.push(`remove ${slug}`);
    return this.removeScript.get(slug)?.shift() ?? { phase: "gone", detail: "" };
  },
};
let clock = Date.now();
const seenHeaders: Record<string, Record<string, string>> = {};

const connector: Connector = {
  async connect(cfg) {
    if (!up[cfg.slug]) throw new UpstreamTransportError(`connect ECONNREFUSED (${cfg.slug})`);
    seenHeaders[cfg.slug] = cfg.credType === "bearer" ? { authorization: `Bearer ${cfg.credential}` } : {};
    return {
      listTools: async () => {
        if (!up[cfg.slug]) throw new UpstreamTransportError("fetch failed");
        return upstreamTools[cfg.slug] ?? [];
      },
      callTool: async (name, args) => {
        if (!up[cfg.slug]) throw new UpstreamTransportError("fetch failed");
        if (name === "get_order" && args.id === 9999) return { isError: true, content: [{ type: "text", text: "Order 9999 not found" }] };
        return { content: [{ type: "text", text: JSON.stringify({ upstream: cfg.slug, tool: name, args }) }] };
      },
      close: async () => undefined,
    };
  },
};

/** Scripted LLM for the chat tests: each test pushes the turns it wants. */
const chatTurns: ModelTurn[] = [];
const fakeChatModel: ChatModel = {
  async complete(_messages, _tools, { onText }) {
    const t = chatTurns.shift() ?? { text: "No more scripted turns.", toolCalls: [] };
    if (t.text) onText(t.text);
    return t;
  },
};

async function chat(cookie: string, content: string) {
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
  const raw = await r.text();
  const events = raw
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "{}"));
  return { status: r.status, contentType: r.headers.get("content-type"), events };
}

let pg: PGlite;
let db: Db;
let app: FastifyInstance;
let metrics: GatewayMetrics;
let storeService: StoreService;
let base: string;
let ipCounter = 1;
/** Each login comes from its own fake client IP unless one is given, so per-IP limits don't interfere. */
const nextIp = () => `198.51.100.${ipCounter++}`;

async function login(email: string, password: string, ip = nextIp()) {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress: ip });
  const raw = r.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0] ?? "";
  return { status: r.statusCode, cookie, body: r.json() };
}

const api = (cookie: string) => ({
  get: (url: string) => app.inject({ method: "GET", url, headers: { cookie } }),
  post: (url: string, payload?: object) => app.inject({ method: "POST", url, headers: { cookie }, payload: payload ?? {} }),
  patch: (url: string, payload: object) => app.inject({ method: "PATCH", url, headers: { cookie }, payload }),
  put: (url: string, payload: object) => app.inject({ method: "PUT", url, headers: { cookie }, payload }),
  del: (url: string) => app.inject({ method: "DELETE", url, headers: { cookie } }),
});

async function mcp(key: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const rawMcp = (key: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

let adminCookie = "";
let memberCookie = "";
let memberId = "";
let memberKey = "";
let memberKeyId = "";

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema }) as unknown as Db;
  await migrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  const encKey = randomBytes(32);
  const config = loadConfig({
    DATABASE_URL: "postgres://unused",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    CREDENTIAL_ENC_KEY: encKey.toString("base64"),
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    WOO_MCP_BEARER_TOKEN: WOO_TOKEN,
  });
  await seed(db, { adminEmail: ADMIN.email, adminPassword: ADMIN.password, wooMcpUrl: config.WOO_MCP_URL, wooMcpToken: WOO_TOKEN, encKey });
  const ssrf = { allowlist: [], allowPublic: false };
  const registry = new Registry(db, encKey, ssrf, 10_000, async () => ["10.96.0.50"]);
  const manager = new UpstreamManager(connector);
  ({ app, metrics, stores: storeService } = await buildApp({ db, config, registry, manager, logger: false, chatModel: fakeChatModel, provisioner, now: () => new Date(clock) }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  adminCookie = (await login(ADMIN.email, ADMIN.password)).cookie;
});

afterAll(async () => {
  await app.close();
  await pg.close();
});

describe("seeding", () => {
  it("created the admin, the encrypted built-in woocommerce upstream, and default permissions; is idempotent", async () => {
    const [woo] = await db.select().from(schema.upstreams).where(eq(schema.upstreams.slug, "woocommerce"));
    expect(woo).toMatchObject({ builtin: true, enabled: true, credType: "bearer" });
    expect(woo?.credEncrypted?.toString("utf8")).not.toContain(WOO_TOKEN);
    const perms = await db.select().from(schema.toolPermissions);
    expect(perms.length).toBeGreaterThanOrEqual(6);
    const again = await seed(db, { adminEmail: ADMIN.email, adminPassword: "different-password", wooMcpUrl: woo?.url ?? "", wooMcpToken: WOO_TOKEN, encKey: randomBytes(32) });
    // A new key can't decrypt the old credential, so it's re-encrypted; nothing else changes.
    expect(again).toEqual(["updated built-in woocommerce url/credential from deployment config"]);
    expect((await db.select().from(schema.users)).length).toBe(1);
  });
});

describe("auth", () => {
  it("rejects bad credentials with one generic message, and accepts good ones with an httpOnly cookie", async () => {
    expect((await login(ADMIN.email, "wrong")).body.error.code).toBe("INVALID_CREDENTIALS");
    expect((await login("nobody@test.local", "wrong")).body.error.code).toBe("INVALID_CREDENTIALS");
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: ADMIN, remoteAddress: nextIp() });
    expect(r.statusCode).toBe(200);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rate-limits per email: 5 failures then 429, even from different IPs", async () => {
    await api(adminCookie).post("/api/users", { email: "victim@test.local", role: "member", password: "victim-password-1" });
    for (let i = 0; i < 5; i++) expect((await login("victim@test.local", `bad-${i}`)).status).toBe(401);
    const blocked = await login("victim@test.local", "victim-password-1");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
  });

  it("rate-limits per IP: one client spraying many accounts gets blocked", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 5; i++) await login(`spray${i}@test.local`, "x", ip);
    expect((await login(ADMIN.email, ADMIN.password, ip)).status).toBe(429);
  });

  it("logout ends the session", async () => {
    const s = await login(ADMIN.email, ADMIN.password);
    expect((await api(s.cookie).get("/api/me")).statusCode).toBe(200);
    await api(s.cookie).post("/api/auth/logout");
    expect((await api(s.cookie).get("/api/me")).statusCode).toBe(401);
  });

  it("answers errors as {error:{code,message}}", async () => {
    const r = await app.inject({ method: "GET", url: "/api/me" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
  });
});

describe("users and keys", () => {
  it("admin creates a member; the initial password is shown once and works", async () => {
    const r = await api(adminCookie).post("/api/users", { email: "Member@Test.local", role: "member" });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.user.email).toBe("member@test.local");
    expect(body.initial_password).toMatch(/^[A-Za-z0-9_-]{24}$/);
    memberId = body.user.id;
    const s = await login("member@test.local", body.initial_password);
    expect(s.status).toBe(200);
    memberCookie = s.cookie;
    expect((await api(memberCookie).get("/api/users")).statusCode).toBe(403); // admin only
  });

  it("member creates their own key; the full key is returned once and never stored", async () => {
    const r = await api(memberCookie).post("/api/keys", { name: "cursor" });
    expect(r.statusCode).toBe(201);
    memberKey = r.json().secret;
    memberKeyId = r.json().key.id;
    expect(memberKey).toMatch(/^wk_[a-z0-9]{8}_/);
    const list = (await api(memberCookie).get("/api/keys")).body;
    expect(list).not.toContain(memberKey);
    expect(list).not.toContain("key_hash");
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, memberKeyId));
    expect(row?.keyHash).not.toBe(memberKey);
  });

  it("member can't list or create keys for another user; admin can", async () => {
    const adminMe = (await api(adminCookie).get("/api/me")).json().user;
    expect((await api(memberCookie).get(`/api/keys?userId=${adminMe.id}`)).statusCode).toBe(403);
    expect((await api(memberCookie).post("/api/keys", { name: "x", user_id: adminMe.id })).statusCode).toBe(403);
    expect((await api(adminCookie).get(`/api/keys?userId=${memberId}`)).json().keys).toHaveLength(1);
  });

  it("refuses to remove the last admin", async () => {
    const adminMe = (await api(adminCookie).get("/api/me")).json().user;
    const r = await api(adminCookie).patch(`/api/users/${adminMe.id}`, { role: "member" });
    expect(r.statusCode).toBe(400);
  });
});

describe("registry", () => {
  it("lists the built-in WooCommerce server first, connected, with credential_set and no secret", async () => {
    const r = await api(adminCookie).get("/api/servers");
    const [first] = r.json().servers;
    expect(first).toMatchObject({ slug: "woocommerce", builtin: true, status: "connected", credential_set: true, tool_count: 5 });
    expect(r.body).not.toContain(WOO_TOKEN);
  });

  it("rejects SSRF-unsafe URLs", async () => {
    for (const url of ["http://127.0.0.1:8080/mcp", "http://169.254.169.254/", "http://localhost/mcp", "file:///etc/passwd"]) {
      const r = await api(adminCookie).post("/api/servers", { name: `bad ${url.length}`, url });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error.message).toMatch(/^url: /);
    }
  });

  it("registers notes (bearer), test-connects, encrypts the credential, and never returns it", async () => {
    const r = await api(adminCookie).post("/api/servers", {
      name: "Notes",
      url: "http://mcp-notes.upstreams.svc.cluster.local:8080/mcp",
      cred_type: "bearer",
      credential: NOTES_TOKEN,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().server).toMatchObject({ slug: "notes", status: "connected", credential_set: true, tool_count: 3 });
    expect(r.body).not.toContain(NOTES_TOKEN);
    // The gateway (and only the gateway) sends the credential upstream.
    expect(seenHeaders.notes).toEqual({ authorization: `Bearer ${NOTES_TOKEN}` });
  });

  it("registers an unreachable server anyway, shown as unreachable", async () => {
    up.ghost = false;
    const r = await api(adminCookie).post("/api/servers", { name: "Ghost", url: "http://ghost.upstreams.svc.cluster.local/mcp" });
    expect(r.statusCode).toBe(201);
    expect(r.json().server).toMatchObject({ slug: "ghost", status: "unreachable" });
    expect(r.json().server.last_error).toMatch(/ECONNREFUSED/);
  });

  it("keeps the credential when an edit leaves it blank", async () => {
    const notes = (await api(adminCookie).get("/api/servers")).json().servers.find((s: { slug: string }) => s.slug === "notes");
    const r = await api(adminCookie).patch(`/api/servers/${notes.id}`, { name: "Notes (team)", credential: "" });
    expect(r.json().server).toMatchObject({ name: "Notes (team)", credential_set: true, status: "connected" });
    expect(seenHeaders.notes).toEqual({ authorization: `Bearer ${NOTES_TOKEN}` });
  });

  it("hides URLs and credential settings from members", async () => {
    const r = await api(memberCookie).get("/api/servers");
    expect(r.statusCode).toBe(200);
    expect(r.json().servers[0]).not.toHaveProperty("url");
    expect((await api(memberCookie).post("/api/servers", { name: "x", url: "http://x.y.svc.cluster.local" })).statusCode).toBe(403);
  });
});

describe("/mcp endpoint (member key)", () => {
  it("lists tools from every enabled server, hiding restricted ones", async () => {
    const c = await mcp(memberKey);
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["woocommerce__list_orders", "woocommerce__get_order", "notes__create_note"]));
    expect(names).not.toContain("woocommerce__update_order_status");
    expect(names).not.toContain("woocommerce__create_product");
    await c.close();
  });

  it("rejects a restricted tool called directly with FORBIDDEN, and runs allowed tools", async () => {
    const c = await mcp(memberKey);
    const denied = await c.callTool({ name: "woocommerce__update_order_status", arguments: { id: 1, status: "completed" } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^\[FORBIDDEN\]/);
    const ok = await c.callTool({ name: "woocommerce__list_orders", arguments: { status: "processing" } });
    expect(JSON.parse(textOf(ok))).toMatchObject({ upstream: "woocommerce", tool: "list_orders" });
    const notFound = await c.callTool({ name: "woocommerce__get_order", arguments: { id: 9999 } });
    expect(textOf(notFound)).toBe("Order 9999 not found");
    const unknown = await c.callTool({ name: "nope__x", arguments: {} });
    expect(textOf(unknown)).toMatch(/^\[TOOL_NOT_FOUND\]/);
    await c.close();
  });

  it("fails fast with SERVER_UNREACHABLE when an upstream is down", async () => {
    up.notes = false;
    const notes = (await api(adminCookie).get("/api/servers")).json().servers.find((s: { slug: string }) => s.slug === "notes");
    await api(adminCookie).post(`/api/servers/${notes.id}/refresh`);
    const c = await mcp(memberKey);
    const started = Date.now();
    const r = await c.callTool({ name: "notes__list_notes", arguments: {} });
    expect(textOf(r)).toBe("[SERVER_UNREACHABLE] notes is not reachable right now.");
    expect(Date.now() - started).toBeLessThan(500);
    up.notes = true;
    await api(adminCookie).post(`/api/servers/${notes.id}/refresh`);
    await c.close();
  });

  it("disabling a server removes its tools from listings and calls return SERVER_DISABLED", async () => {
    const notes = (await api(adminCookie).get("/api/servers")).json().servers.find((s: { slug: string }) => s.slug === "notes");
    await api(adminCookie).post(`/api/servers/${notes.id}/disable`);
    const toolNames = (await api(memberCookie).get("/api/tools")).json().tools.map((x: { name: string }) => x.name);
    expect(toolNames.some((n: string) => n.startsWith("notes__"))).toBe(false);
    const c = await mcp(memberKey);
    expect((await c.listTools()).tools.some((x) => x.name.startsWith("notes__"))).toBe(false);
    expect(textOf(await c.callTool({ name: "notes__list_notes", arguments: {} }))).toMatch(/^\[SERVER_DISABLED\]/);
    await c.close();
    await api(adminCookie).post(`/api/servers/${notes.id}/enable`);
  });

  it("deleting a server removes its tools immediately", async () => {
    const ghost = (await api(adminCookie).get("/api/servers")).json().servers.find((s: { slug: string }) => s.slug === "ghost");
    expect((await api(adminCookie).del(`/api/servers/${ghost.id}`)).statusCode).toBe(200);
    const slugs = (await api(adminCookie).get("/api/servers")).json().servers.map((s: { slug: string }) => s.slug);
    expect(slugs).not.toContain("ghost");
  });

  it("writes audit rows for every call, attributed to user, key, and source", async () => {
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, memberId));
    const outcomes = new Set(rows.map((r) => r.outcome));
    expect(outcomes).toEqual(new Set(["ok", "error", "denied", "unreachable", "disabled"]));
    expect(rows.every((r) => r.source === "mcp" && r.apiKeyId === memberKeyId)).toBe(true);
  });

  it("members see only their own audit entries; admins see all; cursor pagination works", async () => {
    const own = (await api(memberCookie).get(`/api/audit?limit=200`)).json();
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every((i: { userId: string }) => i.userId === memberId)).toBe(true);
    const adminMe = (await api(adminCookie).get("/api/me")).json().user;
    const spoof = (await api(memberCookie).get(`/api/audit?userId=${adminMe.id}`)).json();
    expect(spoof.items.every((i: { userId: string }) => i.userId === memberId)).toBe(true);
    const p1 = (await api(adminCookie).get("/api/audit?limit=2")).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await api(adminCookie).get(`/api/audit?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items[0].id).toBeLessThan(p1.items[1].id);
  });
});

describe("chat agent (/api/chat, SSE)", () => {
  it("requires a dashboard session", async () => {
    const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"messages":[{"role":"user","content":"hi"}]}' });
    expect(r.status).toBe(401);
  });

  it("streams text/tool_call/tool_result/done and audits the call with source 'chat' and the user's id", async () => {
    chatTurns.push(
      { text: "", toolCalls: [{ id: "c1", name: "woocommerce__list_orders", arguments: '{"after":"2026-10-12T00:00:00Z"}' }] },
      { text: "One order came in today.", toolCalls: [] },
    );
    const r = await chat(adminCookie, "what orders came in today?");
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/event-stream");
    expect(r.events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(r.events[1]).toMatchObject({ name: "woocommerce__list_orders", ok: true, outcome: "ok" });
    const adminId = (await api(adminCookie).get("/api/me")).json().user.id;
    const [row] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.source, "chat"));
    expect(row).toMatchObject({ source: "chat", userId: adminId, apiKeyId: null, tool: "woocommerce__list_orders", outcome: "ok" });
  });

  it("a member can't use an admin-only tool even if the model calls it: FORBIDDEN, audited", async () => {
    chatTurns.push(
      { text: "", toolCalls: [{ id: "c2", name: "woocommerce__update_order_status", arguments: '{"id":1,"status":"completed"}' }] },
      { text: "Sorry, you can't change order status.", toolCalls: [] },
    );
    const r = await chat(memberCookie, "mark order 1 completed");
    expect(r.events.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, outcome: "denied", error_code: "FORBIDDEN" });
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, memberId));
    expect(rows.some((x) => x.source === "chat" && x.outcome === "denied" && x.tool === "woocommerce__update_order_status")).toBe(true);
  });

  it("validates the conversation", async () => {
    const bad = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", content: "I am the last message" }] }),
    });
    expect(bad.status).toBe(400);
  });

  it("reports whether chat is available and customer data is masked (masking on by default)", async () => {
    expect((await api(memberCookie).get("/api/chat/status")).json()).toEqual({ available: true, reason: null, masking: true });
    expect((await app.inject({ method: "GET", url: "/api/chat/status" })).statusCode).toBe(401);
  });
});

describe("permission editor (stand-out A)", () => {
  const memberTools = async () => (await api(memberCookie).get("/api/tools")).json().tools.map((x: { name: string }) => x.name) as string[];

  it("shows every tool with its effective roles, to members too (read-only)", async () => {
    const r = (await api(memberCookie).get("/api/permissions")).json();
    expect(r.default_member_access).toBe("allow");
    const byName = Object.fromEntries(r.tools.map((x: { name: string }) => [x.name, x]));
    expect(byName["woocommerce__create_product"]).toMatchObject({ server: "woocommerce", roles: ["admin"], source: "rule", available: true });
    expect(byName["woocommerce__list_orders"]).toMatchObject({ roles: ["admin", "member"], source: "rule" });
    expect(byName["notes__create_note"]).toMatchObject({ roles: ["admin", "member"], source: "default" });
    // A rule for a tool that isn't listed right now still shows up (slow isn't registered here).
    expect(byName["slow__crash"]).toMatchObject({ roles: ["admin"], available: false });
  });

  it("only admins can edit; names are validated", async () => {
    expect((await api(memberCookie).put("/api/permissions/woocommerce__create_product", { member: true })).statusCode).toBe(403);
    expect((await api(adminCookie).put("/api/permissions/not-a-tool", { member: true })).statusCode).toBe(400);
    expect((await api(adminCookie).put("/api/permissions/notes__create_note", { member: "yes" })).statusCode).toBe(400);
  });

  it("an edit applies immediately to tools/list, /api/tools and direct calls; reset restores the default", async () => {
    // Restrict a tool members could use: hidden from both listings and rejected by name.
    expect((await api(adminCookie).put("/api/permissions/notes__create_note", { member: false })).json()).toMatchObject({ roles: ["admin"], source: "rule" });
    expect(await memberTools()).not.toContain("notes__create_note");
    const c = await mcp(memberKey);
    expect((await c.listTools()).tools.map((x) => x.name)).not.toContain("notes__create_note");
    expect(textOf(await c.callTool({ name: "notes__create_note", arguments: { title: "x", body: "y" } }))).toMatch(/^\[FORBIDDEN\]/);

    // Open an admin-only tool to members.
    await api(adminCookie).put("/api/permissions/woocommerce__create_product", { member: true });
    expect((await c.listTools()).tools.map((x) => x.name)).toContain("woocommerce__create_product");
    expect((await c.callTool({ name: "woocommerce__create_product", arguments: { name: "x", regular_price: "1" } })).isError).toBeFalsy();
    await c.close();

    // Put both back: a rule again for create_product, the default for create_note.
    await api(adminCookie).put("/api/permissions/woocommerce__create_product", { member: false });
    expect((await api(adminCookie).del("/api/permissions/notes__create_note")).json()).toMatchObject({ source: "default", roles: ["admin", "member"] });
    expect(await memberTools()).toContain("notes__create_note");
    expect(await memberTools()).not.toContain("woocommerce__create_product");
  });
});

describe("observability (stand-out B)", () => {
  it("audit stats: per-server calls, error rate and average latency; members get their own only", async () => {
    const all = (await api(adminCookie).get("/api/audit/stats")).json();
    expect(all).toMatchObject({ minutes: 60, scope: "all" });
    const woo = all.servers.find((x: { server: string }) => x.server === "woocommerce");
    expect(woo.calls).toBeGreaterThan(0);
    expect(woo.error_rate).toBeGreaterThanOrEqual(0);
    expect(woo.error_rate).toBeLessThanOrEqual(1);
    expect(typeof woo.avg_latency_ms).toBe("number");
    const notes = all.servers.find((x: { server: string }) => x.server === "notes");
    expect(notes.errors).toBeGreaterThan(0); // the SERVER_UNREACHABLE call above
    expect(notes.denied).toBeGreaterThan(0); // the FORBIDDEN and SERVER_DISABLED calls above

    const own = (await api(memberCookie).get("/api/audit/stats")).json();
    expect(own.scope).toBe("own");
    const ownTotal = own.servers.reduce((n: number, x: { calls: number }) => n + x.calls, 0);
    const memberRows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.userId, memberId));
    expect(ownTotal).toBe(memberRows.length);
    expect((await api(memberCookie).get("/api/audit/stats?minutes=1")).statusCode).toBe(400);
  });

  it("counts every dispatch() call by server/tool/outcome, errors by code, and upstream status", async () => {
    const { body } = await metrics.render();
    expect(body).toMatch(/mcp_gateway_tool_calls_total\{server="woocommerce",tool="woocommerce__list_orders",outcome="ok"\} [1-9]/);
    expect(body).toMatch(/mcp_gateway_tool_errors_total\{code="FORBIDDEN"\} [1-9]/);
    expect(body).toMatch(/mcp_gateway_tool_errors_total\{code="SERVER_UNREACHABLE"\} [1-9]/);
    expect(body).toMatch(/mcp_gateway_tool_call_duration_seconds_count\{server="woocommerce"\} [1-9]/);
    expect(body).toMatch(/mcp_gateway_upstream_up\{server="woocommerce"\} 1/);
    // Made-up names never become label values.
    expect(body).toMatch(/mcp_gateway_tool_calls_total\{server="\(unknown\)",tool="\(unknown\)",outcome="error"\}/);
    expect(body).not.toContain("nope__x");
  });

  it("serves /metrics on its own listener, and nothing else there; the API port has no /metrics", async () => {
    const server = await startMetricsServer(metrics, 0, "127.0.0.1");
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toContain("mcp_gateway_upstream_up");
    expect((await fetch(`http://127.0.0.1:${port}/api/me`)).status).toBe(404);
    server.close();
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
  });

  it("the upstream gauge drops to 0 when a server goes down", async () => {
    up.notes = false;
    const notes = (await api(adminCookie).get("/api/servers")).json().servers.find((s: { slug: string }) => s.slug === "notes");
    await api(adminCookie).post(`/api/servers/${notes.id}/refresh`);
    expect((await metrics.render()).body).toMatch(/mcp_gateway_upstream_up\{server="notes"\} 0/);
    up.notes = true;
    await api(adminCookie).post(`/api/servers/${notes.id}/refresh`);
    expect((await metrics.render()).body).toMatch(/mcp_gateway_upstream_up\{server="notes"\} 1/);
  });
});

describe("multi-store provisioning (bonus)", () => {
  const storeOf = async (cookie: string, slug: string) =>
    (await api(cookie).get("/api/stores")).json().stores.find((x: { slug: string }) => x.slug === slug);
  const toolsOf = async (cookie: string) => (await api(cookie).get("/api/tools")).json().tools.map((t: { name: string }) => t.name) as string[];

  it("validates names, creates a store (202) and is retry-safe: the same name returns the same store", async () => {
    expect((await api(adminCookie).post("/api/stores", { name: "Bad Name!" })).statusCode).toBe(400);
    expect((await api(adminCookie).post("/api/stores", { name: "x" })).statusCode).toBe(400);
    const first = await api(adminCookie).post("/api/stores", { name: "alpha" });
    expect(first.statusCode).toBe(202);
    expect(first.json().store).toMatchObject({ slug: "store-alpha", status: "provisioning", url: "http://store-alpha.localtest.me", tool_prefix: "store-alpha__" });
    const again = await api(adminCookie).post("/api/stores", { name: "alpha" });
    expect(again.statusCode).toBe(200);
    expect(again.json().store.id).toBe(first.json().store.id);
  });

  it("reconciles: installing -> ready, registers store-alpha's tools; write tools admin-only", async () => {
    provisioner.ensureScript.set("store-alpha", [{ phase: "installing", detail: "Installing WooCommerce" }, { phase: "ready", detail: "" }]);
    await storeService.reconcileOnce();
    expect(await storeOf(adminCookie, "store-alpha")).toMatchObject({ status: "provisioning", status_reason: "Installing WooCommerce" });
    // The provisioner got the public host and a 64-char token (never shown anywhere).
    expect(provisioner.calls).toContain("ensure store-alpha store-alpha.localtest.me token=64");
    await storeService.reconcileOnce();
    expect(await storeOf(adminCookie, "store-alpha")).toMatchObject({ status: "ready", status_reason: null });
    expect(await toolsOf(adminCookie)).toEqual(expect.arrayContaining(["store-alpha__list_orders", "store-alpha__create_product"]));
    const memberTools = await toolsOf(memberCookie);
    expect(memberTools).toContain("store-alpha__list_orders");
    expect(memberTools).not.toContain("store-alpha__create_product");
    expect(memberTools).not.toContain("store-alpha__update_order_status");
    // Calls go through dispatch() like any server's.
    const c = await mcp(memberKey);
    expect(JSON.parse(textOf(await c.callTool({ name: "store-alpha__list_orders", arguments: {} })))).toMatchObject({ upstream: "store-alpha", tool: "list_orders" });
    expect(textOf(await c.callTool({ name: "store-alpha__create_product", arguments: { name: "x", regular_price: "1" } }))).toMatch(/^\[FORBIDDEN\]/);
    await c.close();
  });

  it("store servers are managed only from the Stores page", async () => {
    const created = await api(adminCookie).post("/api/servers", { name: "Sneaky", slug: "store-sneaky", url: "http://x.default.svc.cluster.local/mcp" });
    expect(created.statusCode).toBe(400);
    const server = (await api(adminCookie).get("/api/servers")).json().servers.find((x: { slug: string }) => x.slug === "store-alpha");
    expect((await api(adminCookie).del(`/api/servers/${server.id}`)).statusCode).toBe(409);
    expect((await api(adminCookie).patch(`/api/servers/${server.id}`, { name: "Renamed" })).statusCode).toBe(409);
  });

  it("enforces the per-user limit; members see and delete only their own stores", async () => {
    expect((await api(memberCookie).post("/api/stores", { name: "beta" })).statusCode).toBe(202);
    expect((await api(memberCookie).post("/api/stores", { name: "gamma" })).statusCode).toBe(202);
    const third = await api(memberCookie).post("/api/stores", { name: "delta" });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("STORE_LIMIT");
    const mine = (await api(memberCookie).get("/api/stores")).json();
    expect(mine.stores.map((x: { slug: string }) => x.slug).sort()).toEqual(["store-beta", "store-gamma"]);
    expect(mine.limits).toMatchObject({ enabled: true, per_user: 2, mine: 2 });
    const alpha = await storeOf(adminCookie, "store-alpha");
    expect((await api(memberCookie).del(`/api/stores/${alpha.id}`)).statusCode).toBe(404);
    // Someone else's name can't be taken over.
    expect((await api(memberCookie).post("/api/stores", { name: "alpha" })).statusCode).toBe(409);
  });

  it("a provisioner failure fails the store with its reason; creating it again retries", async () => {
    provisioner.ensureScript.set("store-beta", [{ phase: "failed", detail: "store-init Job failed: could not download WooCommerce" }]);
    provisioner.ensureScript.set("store-gamma", [{ phase: "installing", detail: "Installing" }]);
    await storeService.reconcileOnce();
    expect(await storeOf(memberCookie, "store-beta")).toMatchObject({ status: "failed", status_reason: "store-init Job failed: could not download WooCommerce" });
    const retry = await api(memberCookie).post("/api/stores", { name: "beta" });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().store).toMatchObject({ status: "provisioning", status_reason: "Retrying" });
  });

  it("an unreachable provisioner is reported but doesn't fail the store; the deadline does", async () => {
    provisioner.down = true;
    await storeService.reconcileOnce();
    expect(await storeOf(memberCookie, "store-gamma")).toMatchObject({ status: "provisioning", status_reason: "provisioner unreachable (connection failed)" });
    provisioner.down = false;
    clock += 16 * 60_000; // past the 15-minute deadline
    await storeService.reconcileOnce();
    const gamma = await storeOf(memberCookie, "store-gamma");
    expect(gamma.status).toBe("failed");
    expect(gamma.status_reason).toMatch(/^Timed out after 15 min/);
    clock = Date.now();
  });

  it("two reconcilers at once never work on the same store (lease)", async () => {
    expect((await api(memberCookie).post("/api/stores", { name: "beta" })).json().store.status).toBe("provisioning");
    provisioner.calls.length = 0;
    await Promise.all([storeService.reconcileOnce(), storeService.reconcileOnce()]);
    expect(provisioner.calls.filter((c) => c.startsWith("ensure store-beta"))).toHaveLength(1);
  });

  it("ready stores are re-checked: an upgrade or a failed upgrade is reported, the store stays ready", async () => {
    const age = () => db.execute(sql`UPDATE stores SET updated_at = now() - interval '11 minutes' WHERE slug = 'store-alpha'`);
    await age();
    provisioner.ensureScript.set("store-alpha", [{ phase: "ready", detail: "Upgrading to the current version in the background" }]);
    await storeService.reconcileOnce();
    expect(await storeOf(adminCookie, "store-alpha")).toMatchObject({ status: "ready", status_reason: "Upgrading to the current version in the background" });
    await age();
    provisioner.ensureScript.set("store-alpha", [{ phase: "failed", detail: "Failed after 3 attempts: timed out" }]);
    await storeService.reconcileOnce();
    expect(await storeOf(adminCookie, "store-alpha")).toMatchObject({ status: "ready", status_reason: "Update failed: Failed after 3 attempts: timed out" });
    expect(await toolsOf(adminCookie)).toContain("store-alpha__list_orders");
    // Not re-checked again before the interval passes.
    provisioner.calls.length = 0;
    await storeService.reconcileOnce();
    expect(provisioner.calls.some((c) => c.startsWith("ensure store-alpha"))).toBe(false);
  });

  it("delete: tools vanish first, then the namespace; the row goes once the provisioner says gone", async () => {
    const alpha = await storeOf(adminCookie, "store-alpha");
    provisioner.removeScript.set("store-alpha", [{ phase: "deleting", detail: "Uninstalling" }, { phase: "gone", detail: "" }]);
    expect((await api(adminCookie).del(`/api/stores/${alpha.id}`)).statusCode).toBe(202);
    await storeService.reconcileOnce();
    expect(await toolsOf(adminCookie)).not.toContain("store-alpha__list_orders");
    expect((await api(adminCookie).get("/api/servers")).json().servers.some((x: { slug: string }) => x.slug === "store-alpha")).toBe(false);
    expect(await storeOf(adminCookie, "store-alpha")).toMatchObject({ status: "deleting", status_reason: "Uninstalling" });
    const rules = await db.select().from(schema.toolPermissions);
    expect(rules.some((r) => r.toolName.startsWith("store-alpha__"))).toBe(false);
    await storeService.reconcileOnce();
    expect(await storeOf(adminCookie, "store-alpha")).toBeUndefined();
    expect(provisioner.calls.filter((c) => c === "remove store-alpha")).toHaveLength(2);
  });
});

describe("revocation and disabling take effect on the next request", () => {
  it("revoked key -> 401 on the very next request", async () => {
    expect((await rawMcp(memberKey)).status).toBe(200);
    await api(memberCookie).del(`/api/keys/${memberKeyId}`);
    const r = await rawMcp(memberKey);
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toBe("This API key has been revoked.");
  });

  it("disabled user -> 403 on /mcp and 401 on the dashboard API, on the next request", async () => {
    const k = (await api(memberCookie).post("/api/keys", { name: "second" })).json().secret;
    expect((await rawMcp(k)).status).toBe(200);
    await api(adminCookie).patch(`/api/users/${memberId}`, { disabled: true });
    expect((await rawMcp(k)).status).toBe(403);
    expect((await api(memberCookie).get("/api/me")).statusCode).toBe(401);
  });

  it("missing or malformed keys -> 401 with a WWW-Authenticate challenge", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
    expect((await rawMcp("wk_notakey")).status).toBe(401);
  });
});
