/**
 * Typed client for the gateway REST API. Same-origin, cookie session (httpOnly; this code
 * never sees it). Errors from the API ({"error":{"code","message"}}) become ApiError so
 * the UI can show the gateway's own message, never a stack trace.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function api<T>(path: string, method: Method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Can't reach the gateway. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------- types

export type Role = "admin" | "member";

export interface User {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  created_at: string;
}

export interface UserWithKeys extends User {
  active_keys: number;
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type ServerStatus = "connected" | "unreachable" | "disabled";
export type CredType = "none" | "header" | "bearer";

export interface Server {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  builtin: boolean;
  status: ServerStatus;
  last_error: string | null;
  tool_count: number;
  last_checked_at: string | null;
  credential_set: boolean;
  timeout_ms: number;
  // admin only:
  url?: string;
  cred_type?: CredType;
  cred_header_name?: string | null;
}

export interface Tool {
  name: string;
  server: string;
  original_name: string;
  title: string | null;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
  allowed?: boolean;
}

export type Outcome = "ok" | "error" | "denied" | "timeout" | "unreachable" | "disabled";

export interface AuditItem {
  id: number;
  ts: string;
  userId: string | null;
  userEmail: string | null;
  apiKeyId: string | null;
  source: "mcp" | "chat";
  serverSlug: string | null;
  tool: string | null;
  argsSummary: string | null;
  durationMs: number;
  outcome: Outcome;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: number | null;
}

export interface ToolPermission {
  name: string;
  server: string;
  server_name: string | null;
  description: string | null;
  /** false: the tool has a rule but isn't listed right now (server down, disabled or removed). */
  available: boolean;
  roles: Role[];
  /** "rule": set by an admin (or seeded); "default": follows default_member_access. */
  source: "rule" | "default";
  updated_at: string | null;
}

export interface PermissionTable {
  default_member_access: "allow" | "deny";
  tools: ToolPermission[];
}

export interface ServerStats {
  server: string;
  calls: number;
  errors: number;
  error_rate: number;
  denied: number;
  avg_latency_ms: number | null;
}

export type StoreStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface Store {
  id: string;
  slug: string;
  name: string;
  status: StoreStatus;
  status_reason: string | null;
  url: string;
  tool_prefix: string;
  owner_email: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
}

export interface StoreLimits {
  enabled: boolean;
  per_user: number;
  total: number;
  mine: number;
  all: number;
  /** e.g. "http://store-{name}.localtest.me" */
  url_template: string;
}
