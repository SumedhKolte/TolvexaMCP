import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpApp } from "../src/http.js";
import { NotesStore } from "../src/store.js";
import { registerNotesTools } from "../src/tools.js";

const TOKEN = "notes-test-token-123";
const file = join(mkdtempSync(join(tmpdir(), "notes-")), "notes.json");
const store = new NotesStore(file, 3);
const logs: Record<string, unknown>[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createMcpApp({
    serverInfo: { name: "mcp-notes", version: "test" },
    registerTools: (s, ctx) => registerNotesTools(s, store, ctx),
    getBearerToken: async () => TOKEN,
    log: (f) => logs.push(f),
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function client(token = TOKEN) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return c;
}
const body = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "null");

describe("mcp-notes", () => {
  it("requires the bearer token", async () => {
    expect((await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    await expect(client("wrong")).rejects.toThrow();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("exposes exactly create_note, list_notes, search_notes", async () => {
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["create_note", "list_notes", "search_notes"]);
    await c.close();
  });

  it("creates, lists (newest first), and searches notes; persists to the file", async () => {
    const c = await client();
    await c.callTool({ name: "create_note", arguments: { title: "Orders today", body: "1 order, $12 COD" } });
    await c.callTool({ name: "create_note", arguments: { title: "Standup", body: "nothing blocked" } });
    const list = body(await c.callTool({ name: "list_notes", arguments: { limit: 10 } }));
    expect(list.notes.map((n: { title: string }) => n.title)).toEqual(["Standup", "Orders today"]);
    const hits = body(await c.callTool({ name: "search_notes", arguments: { query: "cod" } }));
    expect(hits.count).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
    await c.close();
  });

  it("caps the number of notes, dropping the oldest", async () => {
    const c = await client();
    for (const t of ["a", "b", "c"]) await c.callTool({ name: "create_note", arguments: { title: t, body: "" } });
    expect(body(await c.callTool({ name: "list_notes", arguments: {} })).total).toBe(3);
    expect(new NotesStore(file, 3).list(10).map((n) => n.title)).toEqual(["c", "b", "a"]); // reloads from disk
    await c.close();
  });

  it("validates input and logs tool names but never note contents", async () => {
    const c = await client();
    const r = await c.callTool({ name: "create_note", arguments: { title: "", body: "secret plan" } });
    expect(r.isError).toBe(true);
    await c.close();
    expect(JSON.stringify(logs)).not.toContain("secret plan");
    expect(logs.some((l) => l.tool === "create_note" && l.outcome === "rejected")).toBe(true);
  });
});
