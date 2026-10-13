import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpApp } from "../src/http.js";
import { registerSlowTools, type SlowOptions } from "../src/tools.js";

const TOKEN = "slow-test-token-123";
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(opts: SlowOptions) {
  const app = createMcpApp({
    serverInfo: { name: "mcp-slow", version: "test" },
    registerTools: (s, ctx) => registerSlowTools(s, opts, ctx),
    getBearerToken: async () => TOKEN,
    log: () => undefined,
  });
  const srv = app.listen(0);
  server = srv;
  await new Promise((r) => srv.once("listening", r));
  const c = new Client({ name: "t", version: "0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  return c;
}
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("mcp-slow", () => {
  it("echo waits the configured delay (default) or the per-call override", async () => {
    const slept: number[] = [];
    const c = await start({ echoDelayMs: 15_000, flakyFailureRate: 0.5, allowCrash: false, sleep: async (ms) => void slept.push(ms) });
    expect(JSON.parse(textOf(await c.callTool({ name: "echo", arguments: { message: "hi" } })))).toEqual({ echo: "hi", delayed_ms: 15_000 });
    await c.callTool({ name: "echo", arguments: { message: "hi", delay_ms: 50 } });
    expect(slept).toEqual([15_000, 50]);
  });

  it("echo really is slow: a client with a shorter timeout gives up", async () => {
    const c = await start({ echoDelayMs: 1_000, flakyFailureRate: 0, allowCrash: false });
    await expect(c.callTool({ name: "echo", arguments: { message: "x" } }, undefined, { timeout: 200 })).rejects.toThrow(/timed out/i);
  });

  it("flaky fails when the dice say so, succeeds otherwise", async () => {
    const rolls = [0.1, 0.0, 0.9];
    const c = await start({ echoDelayMs: 0, flakyFailureRate: 0.5, allowCrash: false, random: () => rolls.shift() ?? 0.9 });
    const fail = await c.callTool({ name: "flaky", arguments: {} });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toMatch(/^Random failure/);
    const ok = await c.callTool({ name: "flaky", arguments: { message: "m" } });
    expect(ok.isError).toBeFalsy();
  });

  it("flaky fails about half the time with the default rate", async () => {
    const c = await start({ echoDelayMs: 0, flakyFailureRate: 0.5, allowCrash: false });
    let failures = 0;
    for (let i = 0; i < 200; i++) if ((await c.callTool({ name: "flaky", arguments: {} })).isError) failures++;
    expect(failures).toBeGreaterThan(60);
    expect(failures).toBeLessThan(140);
  });

  it("crash is not even registered unless ALLOW_CRASH is on", async () => {
    const c = await start({ echoDelayMs: 0, flakyFailureRate: 0, allowCrash: false });
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["echo", "flaky"]);
  });

  it("crash answers first, then exits the process", async () => {
    const exits: number[] = [];
    const c = await start({ echoDelayMs: 0, flakyFailureRate: 0, allowCrash: true, exit: (code) => void exits.push(code) });
    const tools = (await c.listTools()).tools;
    expect(tools.find((t) => t.name === "crash")?.annotations?.destructiveHint).toBe(true);
    expect(textOf(await c.callTool({ name: "crash", arguments: {} }))).toMatch(/crashing/);
    expect(exits).toEqual([]); // not before the response
    await new Promise((r) => setTimeout(r, 300));
    expect(exits).toEqual([1]);
  });
});
