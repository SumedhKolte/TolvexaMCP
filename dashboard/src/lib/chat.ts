import { ApiError } from "./api";

/** Events streamed by POST /api/chat (mirrors gateway/src/chat/agent.ts). */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; server: string | null; args_summary: string | null }
  | { type: "tool_result"; id: string; name: string; ok: boolean; outcome: string; error_code: string | null; duration_ms: number; preview: string }
  | { type: "done"; iterations: number; limit_reached: boolean; model_text?: string }
  | { type: "error"; message: string };

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Sends the conversation and calls onEvent for each server-sent event. EventSource can't
 * POST, so this reads the response body stream and parses `event:`/`data:` blocks itself.
 * Resolves when the stream ends; abort `signal` to stop (the gateway cancels the model).
 */
export async function streamChat(messages: ChatTurnMessage[], onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string } | undefined;
    try {
      err = ((await res.json()) as { error?: { code?: string; message?: string } }).error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Chat request failed (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue; // keep-alive comments
      try {
        onEvent(JSON.parse(data) as ChatEvent);
      } catch {
        /* ignore a malformed event rather than breaking the stream */
      }
    }
  }
}
