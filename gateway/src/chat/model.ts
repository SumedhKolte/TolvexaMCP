import OpenAI, { APIError } from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * The only interface the chat agent needs from an LLM. Any OpenAI-compatible endpoint
 * works (Groq, Gemini, Ollama, ...): only LLM_BASE_URL / LLM_MODEL / LLM_API_KEY change.
 * Tests use a scripted fake.
 */
export type ChatMessage = ChatCompletionMessageParam;
export type ToolSpec = ChatCompletionTool;

export interface ModelToolCall {
  id: string;
  name: string;
  /** Raw JSON text as produced by the model (may be invalid). */
  arguments: string;
}

export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
}

export interface ChatModel {
  /** Streams text deltas through onText and resolves with the complete turn. */
  complete(messages: ChatMessage[], tools: ToolSpec[], opts: { signal: AbortSignal; onText: (delta: string) => void }): Promise<ModelTurn>;
}

/** User-facing explanation of a provider failure. Never includes the key or raw bodies. */
export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function describeLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof APIError) {
    const s = err.status;
    const body = JSON.stringify((err as { error?: unknown }).error ?? "");
    if (s === 401 || s === 403) return new LlmError("The AI provider rejected the API key. An admin needs to check LLM_API_KEY.", s);
    if (s === 404) return new LlmError("The configured AI model wasn't found at the provider. An admin needs to check LLM_MODEL.", s);
    if (s === 429) return new LlmError("The AI provider's rate limit was reached. Wait a minute and try again.", s);
    if (s === 400 && /tool_use_failed|tool call/i.test(body)) {
      return new LlmError("The model produced a malformed tool call. Try rephrasing your question.", s);
    }
    if (s !== undefined && s >= 500) return new LlmError("The AI provider had an internal error. Try again shortly.", s);
    return new LlmError(`The AI provider refused the request (HTTP ${s ?? "?"}).`, s);
  }
  const name = (err as Error)?.name;
  if (name === "AbortError" || name === "APIUserAbortError") return new LlmError("Request cancelled.");
  if (name === "APIConnectionTimeoutError") return new LlmError("The AI provider didn't answer in time. Try again.");
  return new LlmError("Can't reach the AI provider right now.");
}

export interface OpenAiCompatibleOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  /** Sent as `reasoning_effort` for reasoning models (e.g. "low" for gpt-oss); omitted if unset. */
  reasoningEffort?: "low" | "medium" | "high";
}

export class OpenAiCompatibleModel implements ChatModel {
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      // Local providers (Ollama) need no key, but the SDK requires a non-empty string.
      apiKey: opts.apiKey || "not-needed",
      timeout: opts.timeoutMs,
      maxRetries: 1,
    });
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], opts: { signal: AbortSignal; onText: (d: string) => void }): Promise<ModelTurn> {
    let text = "";
    // Tool calls arrive in fragments, keyed by index: id/name once, arguments in pieces.
    const calls = new Map<number, ModelToolCall>();
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.opts.model,
          messages,
          ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
          temperature: 0.2,
          ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
          stream: true,
        },
        { signal: opts.signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          opts.onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
    } catch (err) {
      throw describeLlmError(err);
    }
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
    return { text, toolCalls };
  }
}
