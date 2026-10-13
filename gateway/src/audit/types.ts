import type { AuditOutcome } from "../router/errors.js";

export type CallSource = "mcp" | "chat";

/** One row of audit_log, as written by dispatch(). */
export interface AuditEntry {
  userId: string | null;
  apiKeyId: string | null;
  source: CallSource;
  serverSlug: string | null;
  tool: string | null;
  argsSummary: string | null;
  durationMs: number;
  outcome: AuditOutcome;
  errorCode: string | null;
  errorMessage: string | null;
}
