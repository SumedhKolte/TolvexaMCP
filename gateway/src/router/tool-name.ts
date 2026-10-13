/**
 * Tool naming scheme (docs/design.md, "Tool naming").
 *
 *   exposed name = <slug>__<upstreamToolName>      e.g. woocommerce__list_orders
 *
 * Slugs are unique and may not contain "__" (only [a-z0-9-]), so splitting on the FIRST
 * "__" is unambiguous and the same upstream tool name can never collide across servers.
 * Upstream tool names that themselves contain "__" are exposed with "__" -> "_".
 */

export const SEPARATOR = "__";

/** Spec: lowercase, [a-z0-9-], 2 to 30 characters. */
export const SLUG_RE = /^[a-z0-9-]{2,30}$/;

/**
 * Characters allowed in an upstream tool name. MCP recommends [A-Za-z0-9_.-]; anything
 * else (spaces, slashes, unicode) is rejected at listing time rather than guessed at.
 */
export const UPSTREAM_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ParsedToolName {
  slug: string;
  tool: string;
}

/** Splits on the first "__". Returns null if there's no separator, the slug is invalid, or the tool part is empty. */
export function parseToolName(name: string): ParsedToolName | null {
  const i = name.indexOf(SEPARATOR);
  if (i <= 0) return null;
  const slug = name.slice(0, i);
  const tool = name.slice(i + SEPARATOR.length);
  if (!SLUG_RE.test(slug) || tool.length === 0) return null;
  return { slug, tool };
}

export interface ExposedName {
  exposed: string;
  /** Name inside the exposed name (after the slug), possibly rewritten. */
  local: string;
  rewritten: boolean;
}

/** Builds the exposed name for an upstream tool, rewriting any "__" to "_". */
export function exposeToolName(slug: string, upstreamName: string): ExposedName {
  let local = upstreamName;
  while (local.includes(SEPARATOR)) local = local.replaceAll(SEPARATOR, "_");
  return { exposed: `${slug}${SEPARATOR}${local}`, local, rewritten: local !== upstreamName };
}
