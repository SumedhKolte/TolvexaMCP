import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { summarizeArgs, truncateMessage } from "../audit/redact.js";
import type { AuditEntry, CallSource } from "../audit/types.js";
import {
  UpstreamTimeoutError,
  UpstreamUnavailableError,
  type UpstreamStatus,
} from "../upstream/types.js";
import { errorText, outcomeFor, type AuditOutcome, type ErrorCode } from "./errors.js";
import type { PermissionPolicy, Role } from "./permissions.js";
import { parseToolName } from "./tool-name.js";

/**
 * dispatch(): the single path every tool call takes, from /mcp and from the chat agent.
 *
 * Steps (spec section 12), in this order:
 *   1. parse "<slug>__<tool>"                      -> TOOL_NOT_FOUND
 *   2. look up the upstream by slug                -> TOOL_NOT_FOUND
 *   3. upstream disabled                           -> SERVER_DISABLED   (outcome "disabled")
 *   4. upstream known to be down: fail FAST        -> SERVER_UNREACHABLE (outcome "unreachable")
 *   5. role may not call this exact tool           -> FORBIDDEN          (outcome "denied")
 *   6. call with the upstream's timeout            -> TIMEOUT / UPSTREAM_ERROR
 *   7. duration is measured for every outcome
 *   8. exactly one audit row is written for every outcome
 *   9. upstream isError results pass through unchanged (outcome "error")
 *
 * Every dependency is injected, so this file has no I/O of its own and is unit tested
 * in isolation (test/dispatch.test.ts).
 */

export interface DispatchUser {
  id: string;
  role: Role;
}

export interface DispatchRequest {
  user: DispatchUser;
  apiKeyId?: string | null;
  toolName: string;
  args: Record<string, unknown> | undefined;
  source: CallSource;
}

/** What dispatch needs to know about an upstream (from the registry). */
export interface UpstreamRef {
  id: string;
  slug: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface DispatchDeps {
  findUpstream(slug: string): Promise<UpstreamRef | null>;
  /** Current health as seen by this replica's upstream manager. */
  upstreamStatus(upstream: UpstreamRef): UpstreamStatus;
  /**
   * Maps the local part of an exposed name to the upstream's original tool name.
   * string: found. null: the upstream's tool list is known and doesn't contain it.
   * undefined: no tool list cached yet; the name is passed through as is.
   */
  resolveTool(upstream: UpstreamRef, localName: string): string | null | undefined;
  callTool(upstream: UpstreamRef, originalName: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  loadPolicy(): Promise<PermissionPolicy>;
  writeAudit(entry: AuditEntry): Promise<void>;
  /** Called when writing the audit row fails (the call result is still returned). */
  onAuditFailure?(err: unknown, entry: AuditEntry): void;
  now?(): number;
}

export interface DispatchResult {
  /** Always a valid MCP tool result; errors are isError results with "[CODE] message". */
  result: CallToolResult;
  outcome: AuditOutcome;
  errorCode: string | null;
  durationMs: number;
  serverSlug: string | null;
}

export async function dispatch(req: DispatchRequest, deps: DispatchDeps): Promise<DispatchResult> {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  const args = req.args ?? {};

  let serverSlug: string | null = null;

  const finish = async (
    result: CallToolResult,
    outcome: AuditOutcome,
    errorCode: string | null,
    errorMessage: string | null,
  ): Promise<DispatchResult> => {
    const durationMs = Math.max(0, Math.round(now() - start));
    const entry: AuditEntry = {
      userId: req.user.id,
      apiKeyId: req.apiKeyId ?? null,
      source: req.source,
      serverSlug,
      tool: req.toolName,
      argsSummary: summarizeArgs(args),
      durationMs,
      outcome,
      errorCode,
      errorMessage: errorMessage === null ? null : truncateMessage(errorMessage),
    };
    try {
      await deps.writeAudit(entry);
    } catch (err) {
      // The call has already happened (it may have changed data), so returning an error
      // now would mislead the caller. Report loudly instead (log + metric).
      deps.onAuditFailure?.(err, entry);
    }
    return { result, outcome, errorCode, durationMs, serverSlug };
  };

  const fail = (code: ErrorCode, message: string) =>
    finish({ isError: true, content: [{ type: "text", text: errorText(code, message) }] }, outcomeFor(code), code, message);

  // 1. Parse.
  const parsed = parseToolName(req.toolName);
  if (!parsed) return fail("TOOL_NOT_FOUND", `Unknown tool "${truncateMessage(req.toolName, 80)}".`);

  // 2. Look up.
  const upstream = await deps.findUpstream(parsed.slug);
  if (!upstream) return fail("TOOL_NOT_FOUND", `Unknown tool "${req.toolName}".`);
  serverSlug = upstream.slug;

  // 3. Disabled: never contacted.
  if (!upstream.enabled) return fail("SERVER_DISABLED", `${upstream.slug} is disabled by an administrator.`);

  // 4. Known down: fail fast, don't wait for a timeout.
  if (deps.upstreamStatus(upstream) === "unreachable") {
    return fail("SERVER_UNREACHABLE", `${upstream.slug} is not reachable right now.`);
  }

  // 5. Permission for this exact tool (also enforced here, not only by hiding it in lists).
  const policy = await deps.loadPolicy();
  if (!policy.isAllowed(req.user.role, req.toolName)) {
    return fail("FORBIDDEN", `Your role (${req.user.role}) is not allowed to call ${req.toolName}.`);
  }

  const original = deps.resolveTool(upstream, parsed.tool);
  if (original === null) return fail("TOOL_NOT_FOUND", `Unknown tool "${req.toolName}".`);

  // 6. Call.
  try {
    const result = await deps.callTool(upstream, original ?? parsed.tool, args, upstream.timeoutMs);
    if (result.isError) {
      // 9. The tool itself reported an error (e.g. "Order 9999 not found"): pass it through.
      const first = result.content?.find((c) => c.type === "text");
      return finish(result, "error", "TOOL_ERROR", first && "text" in first ? first.text : "tool returned an error");
    }
    return finish(result, "ok", null, null);
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) {
      return fail("TIMEOUT", `${req.toolName} did not respond within ${Math.round(upstream.timeoutMs / 1000)}s.`);
    }
    if (err instanceof UpstreamUnavailableError) {
      return fail("SERVER_UNREACHABLE", `${upstream.slug} is not reachable right now.`);
    }
    return fail("UPSTREAM_ERROR", `${upstream.slug} returned an error: ${truncateMessage((err as Error)?.message, 150)}`);
  }
}
