import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticateApiKey } from "../auth/api-keys.js";
import type { Core } from "../core.js";
import type { ExposedTool } from "../upstream/types.js";

export const GATEWAY_INFO = { name: "team-mcp-gateway", version: "0.1.0" };

/** Gateway tool -> MCP tool definition. The rewrite of "__" names is recorded in _meta. */
export function toMcpTool(t: ExposedTool): Tool {
  return {
    name: t.exposedName,
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
    ...(t.rewritten ? { _meta: { "team-mcp/originalName": t.originalName } } : {}),
  };
}

function rpcError(reply: FastifyReply, status: number, message: string, headers: Record<string, string> = {}) {
  return reply
    .code(status)
    .headers(headers)
    .send({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

/**
 * The gateway's own MCP endpoint (POST /mcp).
 *
 * Auth: `Authorization: Bearer wk_...` on every request, verified against Postgres each
 * time (no caching): missing/invalid/revoked key -> 401, disabled user -> 403.
 *
 * Transport: Streamable HTTP in stateless mode. Each request builds a fresh MCP Server
 * bound to the caller's identity, so any replica can serve any request. Tradeoff: no
 * server-initiated messages (e.g. notifications/tools/list_changed); clients see tool
 * changes on their next tools/list.
 */
export function mcpRoutes(app: FastifyInstance, core: Core): void {
  app.post("/mcp", async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const challenge = { "www-authenticate": 'Bearer realm="team-mcp-gateway"' };
    if (!match?.[1]) return rpcError(reply, 401, "Missing API key. Send Authorization: Bearer <your wk_ key>.", challenge);

    const auth = await authenticateApiKey(core.db, match[1]);
    if (!auth.ok) {
      if (auth.reason === "disabled") return rpcError(reply, 403, "Your account is disabled.");
      const why = auth.reason === "revoked" ? "This API key has been revoked." : "Invalid API key.";
      return rpcError(reply, 401, why, challenge);
    }
    const user = { id: auth.user.id, role: auth.user.role };

    const server = new Server(GATEWAY_INFO, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await core.listTools(user.role)).map(toMcpTool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const out = await core.dispatch({
        user,
        apiKeyId: auth.keyId,
        toolName: r.params.name,
        args: r.params.arguments,
        source: "mcp",
      });
      return out.result;
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack(); // the SDK writes the raw response from here on
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // Stateless: no standalone SSE stream (GET) and no sessions to end (DELETE).
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/mcp",
      handler: async (_req, reply) =>
        reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
    });
  }
}
