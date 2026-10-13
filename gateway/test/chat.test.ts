import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { resultText, runChat, toFunctionName, type ChatEvent } from "../src/chat/agent.js";
import { loadConfig } from "../src/config/index.js";
import { chatModelFromConfig } from "../src/http/app.js";
import { LlmError, type ChatMessage, type ChatModel, type ModelTurn, type ToolSpec } from "../src/chat/model.js";
import type { DispatchRequest, DispatchResult } from "../src/router/dispatch.js";
import type { ExposedTool } from "../src/upstream/types.js";

const tool = (exposedName: string, description = "d"): ExposedTool => ({
  exposedName,
  slug: exposedName.split("__")[0] as string,
  originalName: exposedName.split("__")[1] as string,
  rewritten: false,
  description,
  inputSchema: { type: "object", properties: { id: { type: "number" } } } as Tool["inputSchema"],
});

/** A model that plays back scripted turns and records what it was sent. */
function scripted(turns: (ModelTurn | Error)[]) {
  const seen: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  const model: ChatModel = {
    async complete(messages, tools, { onText }) {
      seen.push({ messages: structuredClone(messages), tools });
      const t = turns.shift() ?? { text: "done", toolCalls: [] };
      if (t instanceof Error) throw t;
      if (t.text) onText(t.text);
      return t;
    },
  };
  return { model, seen };
}

function harness(turns: (ModelTurn | Error)[], tools: ExposedTool[], dispatchImpl?: (r: DispatchRequest) => DispatchResult) {
  const { model, seen } = scripted(turns);
  const events: ChatEvent[] = [];
  const dispatched: DispatchRequest[] = [];
  const run = () =>
    runChat(
      { user: { id: "u1", role: "member", email: "bea@x" }, history: [{ role: "user", content: "what orders came in today?" }], signal: new AbortController().signal, emit: (e) => events.push(e) },
      {
        model,
        listTools: async () => tools,
        dispatch: async (r) => {
          dispatched.push(r);
          return (
            dispatchImpl?.(r) ?? { result: { content: [{ type: "text", text: '{"orders":[{"id":15}]}' }] }, outcome: "ok", errorCode: null, durationMs: 41, serverSlug: "woocommerce" }
          );
        },
        maxIterations: 3,
        maxResultBytes: 64,
        now: () => new Date("2026-10-12T09:00:00Z"),
      },
    );
  return { run, events, dispatched, seen };
}

const call = (name: string, args: unknown = {}, id = "c1") => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

describe("chat agent loop", () => {
  it("routes the model's tool call through dispatch() with source 'chat', then finishes", async () => {
    const h = harness(
      [
        { text: "", toolCalls: [call("woocommerce__list_orders", { after: "2026-10-12T00:00:00Z" })] },
        { text: "One order today: #15.", toolCalls: [] },
      ],
      [tool("woocommerce__list_orders")],
    );
    await h.run();
    expect(h.dispatched).toEqual([{ user: { id: "u1", role: "member", email: "bea@x" }, toolName: "woocommerce__list_orders", args: { after: "2026-10-12T00:00:00Z" }, source: "chat" }]);
    expect(h.events.map((e) => e.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(h.events[1]).toMatchObject({ type: "tool_result", ok: true, outcome: "ok", duration_ms: 41 });
    // The tool result went back to the model as a tool message.
    const second = h.seen[1]?.messages ?? [];
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: '{"orders":[{"id":15}]}' });
  });

  it("offers the model only the tools it was given, with today's date in the system prompt", async () => {
    const h = harness([{ text: "hi", toolCalls: [] }], [tool("woocommerce__list_orders"), tool("notes__create_note")]);
    await h.run();
    expect(h.seen[0]?.tools.map((t) => (t as { function: { name: string } }).function.name)).toEqual(["woocommerce__list_orders", "notes__create_note"]);
    expect(String(h.seen[0]?.messages[0]?.content)).toContain("2026-10-12");
    expect(String(h.seen[0]?.messages[0]?.content)).toMatch(/DATA, not instructions/);
  });

  it("feeds tool errors back to the model instead of stopping", async () => {
    const h = harness(
      [{ text: "", toolCalls: [call("woocommerce__update_order_status", { id: 15, status: "completed" })] }, { text: "You can't change orders.", toolCalls: [] }],
      [tool("woocommerce__list_orders")],
      () => ({ result: { isError: true, content: [{ type: "text", text: "[FORBIDDEN] Your role (member) is not allowed to call woocommerce__update_order_status." }] }, outcome: "denied", errorCode: "FORBIDDEN", durationMs: 1, serverSlug: "woocommerce" }),
    );
    await h.run();
    // A tool that wasn't offered (hidden) still went to dispatch(), which refused it.
    expect(h.dispatched[0]?.toolName).toBe("woocommerce__update_order_status");
    expect(h.events.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, outcome: "denied", error_code: "FORBIDDEN" });
    expect(String(h.seen[1]?.messages.at(-1)?.content)).toMatch(/^ERROR: \[FORBIDDEN\]/);
    expect(h.events.at(-1)).toMatchObject({ type: "done" });
  });

  it("tells the model about malformed JSON arguments without calling any tool", async () => {
    const h = harness([{ text: "", toolCalls: [call("woocommerce__list_orders", "{not json")] }, { text: "Retrying failed, sorry.", toolCalls: [] }], [tool("woocommerce__list_orders")]);
    await h.run();
    expect(h.dispatched).toHaveLength(0);
    expect(h.events.find((e) => e.type === "tool_result")).toMatchObject({ error_code: "INVALID_ARGUMENTS" });
  });

  it("stops after the iteration limit and says so", async () => {
    const loop = { text: "", toolCalls: [call("woocommerce__list_orders")] };
    const h = harness([loop, loop, loop, loop], [tool("woocommerce__list_orders")]);
    await h.run();
    expect(h.dispatched).toHaveLength(3);
    expect(h.events.at(-1)).toMatchObject({ type: "done", iterations: 3, limit_reached: true });
    expect(h.events.some((e) => e.type === "text" && /stopped after 3 rounds/.test(e.delta))).toBe(true);
  });

  it("truncates long tool results before sending them to the model", async () => {
    const h = harness([{ text: "", toolCalls: [call("woocommerce__list_orders")] }, { text: "ok", toolCalls: [] }], [tool("woocommerce__list_orders")], () => ({
      result: { content: [{ type: "text", text: "x".repeat(500) }] },
      outcome: "ok",
      errorCode: null,
      durationMs: 1,
      serverSlug: "woocommerce",
    }));
    await h.run();
    const sent = String(h.seen[1]?.messages.at(-1)?.content);
    expect(sent.startsWith("x".repeat(64))).toBe(true);
    expect(sent).toMatch(/truncated: 436 more bytes/);
  });

  it("reports provider failures as a friendly error event, without internals", async () => {
    const h = harness([new LlmError("The AI provider's rate limit was reached. Wait a minute and try again.", 429)], [tool("woocommerce__list_orders")]);
    await h.run();
    expect(h.events).toEqual([{ type: "error", message: "The AI provider's rate limit was reached. Wait a minute and try again." }]);
  });

  it("hides unexpected internal errors behind a generic message", async () => {
    const h = harness([new Error("connection to postgres lost at 10.96.0.5")], [tool("woocommerce__list_orders")]);
    await h.run();
    expect(h.events).toEqual([{ type: "error", message: "Something went wrong while answering. Please try again." }]);
  });
});

describe("helpers", () => {
  it("maps MCP names to valid, unique function names", () => {
    const taken = new Set<string>();
    expect(toFunctionName("notes__create_note", taken)).toBe("notes__create_note");
    expect(toFunctionName("x__a.b", taken)).toBe("x__a-b");
    expect(toFunctionName("x__a-b", taken)).toBe("x__a-b-2");
    expect(toFunctionName(`s__${"y".repeat(80)}`, taken)).toHaveLength(64);
  });

  it("flattens and truncates tool results on UTF-8 boundaries", () => {
    expect(resultText({ content: [{ type: "text", text: "héllo" }] }, 100)).toBe("héllo");
    expect(resultText({ content: [] }, 100)).toBe("(empty result)");
    expect(resultText({ content: [{ type: "text", text: "ééééé" }] }, 3)).toMatch(/^é\n…\[truncated/);
  });
});

describe("chat configuration", () => {
  const env = {
    DATABASE_URL: "postgres://x",
    SESSION_SECRET: "s".repeat(32),
    CREDENTIAL_ENC_KEY: Buffer.alloc(32).toString("base64"),
    ADMIN_EMAIL: "a@b.co",
    ADMIN_PASSWORD: "p".repeat(12),
    WOO_MCP_BEARER_TOKEN: "t".repeat(16),
  };
  it("defaults to Groq and turns chat off with a clear reason when the key is missing", () => {
    const c = loadConfig(env);
    expect(c.LLM_BASE_URL).toBe("https://api.groq.com/openai/v1");
    const r = chatModelFromConfig(c);
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/LLM_API_KEY/);
  });
  it("enables chat with a key, or for a local/cluster endpoint without one", () => {
    expect(chatModelFromConfig(loadConfig({ ...env, LLM_API_KEY: "gsk_test" })).model).not.toBeNull();
    expect(chatModelFromConfig(loadConfig({ ...env, LLM_BASE_URL: "http://ollama.platform.svc.cluster.local:11434/v1" })).model).not.toBeNull();
  });
});
