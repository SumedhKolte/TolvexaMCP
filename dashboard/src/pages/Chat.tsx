import { useQuery } from "@tanstack/react-query";
import { Loader2Icon, MessageSquarePlusIcon, SendIcon, ShieldAlertIcon, ShieldCheckIcon, SquareIcon, WrenchIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { OutcomeBadge } from "@/components/Badges";
import { PageHeader } from "@/components/Layout";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, type Outcome, type Tool } from "@/lib/api";
import { streamChat, type ChatEvent, type ChatTurnMessage } from "@/lib/chat";
import { useMe } from "@/lib/session";
import { formatDuration } from "@/lib/utils";

interface ToolCallView {
  id: string;
  name: string;
  server: string | null;
  args: string | null;
  status: "running" | "done";
  ok?: boolean;
  outcome?: string;
  errorCode?: string | null;
  durationMs?: number;
  preview?: string;
}

/**
 * `content` is what the user sees (real customer names). `modelContent` is the same answer
 * as the model wrote it, with customers still masked; that is what goes back as history,
 * so real names shown here are never sent to the AI provider on the next turn.
 */
interface ChatMessageView extends ChatTurnMessage {
  modelContent?: string;
}

interface ChatState {
  messages: ChatMessageView[];
  toolCalls: ToolCallView[]; // the current (latest) turn only
  streaming: boolean;
  error: string | null;
}

const EMPTY: ChatState = { messages: [], toolCalls: [], streaming: false, error: null };

/**
 * Chat state lives above the routes, so a conversation survives switching pages. It's
 * memory-only: a reload starts fresh, and nothing is stored on the server.
 */
const ChatContext = createContext<{
  state: ChatState;
  send(text: string): void;
  stop(): void;
  reset(): void;
} | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || state.streaming) return;
      const history: ChatMessageView[] = [...state.messages, { role: "user", content }];
      // Keep the request bounded (the gateway accepts at most 40 messages).
      const payload: ChatTurnMessage[] = history.slice(-20).map((m) => ({ role: m.role, content: m.modelContent ?? m.content }));
      setState({ messages: [...history, { role: "assistant", content: "" }], toolCalls: [], streaming: true, error: null });
      const abort = new AbortController();
      abortRef.current = abort;

      const onEvent = (e: ChatEvent) =>
        setState((s) => {
          const messages = [...s.messages];
          const last = messages[messages.length - 1] as ChatMessageView;
          switch (e.type) {
            case "text":
              messages[messages.length - 1] = { ...last, content: last.content + e.delta };
              return { ...s, messages };
            case "tool_call":
              return { ...s, toolCalls: [...s.toolCalls, { id: e.id, name: e.name, server: e.server, args: e.args_summary, status: "running" }] };
            case "tool_result":
              return {
                ...s,
                toolCalls: s.toolCalls.map((t) =>
                  t.id === e.id
                    ? { ...t, status: "done", ok: e.ok, outcome: e.outcome, errorCode: e.error_code, durationMs: e.duration_ms, preview: e.preview }
                    : t,
                ),
              };
            case "error":
              return { ...s, error: e.message };
            case "done":
              if (e.model_text !== undefined) messages[messages.length - 1] = { ...last, modelContent: e.model_text };
              return { ...s, messages };
          }
        });

      streamChat(payload, onEvent, abort.signal)
        .catch((err: unknown) => {
          if ((err as Error)?.name === "AbortError") return;
          setState((s) => ({ ...s, error: errorMessage(err) }));
        })
        .finally(() =>
          setState((s) => {
            // Drop an empty assistant bubble (e.g. the request failed before any text).
            const last = s.messages[s.messages.length - 1];
            const messages = last?.role === "assistant" && !last.content ? s.messages.slice(0, -1) : s.messages;
            return { ...s, messages, streaming: false };
          }),
        );
    },
    [state.messages, state.streaming],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(EMPTY);
  }, []);

  return <ChatContext.Provider value={{ state, send, stop, reset }}>{children}</ChatContext.Provider>;
}

function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("ChatProvider missing");
  return ctx;
}

export function ChatPage() {
  const { state, send, stop, reset } = useChat();
  const isAdmin = useMe().data?.role === "admin";
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api<{ tools: Tool[] }>("/api/tools").then((r) => r.tools) });
  const status = useQuery({
    queryKey: ["chat-status"],
    queryFn: () => api<{ available: boolean; reason: string | null; masking: boolean }>("/api/chat/status"),
  });

  // Block body on purpose: newer browsers return a Promise from scrollIntoView, and React
  // would try to call an effect's return value as its cleanup function.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages, state.toolCalls]);

  const suggestions = [
    "What orders came in today?",
    "List our products with prices.",
    "Summarize today's orders and save it as a team note.",
    ...(isAdmin ? ["Create a product called Sticker Pack priced at 4.99."] : []),
  ];

  const submit = () => {
    if (!input.trim() || state.streaming) return;
    send(input);
    setInput("");
  };

  return (
    <div className="flex h-[calc(100dvh-5.5rem)] flex-col md:h-[calc(100vh-3rem)]">
      <PageHeader title="Chat" description="Ask about the store and your team's tools. Every tool the assistant uses is checked against your role and logged.">
        <Button variant="outline" onClick={reset} disabled={state.messages.length === 0 && !state.error}>
          <MessageSquarePlusIcon /> New chat
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Conversation */}
        <Card className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
            {state.messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <div>
                  <p className="font-medium">What do you want to know?</p>
                  <p className="text-sm text-muted-foreground">
                    {tools.data ? `${tools.data.length} tools available to you` : "Loading your tools…"} ·{" "}
                    <Link to="/connect" className="underline">
                      see the list
                    </Link>
                  </p>
                </div>
                <div className="flex max-w-xl flex-wrap justify-center gap-2">
                  {suggestions.map((s) => (
                    <Button key={s} variant="outline" size="sm" className="h-auto py-1.5 whitespace-normal" onClick={() => send(s)}>
                      {s}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {state.messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{m.content}</div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-2.5">
                    {m.content ? (
                      <Markdown text={m.content} />
                    ) : (
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2Icon className="size-4 animate-spin" /> {state.toolCalls.some((t) => t.status === "running") ? "Using tools…" : "Thinking…"}
                      </span>
                    )}
                  </div>
                </div>
              ),
            )}
            {state.error && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {state.error}
              </p>
            )}
            <div ref={bottomRef} />
          </div>
          {status.data && !status.data.available && (
            <p role="status" className="mx-3 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {status.data.reason}
            </p>
          )}
          {state.toolCalls.length > 0 && (
            <details className="border-t px-3 py-2 text-sm lg:hidden">
              <summary className="flex cursor-pointer items-center gap-2 font-medium">
                <WrenchIcon className="size-4" /> Tool calls <Badge variant="secondary">{state.toolCalls.length}</Badge>
              </summary>
              <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                <ToolCallList toolCalls={state.toolCalls} streaming={state.streaming} />
              </div>
            </details>
          )}
          <p className="flex items-center gap-1.5 border-t px-4 pt-2 text-xs text-muted-foreground">
            {status.data?.masking === false ? (
              <>
                <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-600" />
                Customer data masking is off: tool results go to the AI provider as they are.
              </>
            ) : (
              <>
                <ShieldCheckIcon className="size-3.5 shrink-0" />
                Customer names, emails, phone numbers and street addresses are masked before anything is sent to the AI provider.
              </>
            )}
          </p>
          <form
            className="flex items-end gap-2 p-3 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask something… (Enter to send, Shift+Enter for a new line)"
              aria-label="Message"
              rows={2}
              maxLength={4000}
              className="max-h-40 resize-none"
            />
            {state.streaming ? (
              <Button type="button" variant="outline" onClick={stop} aria-label="Stop">
                <SquareIcon /> Stop
              </Button>
            ) : (
              <Button type="submit" disabled={!input.trim()} aria-label="Send">
                <SendIcon /> Send
              </Button>
            )}
          </form>
        </Card>

        {/* Tool calls of the current turn (wide screens; small screens get a strip above the input) */}
        <Card className="hidden w-80 shrink-0 flex-col lg:flex">
          <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
            <WrenchIcon className="size-4" /> Tool calls (this answer)
            {state.toolCalls.length > 0 && <Badge variant="secondary">{state.toolCalls.length}</Badge>}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            <ToolCallList toolCalls={state.toolCalls} streaming={state.streaming} />
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The tool calls of the latest answer: name, outcome, duration, arguments and result preview. */
function ToolCallList({ toolCalls, streaming }: { toolCalls: ToolCallView[]; streaming: boolean }) {
  return toolCalls.length === 0 ? (
    <p className="px-1 py-6 text-center text-sm text-muted-foreground">
      {streaming ? "No tools used yet." : "Tools the assistant uses for your latest question appear here."}
    </p>
  ) : (
    toolCalls.map((t) => (
      <details key={t.id} className="rounded-md border bg-background p-2.5 text-xs" open={t.status === "done" && t.ok === false}>
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between gap-2">
            <code className="truncate font-semibold" title={t.name}>
              {t.name.split("__")[1] ?? t.name}
            </code>
            {t.status === "running" ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="running" />
            ) : (
              <OutcomeBadge outcome={(t.outcome ?? "error") as Outcome} />
            )}
          </div>
          <div className="mt-1 flex justify-between text-muted-foreground">
            <span>{t.server ?? "?"}</span>
            <span>{t.durationMs !== undefined ? formatDuration(t.durationMs) : "…"}</span>
          </div>
        </summary>
        {t.args && <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-1.5 whitespace-pre-wrap">{t.args}</pre>}
        {t.preview && (
          <pre className={`mt-1.5 max-h-40 overflow-auto rounded p-1.5 whitespace-pre-wrap ${t.ok ? "bg-zinc-50" : "bg-red-50 text-red-800"}`}>{t.preview}</pre>
        )}
      </details>
    ))
  );
}
