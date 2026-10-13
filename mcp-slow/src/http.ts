// Same as mcp-notes/src/http.ts (small, deliberately duplicated: see docs/design.md D4.1).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearerAuth, rpcError } from "./auth.js";

/** Filled in by tool handlers so the request log line can name the tool and outcome. */
export interface CallContext {
  tool?: string;
  outcome?: "ok" | "error";
}

export interface McpAppOptions {
  serverInfo: { name: string; version: string };
  /** Registers this server's tools on a fresh McpServer for one request. */
  registerTools(server: McpServer, ctx: CallContext): void;
  getBearerToken(): Promise<string | undefined>;
  log(fields: Record<string, unknown>): void;
}

/**
 * Minimal MCP-over-HTTP app (same pattern as woo-mcp, see docs/design.md D2.4/D4.1):
 *   POST /mcp   Streamable HTTP, stateless (fresh server per request), bearer auth first
 *   GET/DELETE  405 (no sessions, no standalone SSE stream)
 *   GET /healthz  unauthenticated, for probes
 * One JSON log line per request with the tool NAME and outcome, never arguments.
 */
export function createMcpApp(opts: McpAppOptions) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = performance.now();
    res.on("finish", () => {
      if (req.path === "/healthz") return;
      const ctx = res.locals.call as CallContext | undefined;
      const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
      const rpc = typeof body?.method === "string" ? body.method : undefined;
      const requested = rpc === "tools/call" && typeof body?.params?.name === "string" ? body.params.name : undefined;
      opts.log({
        msg: "request",
        http_method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - start),
        rpc_method: rpc,
        tool: ctx?.tool ?? requested,
        outcome: ctx?.outcome ?? (requested ? "rejected" : undefined),
      });
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/mcp", bearerAuth(opts.getBearerToken, opts.serverInfo.name), express.json({ limit: "1mb" }), async (req, res) => {
    const ctx: CallContext = {};
    res.locals.call = ctx;
    const server = new McpServer(opts.serverInfo);
    opts.registerTools(server, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all("/mcp", (_req, res) => {
    res.set("Allow", "POST").status(405).json(rpcError("Method not allowed.", -32000));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const parse = (err as { type?: string })?.type === "entity.parse.failed";
    if (!parse) opts.log({ msg: "unhandled error", error: (err as Error)?.name ?? "Error" });
    if (res.headersSent) return;
    res.status(parse ? 400 : 500).json(rpcError(parse ? "Parse error" : "Internal error", parse ? -32700 : -32603));
  });

  return app;
}
