import { describe, expect, it } from "vitest";
import { exposeToolName, parseToolName } from "../src/router/tool-name.js";

describe("parseToolName", () => {
  it("parses a valid name", () => {
    expect(parseToolName("woocommerce__list_orders")).toEqual({ slug: "woocommerce", tool: "list_orders" });
    expect(parseToolName("store-a__list_orders")).toEqual({ slug: "store-a", tool: "list_orders" });
  });

  it("returns null when there is no separator", () => {
    expect(parseToolName("list_orders")).toBeNull();
    expect(parseToolName("woocommerce_list_orders")).toBeNull();
  });

  it("splits on the FIRST separator only; extra '__' stay in the tool part", () => {
    expect(parseToolName("notes__a__b")).toEqual({ slug: "notes", tool: "a__b" });
  });

  it("rejects slugs with invalid characters or length", () => {
    expect(parseToolName("Woo__list")).toBeNull(); // uppercase
    expect(parseToolName("wo o__list")).toBeNull(); // space
    expect(parseToolName("w_x__list")).toBeNull(); // underscore not allowed in slugs
    expect(parseToolName("a__list")).toBeNull(); // 1 char
    expect(parseToolName(`${"a".repeat(31)}__list`)).toBeNull(); // 31 chars
    expect(parseToolName("__list")).toBeNull(); // empty slug
  });

  it("rejects an empty tool part", () => {
    expect(parseToolName("notes__")).toBeNull();
  });
});

describe("exposeToolName", () => {
  it("prefixes the slug", () => {
    expect(exposeToolName("notes", "create_note")).toEqual({ exposed: "notes__create_note", local: "create_note", rewritten: false });
  });

  it("rewrites '__' in upstream names to '_' and flags it", () => {
    expect(exposeToolName("x", "a__b")).toEqual({ exposed: "x__a_b", local: "a_b", rewritten: true });
    expect(exposeToolName("x", "a____b").local).toBe("a_b");
  });

  it("round-trips: an exposed name parses back to its slug and local name", () => {
    const e = exposeToolName("notes", "weird__name");
    expect(parseToolName(e.exposed)).toEqual({ slug: "notes", tool: "weird_name" });
  });
});
