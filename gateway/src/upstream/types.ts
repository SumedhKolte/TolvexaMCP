import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * connected   last connect / health check succeeded
 * unreachable last attempt failed (calls fail fast with SERVER_UNREACHABLE)
 * disabled    admin disabled it; never contacted
 * pending     enabled but not tried yet on this replica (first call/list will try)
 */
export type UpstreamStatus = "connected" | "unreachable" | "disabled" | "pending";

/** A tool as the gateway exposes it. */
export interface ExposedTool {
  /** <slug>__<local>, the name clients call. */
  exposedName: string;
  slug: string;
  /** Name the upstream knows the tool by. */
  originalName: string;
  /** True when "__" in the upstream name was rewritten to "_". */
  rewritten: boolean;
  title?: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  annotations?: Tool["annotations"];
}

/** Upstream answered too slowly (tool call or health check). Server is not marked down. */
export class UpstreamTimeoutError extends Error {
  override name = "UpstreamTimeoutError";
}

/** Couldn't talk to the upstream at all (network, HTTP error, closed connection). Marks it unreachable. */
export class UpstreamTransportError extends Error {
  override name = "UpstreamTransportError";
}

/** Upstream answered with a JSON-RPC error (e.g. invalid params). Server stays connected. */
export class UpstreamProtocolError extends Error {
  override name = "UpstreamProtocolError";
}

/** The upstream is known to be down; thrown without contacting it. */
export class UpstreamUnavailableError extends Error {
  override name = "UpstreamUnavailableError";
}
