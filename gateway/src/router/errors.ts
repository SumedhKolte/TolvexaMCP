/**
 * Stable error codes returned to MCP clients and the chat agent, and the audit outcome
 * each one is recorded as. Clients see them in the tool result text, e.g.
 *   "[SERVER_UNREACHABLE] woocommerce is not reachable right now."
 */
export const ERROR_CODES = {
  TOOL_NOT_FOUND: "error",
  SERVER_DISABLED: "disabled",
  SERVER_UNREACHABLE: "unreachable",
  FORBIDDEN: "denied",
  TIMEOUT: "timeout",
  UPSTREAM_ERROR: "error",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type AuditOutcome = "ok" | "error" | "denied" | "timeout" | "unreachable" | "disabled";

export function outcomeFor(code: ErrorCode): AuditOutcome {
  return ERROR_CODES[code];
}

/** Text shown to the caller: "[CODE] message". */
export function errorText(code: ErrorCode, message: string): string {
  return `[${code}] ${message}`;
}
