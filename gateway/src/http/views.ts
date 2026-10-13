import type { ApiKeyRow } from "../auth/api-keys.js";
import type { UserRow } from "../auth/users.js";
import type { UpstreamRow } from "../registry/service.js";
import type { UpstreamSnapshot } from "../upstream/manager.js";
import type { ExposedTool } from "../upstream/types.js";

/**
 * JSON shapes returned by the REST API (snake_case, as in the spec). Built from rows by
 * allow-listing fields, so a new column (or a secret one: password_hash, key_hash,
 * cred_encrypted) can never leak by accident.
 */

export const userView = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  disabled: u.disabledAt !== null,
  created_at: u.createdAt.toISOString(),
});

export const keyView = (k: ApiKeyRow) => ({
  id: k.id,
  user_id: k.userId,
  name: k.name,
  prefix: k.prefix,
  created_at: k.createdAt.toISOString(),
  last_used_at: k.lastUsedAt?.toISOString() ?? null,
  revoked_at: k.revokedAt?.toISOString() ?? null,
});

/**
 * status is one of connected | unreachable | disabled. A server not checked yet on this
 * replica ("pending") is reported as unreachable with an explanatory last_error.
 * Members don't get the URL or credential settings (they only need names and tools).
 */
export function serverView(row: UpstreamRow, snap: UpstreamSnapshot, isAdmin: boolean) {
  const status = !row.enabled ? "disabled" : snap.status === "connected" ? "connected" : "unreachable";
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    builtin: row.builtin,
    status,
    last_error: !row.enabled ? null : snap.status === "pending" ? "not checked yet" : snap.lastError,
    tool_count: row.enabled ? snap.toolCount : 0,
    last_checked_at: snap.lastCheckedAt?.toISOString() ?? null,
    credential_set: row.credEncrypted !== null,
    timeout_ms: row.timeoutMs,
    ...(isAdmin ? { url: row.url, cred_type: row.credType, cred_header_name: row.credHeaderName } : {}),
  };
}

export const toolView = (t: ExposedTool, extra: Record<string, unknown> = {}) => ({
  name: t.exposedName,
  server: t.slug,
  original_name: t.originalName,
  title: t.title ?? null,
  description: t.description,
  annotations: t.annotations ?? null,
  ...extra,
});
