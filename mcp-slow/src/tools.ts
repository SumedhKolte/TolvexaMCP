import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallContext } from "./http.js";

/**
 * A deliberately badly behaved upstream, used to demonstrate the gateway's failure
 * handling (spec section 17). Through the gateway (slug "slow") the tools are slow__echo,
 * slow__flaky, and slow__crash.
 *
 *   echo   answers after a delay (default 15 s, longer than the gateway's 10 s timeout)
 *   flaky  fails about half the time
 *   crash  exits the process so the pod restarts. Registered ONLY when ALLOW_CRASH=true,
 *          and admin-only at the gateway (seeded tool_permissions rule). It exists so the
 *          demo can show "one upstream dies, the others keep working, the dashboard shows
 *          it unreachable until it recovers".
 */
export interface SlowOptions {
  echoDelayMs: number;
  flakyFailureRate: number;
  allowCrash: boolean;
  /** Injected for tests. */
  random?: () => number;
  exit?: (code: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const FAILURES = [
  "Random failure: the dice said no",
  "Random failure: simulated database deadlock",
  "Random failure: simulated rate limit from a downstream API",
  "Random failure: simulated out-of-memory in a worker",
];

/** Resolves after `ms`, or early if the request is cancelled. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

export function registerSlowTools(server: McpServer, opts: SlowOptions, ctx: CallContext): void {
  const random = opts.random ?? Math.random;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const sleep = opts.sleep ?? abortableSleep;

  server.registerTool(
    "echo",
    {
      title: "Slow echo",
      description:
        `Returns the message unchanged after a delay (default ${Math.round(opts.echoDelayMs / 1000)} s). ` +
        "Used to demonstrate gateway timeouts.",
      inputSchema: {
        message: z.string().max(2000).describe("Text to echo back."),
        delay_ms: z.number().int().min(0).max(60_000).optional().describe("Override the delay for this call (ms)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a, extra) => {
      ctx.tool = "echo";
      const delay = a.delay_ms ?? opts.echoDelayMs;
      await sleep(delay, extra.signal);
      ctx.outcome = "ok";
      return text(JSON.stringify({ echo: a.message, delayed_ms: delay }));
    },
  );

  server.registerTool(
    "flaky",
    {
      title: "Flaky tool",
      description: `Fails at random about ${Math.round(opts.flakyFailureRate * 100)}% of the time; otherwise returns "ok".`,
      inputSchema: { message: z.string().max(2000).optional().describe("Optional text, echoed on success.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      ctx.tool = "flaky";
      if (random() < opts.flakyFailureRate) {
        ctx.outcome = "error";
        const msg = FAILURES[Math.floor(random() * FAILURES.length)] ?? FAILURES[0];
        return { isError: true, content: [{ type: "text", text: msg as string }] };
      }
      ctx.outcome = "ok";
      return text(JSON.stringify({ status: "ok", message: a.message ?? null }));
    },
  );

  if (opts.allowCrash) {
    server.registerTool(
      "crash",
      {
        title: "Crash this server",
        description:
          "DEMO ONLY: terminates the mcp-slow process so its pod restarts. The server is unreachable until " +
          "Kubernetes brings it back. Admin-only at the gateway.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        ctx.tool = "crash";
        ctx.outcome = "ok";
        // Exit shortly AFTER the response is written, so the caller sees a clean answer.
        setTimeout(() => exit(1), 200).unref?.();
        return text("mcp-slow is crashing now; Kubernetes will restart it.");
      },
    );
  }
}
