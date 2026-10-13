import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/audit/types.js";
import { dispatch, type DispatchDeps, type UpstreamRef } from "../src/router/dispatch.js";
import { makePolicy, DEFAULT_RULES } from "../src/router/permissions.js";
import {
  UpstreamProtocolError,
  UpstreamTimeoutError,
  UpstreamTransportError,
  type UpstreamStatus,
} from "../src/upstream/types.js";

const admin = { id: "u-admin", role: "admin" as const };
const member = { id: "u-member", role: "member" as const };

const ok: CallToolResult = { content: [{ type: "text", text: '{"orders":[]}' }] };

/** Fake world: two upstreams, configurable status/behaviour, records audit rows and calls. */
function world(opts: {
  status?: Record<string, UpstreamStatus>;
  call?: (slug: string, tool: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  tools?: Record<string, string[] | undefined>;
} = {}) {
  const upstreams: Record<string, UpstreamRef> = {
    woocommerce: { id: "1", slug: "woocommerce", enabled: true, timeoutMs: 10_000 },
    notes: { id: "2", slug: "notes", enabled: true, timeoutMs: 10_000 },
    old: { id: "3", slug: "old", enabled: false, timeoutMs: 10_000 },
  };
  const audit: AuditEntry[] = [];
  const calls: string[] = [];
  let t = 0;
  const deps: DispatchDeps = {
    findUpstream: async (slug) => upstreams[slug] ?? null,
    upstreamStatus: (u) => opts.status?.[u.slug] ?? "connected",
    resolveTool: (u, local) => {
      const list = opts.tools?.[u.slug];
      if (list === undefined) return undefined;
      return list.includes(local) ? local : null;
    },
    callTool: async (u, tool, args) => {
      calls.push(`${u.slug}:${tool}`);
      return opts.call ? opts.call(u.slug, tool, args) : ok;
    },
    loadPolicy: async () => makePolicy(DEFAULT_RULES, "allow"),
    writeAudit: async (e) => {
      audit.push(e);
    },
    now: () => (t += 5), // each now() call advances 5 ms: deterministic durations
  };
  return { deps, audit, calls };
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("dispatch", () => {
  it("succeeds, passes args, and writes one ok audit row with the api key id", async () => {
    const w = world();
    const r = await dispatch(
      { user: member, apiKeyId: "k1", toolName: "woocommerce__list_orders", args: { status: "processing" }, source: "mcp" },
      w.deps,
    );
    expect(r.outcome).toBe("ok");
    expect(r.result).toEqual(ok);
    expect(w.calls).toEqual(["woocommerce:list_orders"]);
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({
      userId: "u-member",
      apiKeyId: "k1",
      source: "mcp",
      serverSlug: "woocommerce",
      tool: "woocommerce__list_orders",
      outcome: "ok",
      errorCode: null,
      argsSummary: '{"status":"processing"}',
    });
    expect(w.audit[0]?.durationMs).toBeGreaterThan(0);
  });

  it.each([
    ["no separator", "list_orders"],
    ["invalid slug characters", "Woo!__list_orders"],
    ["empty tool part", "woocommerce__"],
    ["unknown slug", "nope__list_orders"],
  ])("returns TOOL_NOT_FOUND for %s, audited, upstream never called", async (_label, name) => {
    const w = world();
    const r = await dispatch({ user: admin, toolName: name, args: {}, source: "chat" }, w.deps);
    expect(r.result.isError).toBe(true);
    expect(text(r.result)).toMatch(/^\[TOOL_NOT_FOUND\]/);
    expect(w.calls).toHaveLength(0);
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ outcome: "error", errorCode: "TOOL_NOT_FOUND", source: "chat" });
  });

  it("returns TOOL_NOT_FOUND when the cached tool list doesn't contain the tool", async () => {
    const w = world({ tools: { woocommerce: ["list_orders"] } });
    const r = await dispatch({ user: admin, toolName: "woocommerce__drop_tables", args: {}, source: "mcp" }, w.deps);
    expect(text(r.result)).toMatch(/^\[TOOL_NOT_FOUND\]/);
    expect(w.calls).toHaveLength(0);
  });

  it("returns SERVER_DISABLED for a disabled upstream without contacting it", async () => {
    const w = world();
    const r = await dispatch({ user: admin, toolName: "old__anything", args: {}, source: "mcp" }, w.deps);
    expect(text(r.result)).toBe("[SERVER_DISABLED] old is disabled by an administrator.");
    expect(w.calls).toHaveLength(0);
    expect(w.audit[0]).toMatchObject({ outcome: "disabled", errorCode: "SERVER_DISABLED", serverSlug: "old" });
  });

  it("fails fast with SERVER_UNREACHABLE for an upstream known to be down", async () => {
    const w = world({ status: { notes: "unreachable" } });
    const r = await dispatch({ user: admin, toolName: "notes__list_notes", args: {}, source: "mcp" }, w.deps);
    expect(text(r.result)).toBe("[SERVER_UNREACHABLE] notes is not reachable right now.");
    expect(w.calls).toHaveLength(0); // no attempt, so no waiting for a timeout
    expect(w.audit[0]).toMatchObject({ outcome: "unreachable", errorCode: "SERVER_UNREACHABLE" });
  });

  it("denies a member a restricted tool (FORBIDDEN) even when called directly", async () => {
    const w = world();
    const r = await dispatch(
      { user: member, toolName: "woocommerce__update_order_status", args: { id: 1, status: "completed" }, source: "mcp" },
      w.deps,
    );
    expect(text(r.result)).toMatch(/^\[FORBIDDEN\]/);
    expect(w.calls).toHaveLength(0);
    expect(w.audit[0]).toMatchObject({ outcome: "denied", errorCode: "FORBIDDEN", userId: "u-member" });
  });

  it("lets an admin call the same restricted tool", async () => {
    const w = world();
    const r = await dispatch({ user: admin, toolName: "woocommerce__update_order_status", args: {}, source: "chat" }, w.deps);
    expect(r.outcome).toBe("ok");
    expect(w.calls).toEqual(["woocommerce:update_order_status"]);
  });

  it("maps an upstream timeout to TIMEOUT", async () => {
    const w = world({
      call: async () => {
        throw new UpstreamTimeoutError("timed out");
      },
    });
    const r = await dispatch({ user: admin, toolName: "notes__slow", args: {}, source: "mcp" }, w.deps);
    expect(text(r.result)).toBe("[TIMEOUT] notes__slow did not respond within 10s.");
    expect(w.audit[0]).toMatchObject({ outcome: "timeout", errorCode: "TIMEOUT" });
  });

  it.each([
    ["transport failure", new UpstreamTransportError("fetch failed")],
    ["JSON-RPC error", new UpstreamProtocolError("MCP error -32602: Invalid params")],
  ])("maps a %s to UPSTREAM_ERROR with a truncated message", async (_l, error) => {
    const w = world({
      call: async () => {
        throw error;
      },
    });
    const r = await dispatch({ user: admin, toolName: "notes__list_notes", args: {}, source: "mcp" }, w.deps);
    expect(text(r.result)).toMatch(/^\[UPSTREAM_ERROR\] notes returned an error: /);
    expect(w.audit[0]).toMatchObject({ outcome: "error", errorCode: "UPSTREAM_ERROR" });
  });

  it("passes an upstream isError result through unchanged, audited as error", async () => {
    const toolErr: CallToolResult = { isError: true, content: [{ type: "text", text: "Order 9999 not found" }] };
    const w = world({ call: async () => toolErr });
    const r = await dispatch({ user: member, toolName: "woocommerce__get_order", args: { id: 9999 }, source: "chat" }, w.deps);
    expect(r.result).toEqual(toolErr);
    expect(w.audit[0]).toMatchObject({ outcome: "error", errorCode: "TOOL_ERROR", errorMessage: "Order 9999 not found" });
  });

  it("redacts sensitive argument values in the audit summary", async () => {
    const w = world();
    await dispatch(
      { user: admin, toolName: "notes__create_note", args: { title: "t", api_key: "sk-123", nested: { password: "p" } }, source: "mcp" },
      w.deps,
    );
    const summary = w.audit[0]?.argsSummary ?? "";
    expect(summary).not.toContain("sk-123");
    expect(summary).not.toContain('"p"');
    expect(summary).toContain("[redacted]");
  });

  it("still returns the result if writing the audit row fails, and reports it", async () => {
    const w = world();
    const failures: unknown[] = [];
    w.deps.writeAudit = async () => {
      throw new Error("db down");
    };
    w.deps.onAuditFailure = (e) => failures.push(e);
    const r = await dispatch({ user: admin, toolName: "notes__list_notes", args: {}, source: "mcp" }, w.deps);
    expect(r.outcome).toBe("ok");
    expect(failures).toHaveLength(1);
  });
});
