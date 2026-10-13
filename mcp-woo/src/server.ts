import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearerAuth, rpcError } from "./auth.js";
import { log as defaultLog } from "./log.js";
import { registerWooTools, type CallContext } from "./tools.js";
import type { WooClient } from "./woo-client.js";

export interface AppDeps {
  woo: WooClient;
  getBearerToken: () => Promise<string | undefined>;
  log?: (fields: Record<string, unknown>) => void;
}

export const SERVER_INFO = { name: "woo-mcp", version: "0.1.0" };

/**
 * Builds the HTTP app.
 *
 * Transport: MCP Streamable HTTP in **stateless** mode. Every POST /mcp gets a fresh
 * McpServer + transport, with no session IDs and no server-side state, so any replica
 * can answer any request and a restart loses nothing. The cost: no server-initiated
 * messages (notifications, GET SSE stream). The tool set is static, so nothing is lost.
 * JSON responses (not SSE) are enabled since every request has exactly one response.
 */
export function createApp(deps: AppDeps) {
  const log = deps.log ?? defaultLog;
  const app = express();
  app.disable("x-powered-by");

  // Request log: one line per request, written when the response finishes.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = performance.now();
    res.on("finish", () => {
      if (req.path === "/healthz") return; // probes every few seconds; not useful
      const ctx = res.locals.call as CallContext | undefined;
      const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
      const rpcMethod = typeof body?.method === "string" ? body.method : undefined;
      // The tool NAME is safe to log (arguments are not). If the SDK rejected the call
      // before our handler ran (e.g. input validation), ctx is empty: say so.
      const requestedTool = rpcMethod === "tools/call" && typeof body?.params?.name === "string" ? body.params.name : undefined;
      log({
        msg: "request",
        http_method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - start),
        rpc_method: rpcMethod,
        tool: ctx?.tool ?? requestedTool,
        outcome: ctx?.outcome ?? (requestedTool ? "rejected" : undefined),
      });
    });
    next();
  });

  // Liveness/readiness: process is up. Deliberately does not call WooCommerce, so a
  // store outage doesn't restart this pod (tools report the outage as tool errors).
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Auth runs BEFORE body parsing: unauthenticated requests are rejected without
  // reading their payload.
  app.post(
    "/mcp",
    bearerAuth(deps.getBearerToken),
    express.json({ limit: "1mb" }),
    async (req: Request, res: Response) => {
      const ctx: CallContext = {};
      res.locals.call = ctx;
      const server = new McpServer(SERVER_INFO);
      registerWooTools(server, deps.woo, ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
  app.all("/mcp", (_req, res) => {
    res.set("Allow", "POST").status(405).json(rpcError("Method not allowed.", -32000));
  });

  // Malformed JSON and any unexpected error: JSON-RPC shaped, no stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isParse = (err as { type?: string })?.type === "entity.parse.failed";
    if (!isParse) log({ msg: "unhandled error", error: (err as Error)?.name ?? "Error" });
    if (res.headersSent) return;
    res.status(isParse ? 400 : 500).json(rpcError(isParse ? "Parse error" : "Internal error", isParse ? -32700 : -32603));
  });

  return app;
}
