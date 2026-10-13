import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { DispatchResult } from "../router/dispatch.js";

/**
 * Prometheus metrics (stand-out B), served on a separate port (METRICS_PORT) that the
 * Ingress never routes to; the NetworkPolicy limits it to the cluster.
 *
 *   mcp_gateway_tool_calls_total{server,tool,outcome}      counter
 *   mcp_gateway_tool_call_duration_seconds{server}         histogram
 *   mcp_gateway_upstream_up{server}                        gauge, 1 = connected
 *   mcp_gateway_tool_errors_total{code}                    counter
 *
 * Label values are bounded: server is a registered slug, tool a name that upstream
 * actually exposes, code one of the fixed error codes. A name a caller made up (an
 * unknown tool or server) is counted under "(unknown)", so callers can't create series.
 */
export const UNKNOWN = "(unknown)";

export interface UpstreamGaugeSource {
  /** Every registered upstream with its current status, read at scrape time. */
  upstreams(): Promise<{ slug: string; up: boolean }[]>;
}

export class GatewayMetrics {
  readonly registry = new Registry();
  private readonly calls: Counter<"server" | "tool" | "outcome">;
  private readonly duration: Histogram<"server">;
  private readonly errors: Counter<"code">;

  constructor(source: UpstreamGaugeSource, opts: { processMetrics?: boolean } = {}) {
    const registers = [this.registry];
    this.calls = new Counter({
      name: "mcp_gateway_tool_calls_total",
      help: "Tool calls through dispatch(), from /mcp and the chat agent.",
      labelNames: ["server", "tool", "outcome"],
      registers,
    });
    this.duration = new Histogram({
      name: "mcp_gateway_tool_call_duration_seconds",
      help: "Tool call duration as measured by dispatch(), including failures.",
      labelNames: ["server"],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    });
    this.errors = new Counter({
      name: "mcp_gateway_tool_errors_total",
      help: "Failed tool calls by error code (FORBIDDEN, TIMEOUT, SERVER_UNREACHABLE, ...).",
      labelNames: ["code"],
      registers,
    });
    new Gauge({
      name: "mcp_gateway_upstream_up",
      help: "1 if the gateway is connected to the upstream MCP server, else 0 (disabled, connecting, unreachable).",
      labelNames: ["server"],
      registers,
      async collect() {
        // Rebuilt on every scrape, so a deleted upstream's series disappears.
        const list = await source.upstreams();
        this.reset();
        for (const u of list) this.set({ server: u.slug }, u.up ? 1 : 0);
      },
    });
    if (opts.processMetrics ?? true) collectDefaultMetrics({ register: this.registry, prefix: "mcp_gateway_" });
  }

  /** Called once per dispatch() result. */
  recordCall(toolName: string, r: DispatchResult): void {
    const server = r.serverSlug ?? UNKNOWN;
    const tool = r.serverSlug === null || r.errorCode === "TOOL_NOT_FOUND" ? UNKNOWN : toolName;
    this.calls.inc({ server, tool, outcome: r.outcome });
    this.duration.observe({ server }, r.durationMs / 1000);
    if (r.errorCode) this.errors.inc({ code: r.errorCode });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
