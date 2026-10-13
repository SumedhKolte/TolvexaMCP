import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Core } from "../core.js";
import { HttpError, parseBody } from "../http/errors.js";
import { currentUser, requireSession } from "../http/guards.js";
import { runChat, type ChatEvent } from "./agent.js";
import type { ChatModel } from "./model.js";
import { createMasker, PseudonymVault } from "./privacy.js";

/**
 * Conversation history comes from the browser on every request (the server keeps no
 * chat state, so any replica can answer). Only user/assistant TEXT is accepted: tool
 * calls and results are never taken from the client, so a client can't forge them.
 */
const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8_000) }))
    .min(1)
    .max(40)
    .refine((m) => m.at(-1)?.role === "user", "the last message must be from the user")
    .refine((m) => (m.at(-1)?.content.trim().length ?? 0) > 0, "the message is empty"),
});

export interface ChatRouteOptions {
  model: ChatModel | null;
  /** Why chat is unavailable when `model` is null (shown to the user). */
  unavailableReason?: string;
  maxIterations: number;
  maxResultBytes: number;
  /** Key for customer pseudonyms; masking is off when absent (CHAT_PII_MASKING=false). */
  pseudonymKey?: Buffer;
}

/**
 * POST /api/chat: Server-Sent Events. Events: text, tool_call, tool_result, done, error
 * (spec section 15). Each event is `event: <type>\ndata: <json>\n\n`.
 */
export function chatRoutes(app: FastifyInstance, core: Core, opts: ChatRouteOptions): void {
  // One running chat per user: protects the (free-tier) LLM quota and the upstreams from
  // a stuck tab firing requests in parallel. Per replica; enough for this purpose.
  const running = new Set<string>();
  // Pseudonym -> real value, per user and in memory only (never sent to the provider).
  // Kept per user so nobody can reveal customers that only came up in someone else's chat.
  const vaults = new Map<string, PseudonymVault>();
  const vaultFor = (userId: string) => {
    let v = vaults.get(userId);
    if (!v) vaults.set(userId, (v = new PseudonymVault()));
    return v;
  };

  // Lets the Chat page say up front whether chat works and whether customer data is masked.
  app.get("/api/chat/status", { preHandler: requireSession(core) }, async () => ({
    available: opts.model !== null,
    reason: opts.model ? null : (opts.unavailableReason ?? "Chat is not configured"),
    masking: opts.pseudonymKey !== undefined,
  }));

  app.post("/api/chat", { preHandler: requireSession(core) }, async (req, reply) => {
    const me = currentUser(req);
    const body = parseBody(Body, req.body);
    if (!opts.model) throw new HttpError(503, "CHAT_UNAVAILABLE", opts.unavailableReason ?? "Chat is not configured");
    if (running.has(me.id)) throw new HttpError(429, "CHAT_BUSY", "You already have a chat answer in progress. Wait for it or stop it first.");
    running.add(me.id);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tell nginx (ingress) not to buffer: events must reach the browser as they happen.
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    const send = (e: ChatEvent) => {
      if (!res.writableEnded) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Comment lines keep the connection alive through proxies during slow tool calls.
    const heartbeat = setInterval(() => !res.writableEnded && res.write(": keep-alive\n\n"), 15_000);
    // Closing the tab (or the Stop button) aborts the model request and the loop.
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    try {
      await runChat(
        { user: { id: me.id, role: me.role, email: me.email }, history: body.messages, signal: abort.signal, emit: send },
        {
          model: opts.model,
          listTools: (role) => core.listTools(role),
          dispatch: (r) => core.dispatch(r),
          maxIterations: opts.maxIterations,
          maxResultBytes: opts.maxResultBytes,
          masker: opts.pseudonymKey ? createMasker(opts.pseudonymKey, vaultFor(me.id)) : undefined,
          onError: (err) => req.log.error({ err }, "chat failed"),
        },
      );
    } finally {
      clearInterval(heartbeat);
      running.delete(me.id);
      if (!res.writableEnded) res.end();
    }
  });
}
