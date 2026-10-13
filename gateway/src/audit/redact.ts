/**
 * Builds the short, redacted args_summary stored in audit_log.
 *
 * - Values under keys that look sensitive (password, token, secret, key, auth, cookie,
 *   credential) are replaced with "[redacted]", at any depth.
 * - Long strings are cut to 40 characters (note bodies, descriptions).
 * - The whole summary is cut to 200 characters (spec).
 * The goal is "enough to see what was asked", never a copy of the payload.
 */
const SENSITIVE_KEY = /pass|secret|token|api[-_]?key|^key$|auth|cookie|credential|bearer/i;
const MAX_STRING = 40;
const MAX_TOTAL = 200;
const MAX_DEPTH = 4;

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

export function summarizeArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  let text: string;
  try {
    text = JSON.stringify(scrub(args, 0));
  } catch {
    return "[unserializable]";
  }
  if (text === "{}") return null;
  return text.length > MAX_TOTAL ? `${text.slice(0, MAX_TOTAL - 1)}…` : text;
}

/** Short single-line message for error_message columns and client-facing errors. */
export function truncateMessage(message: unknown, max = 200): string {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
