import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyError, credentialHeaders, HttpConnector } from "../src/upstream/connector.js";
import type { UpstreamConfig } from "../src/upstream/manager.js";
import { UpstreamProtocolError, UpstreamTimeoutError, UpstreamTransportError } from "../src/upstream/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

const cfg = (url: string, over: Partial<UpstreamConfig> = {}): UpstreamConfig => ({
  id: "x", slug: "x", url, enabled: true, credType: "none", credHeaderName: null, credential: null, timeoutMs: 10_000, version: "1", ...over,
});

describe("HttpConnector", () => {
  // A TCP server that accepts connections but never answers: like a hung upstream.
  let silent: Server;
  let port = 0;
  let closedPort = 0;
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    silent = createServer((s) => void sockets.add(s)).listen(0, "127.0.0.1");
    await new Promise((r) => silent.once("listening", r));
    port = (silent.address() as AddressInfo).port;
    // A port that was just free: nothing listens there, so connections are refused.
    const tmp = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => tmp.once("listening", r));
    closedPort = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
  });
  afterAll(() => {
    for (const s of sockets) s.destroy(); // the client keeps sockets alive; close() waits for them
    return new Promise<void>((r) => silent.close(() => r()));
  });

  it("reports an unanswered MCP connect as a timeout, within the connect deadline", async () => {
    const c = new HttpConnector({ allowlist: ["127.0.0.1"], allowPublic: false }, 300);
    const t0 = Date.now();
    await expect(c.connect(cfg(`http://127.0.0.1:${port}/mcp`), 400)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("reports a refused connection as a transport error (marks the upstream down)", async () => {
    const c = new HttpConnector({ allowlist: ["127.0.0.1"], allowPublic: false }, 300);
    const err = await c.connect(cfg(`http://127.0.0.1:${closedPort}/mcp`), 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTransportError);
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
  });

  it("refuses to connect when the name resolves to a blocked address (SSRF at connect time)", async () => {
    const c = new HttpConnector({ allowlist: ["localhost"], allowPublic: false }, 300);
    const err = await c.connect(cfg(`http://localhost:${closedPort}/mcp`), 2000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamTransportError);
    expect((err as Error).message).toMatch(/^blocked by SSRF guard: localhost resolves to a blocked address/);
  });
});

describe("classifyError / credentialHeaders", () => {
  it("sorts SDK errors into timeout / protocol / transport", () => {
    expect(classifyError(new McpError(ErrorCode.RequestTimeout, "t"))).toBeInstanceOf(UpstreamTimeoutError);
    expect(classifyError(new McpError(ErrorCode.InvalidParams, "p"))).toBeInstanceOf(UpstreamProtocolError);
    expect(classifyError(new McpError(ErrorCode.ConnectionClosed, "c"))).toBeInstanceOf(UpstreamTransportError);
    expect(classifyError(new TypeError("fetch failed"))).toBeInstanceOf(UpstreamTransportError);
  });

  it("adds the credential only as the configured header", () => {
    expect(credentialHeaders(cfg("http://x", { credType: "bearer", credential: "t" }))).toEqual({ Authorization: "Bearer t" });
    expect(credentialHeaders(cfg("http://x", { credType: "header", credHeaderName: "X-Api-Key", credential: "t" }))).toEqual({ "X-Api-Key": "t" });
    expect(credentialHeaders(cfg("http://x", { credType: "none", credential: "t" }))).toEqual({});
  });
});
