/**
 * Per-role tool permissions (stand-out A).
 *
 * Rules map an exposed tool name (e.g. "woocommerce__update_order_status") to the roles
 * allowed to call it. They live in the tool_permissions table and are read per request,
 * so an edit applies immediately on every replica.
 *
 *   - admin can always call every tool (spec section 10).
 *   - a member can call a tool if its rule lists "member", or, for a tool with no rule,
 *     if the default policy is "allow".
 *
 * The same check is used for tools/list (restricted tools are hidden) and in dispatch()
 * (restricted tools are rejected even when called directly by name).
 */
export type Role = "admin" | "member";

export interface PermissionRule {
  toolName: string;
  allowedRoles: Role[];
}

export interface PermissionPolicy {
  isAllowed(role: Role, exposedToolName: string): boolean;
}

export function makePolicy(rules: PermissionRule[], defaultMemberAccess: "allow" | "deny"): PermissionPolicy {
  const byTool = new Map(rules.map((r) => [r.toolName, new Set(r.allowedRoles)]));
  return {
    isAllowed(role, tool) {
      if (role === "admin") return true;
      const allowed = byTool.get(tool);
      if (allowed) return allowed.has(role);
      return defaultMemberAccess === "allow";
    },
  };
}

/**
 * Seeded on first boot (insert-if-missing, so admin edits are never overwritten).
 * Spec: members may read orders and products; only admins may create products and
 * change order status. slow__crash kills a pod, so it's admin-only too.
 */
export const DEFAULT_RULES: PermissionRule[] = [
  { toolName: "woocommerce__list_products", allowedRoles: ["admin", "member"] },
  { toolName: "woocommerce__list_orders", allowedRoles: ["admin", "member"] },
  { toolName: "woocommerce__get_order", allowedRoles: ["admin", "member"] },
  { toolName: "woocommerce__create_product", allowedRoles: ["admin"] },
  { toolName: "woocommerce__update_order_status", allowedRoles: ["admin"] },
  { toolName: "slow__crash", allowedRoles: ["admin"] },
];
