import { lookup as dnsLookupCb, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Agent, fetch as undiciFetch } from "undici";
import { checkResolvedAddresses, SsrfError, type SsrfPolicy } from "../registry/ssrf.js";
import type { Connector, UpstreamConfig, UpstreamSession } from "./manager.js";
import { UpstreamProtocolError, UpstreamTimeoutError, UpstreamTransportError } from "./types.js";

export const CLIENT_INFO = { name: "team-mcp-gateway", version: "0.1.0" };

/**
 * DNS lookup hook for the HTTP client: every NEW connection resolves the host here and
 * re-runs the SSRF address check on exactly the addresses the socket will use. That's
 * the defense against DNS rebinding (a name that resolved to a safe address at
 * registration and to 169.254.169.254 later). Limitation: a kept-alive connection isn't
 * re-resolved, which is fine because its peer address can't change.
 */
export function guardedLookup(policy: SsrfPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 4);
      try {
        checkResolvedAddresses(hostname, addresses.map((a) => a.address), policy);
      } catch (e) {
        return callback(e as Error, "", 4);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      }
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/** Headers the gateway adds; the credential never leaves the gateway in any other way. */
export function credentialHeaders(cfg: UpstreamConfig): Record<string, string> {
  if (!cfg.credential || cfg.credType === "none") return {};
  if (cfg.credType === "bearer") return { Authorization: `Bearer ${cfg.credential}` };
  if (cfg.credType === "header" && cfg.credHeaderName) return { [cfg.credHeaderName]: cfg.credential };
  return {};
}

/**
 * Sorts SDK and network errors into the three kinds the rest of the gateway handles:
 * timeout (server alive but slow), protocol (server answered with a JSON-RPC error),
 * transport (couldn't talk to it, so it gets marked unreachable).
 */
export function classifyError(err: unknown): Error {
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return new UpstreamTimeoutError(err.message);
    if (err.code === ErrorCode.ConnectionClosed) return new UpstreamTransportError(err.message);
    return new UpstreamProtocolError(err.message);
  }
  // fetch wraps the real reason in a cause chain ("fetch failed" -> ConnectTimeoutError,
  // ECONNREFUSED, our SsrfError, ...). Walk it so last_error says what actually happened.
  const chain: unknown[] = [];
  for (let c: unknown = err; c && chain.length < 5; c = (c as { cause?: unknown }).cause) chain.push(c);
  const ssrf = chain.find((c) => c instanceof SsrfError) as SsrfError | undefined;
  if (ssrf) return new UpstreamTransportError(`blocked by SSRF guard: ${ssrf.message}`);
  const top = (err as Error)?.message ?? String(err);
  const root = chain.at(-1) as { code?: string; message?: string } | undefined;
  const detail = root && root !== err ? (root.code ?? root.message) : undefined;
  return new UpstreamTransportError(detail ? `${top} (${detail})` : top);
}

export class HttpConnector implements Connector {
  private readonly agent: Agent;

  /**
   * @param tcpConnectTimeoutMs Max time to open a TCP connection. This is separate from the
   *   tool-call timeout: a Kubernetes Service with no ready endpoints silently DROPS new
   *   connections (verified: the Service hangs while the pod IP refuses in 2 ms), so
   *   without this a call to a crashed upstream would wait for the full tool timeout and
   *   be reported as a slow tool (TIMEOUT, server still "connected"). A failed connect is
   *   a transport error instead: the server is marked unreachable and later calls fail fast.
   */
  constructor(policy: SsrfPolicy, tcpConnectTimeoutMs = 3_000) {
    this.agent = new Agent({ connect: { lookup: guardedLookup(policy), timeout: tcpConnectTimeoutMs } });
  }

  async connect(cfg: UpstreamConfig, timeoutMs: number): Promise<UpstreamSession> {
    const agent = this.agent;
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: credentialHeaders(cfg) },
      fetch: ((url: string | URL, init?: RequestInit) =>
        undiciFetch(url, { ...(init as object), dispatcher: agent })) as unknown as typeof fetch,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw classifyError(err);
    }
    return {
      async listTools(t) {
        try {
          const tools = [];
          let cursor: string | undefined;
          // Follow pagination, bounded so a misbehaving upstream can't loop forever.
          for (let page = 0; page < 20; page++) {
            const res = await client.listTools(cursor ? { cursor } : {}, { timeout: t });
            tools.push(...res.tools);
            cursor = res.nextCursor;
            if (!cursor) break;
          }
          return tools;
        } catch (err) {
          throw classifyError(err);
        }
      },
      async callTool(name, args, t) {
        try {
          return (await client.callTool({ name, arguments: args }, undefined, { timeout: t })) as CallToolResult;
        } catch (err) {
          throw classifyError(err);
        }
      },
      async close() {
        await client.close();
      },
    };
  }
}
