import type { ExposedTool } from "../upstream/types.js";
import type { UpstreamRef } from "./dispatch.js";
import type { PermissionPolicy, Role } from "./permissions.js";

export interface AggregateDeps {
  listEnabledUpstreams(): Promise<UpstreamRef[]>;
  toolsFor(upstream: UpstreamRef): Promise<ExposedTool[]>;
  loadPolicy(): Promise<PermissionPolicy>;
  /** Max wait per upstream; a slower one is skipped for this listing only. */
  perUpstreamTimeoutMs: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("listing timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The tool list a user sees, used by both /mcp tools/list and the chat agent.
 * Upstreams are queried in parallel with allSettled and a per-upstream deadline, so one
 * dead or slow upstream never blocks or fails the listing from the others. Tools the
 * user's role can't call are removed, so they're never offered to a client or the model.
 */
export async function aggregateTools(role: Role, deps: AggregateDeps): Promise<ExposedTool[]> {
  const [upstreams, policy] = await Promise.all([deps.listEnabledUpstreams(), deps.loadPolicy()]);
  const settled = await Promise.allSettled(upstreams.map((u) => withTimeout(deps.toolsFor(u), deps.perUpstreamTimeoutMs)));
  const tools: ExposedTool[] = [];
  for (const s of settled) if (s.status === "fulfilled") tools.push(...s.value);
  return tools.filter((t) => policy.isAllowed(role, t.exposedName)).sort((a, b) => a.exposedName.localeCompare(b.exposedName));
}
