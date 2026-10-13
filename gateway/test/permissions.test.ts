import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, makePolicy } from "../src/router/permissions.js";

describe("permission policy", () => {
  const policy = makePolicy(DEFAULT_RULES, "allow");

  it("allows members the read tools", () => {
    expect(policy.isAllowed("member", "woocommerce__list_orders")).toBe(true);
    expect(policy.isAllowed("member", "woocommerce__list_products")).toBe(true);
    expect(policy.isAllowed("member", "woocommerce__get_order")).toBe(true);
  });

  it("denies members the write tools", () => {
    expect(policy.isAllowed("member", "woocommerce__create_product")).toBe(false);
    expect(policy.isAllowed("member", "woocommerce__update_order_status")).toBe(false);
    expect(policy.isAllowed("member", "slow__crash")).toBe(false);
  });

  it("allows admins every tool, including ones with no rule", () => {
    for (const r of DEFAULT_RULES) expect(policy.isAllowed("admin", r.toolName)).toBe(true);
    expect(policy.isAllowed("admin", "anything__else")).toBe(true);
  });

  it("applies the default to tools without a rule", () => {
    expect(makePolicy([], "allow").isAllowed("member", "notes__create_note")).toBe(true);
    expect(makePolicy([], "deny").isAllowed("member", "notes__create_note")).toBe(false);
    expect(makePolicy([], "deny").isAllowed("admin", "notes__create_note")).toBe(true);
  });
});
