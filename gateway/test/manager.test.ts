import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateTools } from "../src/router/aggregate.js";
import { makePolicy, DEFAULT_RULES } from "../src/router/permissions.js";
import { UpstreamManager, type Connector, type UpstreamConfig, type UpstreamSession } from "../src/upstream/manager.js";
import { UpstreamTransportError, UpstreamUnavailableError, type ExposedTool } from "../src/upstream/types.js";

const tool = (name: string, description = ""): Tool => ({ name, description, inputSchema: { type: "object" } });

const cfg = (slug: string, over: Partial<UpstreamConfig> = {}): UpstreamConfig => ({
  id: slug,
  slug,
  url: `http://${slug}.upstreams.svc.cluster.local:8080/mcp`,
  enabled: true,
  credType: "bearer",
  credHeaderName: null,
  credential: "tok-secret-123",
  timeoutMs: 10_000,
  version: "v1",
  ...over,
});

/** Fake connector: per-slug behaviour that tests can switch at runtime. */
function fakeConnector() {
  const behaviour: Record<string, { up: boolean; tools: Tool[]; hang?: boolean }> = {};
  const connects: string[] = [];
  const connector: Connector = {
    async connect(c) {
      connects.push(c.slug);
      const b = behaviour[c.slug];
      if (b?.hang) return new Promise(() => undefined);
      if (!b?.up) throw new UpstreamTransportError(`connect ECONNREFUSED ${c.slug}`);
      const session: UpstreamSession = {
        async listTools() {
          if (!behaviour[c.slug]?.up) throw new UpstreamTransportError("fetch failed");
          return behaviour[c.slug]?.tools ?? [];
        },
        async callTool(name) {
          if (!behaviour[c.slug]?.up) throw new UpstreamTransportError("fetch failed");
          return { content: [{ type: "text", text: `${c.slug}:${name}` }] };
        },
        async close() {},
      };
      return session;
    },
  };
  return { connector, behaviour, connects };
}

describe("UpstreamManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connects, lists, and exposes tools as <slug>__<name>", async () => {
    const f = fakeConnector();
    f.behaviour.notes = { up: true, tools: [tool("create_note"), tool("list_notes")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("notes")]);
    const tools = await m.toolsFor("notes");
    expect(tools.map((t) => t.exposedName)).toEqual(["notes__create_note", "notes__list_notes"]);
    expect(m.status("notes")).toBe("connected");
  });

  it("never contacts a disabled upstream and lists no tools for it", async () => {
    const f = fakeConnector();
    f.behaviour.notes = { up: true, tools: [tool("x")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("notes", { enabled: false })]);
    expect(await m.toolsFor("notes")).toEqual([]);
    await m.checkAll();
    expect(f.connects).toEqual([]);
    expect(m.status("notes")).toBe("disabled");
    await expect(m.callTool("notes", "x", {}, 1000)).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("marks a failing upstream unreachable and retries with exponential backoff capped at 60s", async () => {
    const f = fakeConnector();
    f.behaviour.slow = { up: false, tools: [] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("slow")]);
    await m.check("slow");
    expect(m.status("slow")).toBe("unreachable");
    expect(m.snapshot("slow").lastError).toMatch(/ECONNREFUSED/);
    // Retries at 1s, 2s, 4s, 8s, ... : count connects as time advances.
    for (const ms of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const before = f.connects.length;
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(f.connects.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.connects.length).toBe(before + 1);
    }
  });

  it("recovers when the upstream comes back", async () => {
    const f = fakeConnector();
    f.behaviour.slow = { up: false, tools: [tool("echo")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("slow")]);
    await m.check("slow");
    f.behaviour.slow.up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.status("slow")).toBe("connected");
    expect(m.snapshot("slow")).toMatchObject({ lastError: null, toolCount: 1 });
  });

  it("keeps cached tools during the grace period, then removes them once the upstream is confirmed gone", async () => {
    const f = fakeConnector();
    f.behaviour.slow = { up: true, tools: [tool("echo")] };
    const m = new UpstreamManager(f.connector, { goneAfterFailures: 2 });
    m.sync([cfg("slow")]);
    await m.check("slow");
    f.behaviour.slow.up = false;
    await m.check("slow"); // failure 1: unreachable, tools still listed
    expect(m.status("slow")).toBe("unreachable");
    expect((await m.toolsFor("slow")).length).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // retry fails: failure 2 -> confirmed gone
    expect((await m.toolsFor("slow")).length).toBe(0);
  });

  it("marks the upstream unreachable on a transport error during a call (next call fails fast)", async () => {
    const f = fakeConnector();
    f.behaviour.slow = { up: true, tools: [tool("echo")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("slow")]);
    await m.check("slow");
    f.behaviour.slow.up = false;
    await expect(m.callTool("slow", "echo", {}, 1000)).rejects.toBeInstanceOf(UpstreamTransportError);
    expect(m.status("slow")).toBe("unreachable");
    await expect(m.callTool("slow", "echo", {}, 1000)).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("rewrites '__' in names, rejects collisions and invalid names, and reports them", async () => {
    const f = fakeConnector();
    f.behaviour.x = { up: true, tools: [tool("a__b"), tool("a_b"), tool("ok__name"), tool("bad name")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("x")]);
    const tools = await m.toolsFor("x");
    expect(tools.map((t) => t.exposedName)).toEqual(["x__ok_name"]);
    expect(tools[0]).toMatchObject({ originalName: "ok__name", rewritten: true });
    expect(m.resolveTool("x", "ok_name")).toBe("ok__name");
    expect(m.resolveTool("x", "a_b")).toBeNull();
    expect(m.status("x")).toBe("connected");
    expect(m.snapshot("x").lastError).toMatch(/2 tool\(s\) rejected: .*invalid name "bad name".*collision on "a_b"/);
  });

  it("scrubs the upstream's URL and credential out of tool descriptions", async () => {
    const f = fakeConnector();
    const c = cfg("notes");
    f.behaviour.notes = { up: true, tools: [tool("t", `Calls ${c.url} with tok-secret-123. ${"x".repeat(2000)}`)] };
    const m = new UpstreamManager(f.connector);
    m.sync([c]);
    const [t] = await m.toolsFor("notes");
    expect(t?.description).not.toContain("tok-secret-123");
    expect(t?.description).not.toContain(c.url);
    expect(t?.description.length).toBeLessThanOrEqual(1024);
  });

  it("removing an upstream drops its tools immediately", async () => {
    const f = fakeConnector();
    f.behaviour.notes = { up: true, tools: [tool("x")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("notes")]);
    await m.check("notes");
    m.sync([]);
    expect(m.cachedTools("notes")).toEqual([]);
    expect(m.status("notes")).toBe("pending"); // unknown
  });
});

describe("aggregateTools", () => {
  it("one dead (hanging) upstream does not block the listing from the others", async () => {
    const f = fakeConnector();
    f.behaviour.woocommerce = { up: true, tools: [tool("list_orders"), tool("update_order_status")] };
    f.behaviour.slow = { up: true, tools: [], hang: true }; // connect never returns
    f.behaviour.notes = { up: false, tools: [] }; // refuses connections
    const m = new UpstreamManager(f.connector);
    const configs = [cfg("woocommerce"), cfg("slow"), cfg("notes")];
    m.sync(configs);
    const refs = configs.map((c) => ({ id: c.id, slug: c.slug, enabled: true, timeoutMs: 10_000 }));
    const started = Date.now();
    const tools: ExposedTool[] = await aggregateTools("admin", {
      listEnabledUpstreams: async () => refs,
      toolsFor: (u) => m.toolsFor(u.id),
      loadPolicy: async () => makePolicy(DEFAULT_RULES, "allow"),
      perUpstreamTimeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(tools.map((t) => t.exposedName)).toEqual(["woocommerce__list_orders", "woocommerce__update_order_status"]);
    await m.close();
  });

  it("hides tools the role may not call", async () => {
    const f = fakeConnector();
    f.behaviour.woocommerce = { up: true, tools: [tool("list_orders"), tool("update_order_status"), tool("create_product")] };
    const m = new UpstreamManager(f.connector);
    m.sync([cfg("woocommerce")]);
    const ref = { id: "woocommerce", slug: "woocommerce", enabled: true, timeoutMs: 10_000 };
    const names = (await aggregateTools("member", {
      listEnabledUpstreams: async () => [ref],
      toolsFor: (u) => m.toolsFor(u.id),
      loadPolicy: async () => makePolicy(DEFAULT_RULES, "allow"),
      perUpstreamTimeoutMs: 1000,
    })).map((t) => t.exposedName);
    expect(names).toEqual(["woocommerce__list_orders"]);
    await m.close();
  });
});
