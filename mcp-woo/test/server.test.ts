import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { WooClient } from "../src/woo-client.js";

/**
 * In-process end-to-end: real Express app + real MCP SDK client over Streamable HTTP,
 * with only WooCommerce's HTTP API faked.
 */
const TOKEN = "test-bearer-token-0123456789";
const SECRET = "cs_fedcba9876543210fedc";

const order = (id: number) => ({
  id,
  number: String(id),
  status: "processing",
  currency: "USD",
  date_created: "2026-10-11T10:00:00",
  date_created_gmt: "2026-10-11T17:00:00",
  date_paid: null,
  date_completed: null,
  total: "12.00",
  total_tax: "0.00",
  shipping_total: "0.00",
  discount_total: "0.00",
  payment_method_title: "Cash on delivery",
  customer_note: "",
  billing: { first_name: "Ada", last_name: "L", email: "ada@example.com" },
  line_items: [{ name: "Team MCP Mug", quantity: 1, subtotal: "12.00", total: "12.00" }],
});

const wcCalls: string[] = [];
const fakeWoo = async (url: string, init: RequestInit): Promise<Response> => {
  wcCalls.push(`${init.method} ${url}`);
  const json = (s: number, b: unknown, h: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...h } });
  const path = new URL(url).pathname;
  if (path.endsWith("/orders/9999")) return json(404, { code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." });
  if (path.endsWith("/orders")) return json(200, [order(12)], { "x-wp-total": "1", "x-wp-totalpages": "1" });
  if (/\/orders\/\d+$/.test(path)) {
    const id = Number(path.split("/").pop());
    const body = init.body ? JSON.parse(String(init.body)) : {};
    return json(200, { ...order(id), ...(body.status ? { status: body.status } : {}) });
  }
  return json(500, {});
};

const logs: Record<string, unknown>[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  const woo = new WooClient({
    baseUrl: "http://wordpress.test",
    signatureBaseUrl: "http://store.test",
    timeoutMs: 2000,
    credentials: async () => ({ consumerKey: "ck_0123456789abcdef0123", consumerSecret: SECRET }),
    fetchImpl: fakeWoo as unknown as typeof fetch,
  });
  const app = createApp({ woo, getBearerToken: async () => TOKEN, log: (f) => logs.push(f) });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect(token = TOKEN) {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("HTTP surface", () => {
  it("serves /healthz without auth", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  it("rejects /mcp without a token (401)", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a wrong token (401) and an MCP client using it fails to connect", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(r.status).toBe(401);
    await expect(connect("wrong-token")).rejects.toThrow();
  });

  it("answers GET /mcp with 405 (stateless: no SSE stream)", async () => {
    const r = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("lists exactly the five tools with the right annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["create_product", "get_order", "list_orders", "list_products", "update_order_status"].sort(),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_products?.annotations?.readOnlyHint).toBe(true);
    expect(byName.list_orders?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get_order?.annotations?.readOnlyHint).toBe(true);
    expect(byName.update_order_status?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });

  it("get_order for a missing order returns a short tool error", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "get_order", arguments: { id: 9999 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Order 9999 not found");
    await client.close();
  });

  it("list_orders normalizes dates to UTC and filters on GMT", async () => {
    const client = await connect();
    wcCalls.length = 0;
    const r = await client.callTool({ name: "list_orders", arguments: { after: "2026-10-11" } });
    expect(r.isError).toBeFalsy();
    expect(wcCalls[0]).toContain("after=2026-10-11T00%3A00%3A00.000Z");
    expect(wcCalls[0]).toContain("dates_are_gmt=true");
    const body = JSON.parse(text(r));
    expect(body.orders[0]).toMatchObject({ id: 12, billing: { name: "Ada L", email: "ada@example.com" } });
    await client.close();
  });

  it("rejects invalid input before calling WooCommerce", async () => {
    const client = await connect();
    wcCalls.length = 0;
    const r = await client.callTool({ name: "update_order_status", arguments: { id: 12, status: "shipped" } });
    expect(r.isError).toBe(true);
    expect(wcCalls).toHaveLength(0);
    await client.close();
  });

  it("update_order_status returns the updated order", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "update_order_status", arguments: { id: 12, status: "completed" } });
    expect(JSON.parse(text(r)).status).toBe("completed");
    await client.close();
  });

  it("logs one line per request with tool and outcome, never arguments or secrets", () => {
    const toolLines = logs.filter((l) => l.rpc_method === "tools/call");
    expect(toolLines.length).toBeGreaterThan(0);
    expect(toolLines.some((l) => l.tool === "get_order" && l.outcome === "error")).toBe(true);
    // Rejected by input validation before the handler ran: still attributed to the tool.
    expect(toolLines.some((l) => l.tool === "update_order_status" && l.outcome === "rejected")).toBe(true);
    const all = JSON.stringify(logs);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("9999"); // an argument value
  });
});
