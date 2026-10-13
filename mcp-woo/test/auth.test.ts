import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { tokensEqual } from "../src/auth.js";

describe("tokensEqual", () => {
  it("accepts the same token and rejects others, including different lengths", () => {
    expect(tokensEqual("abc123", "abc123")).toBe(true);
    expect(tokensEqual("abc124", "abc123")).toBe(false);
    expect(tokensEqual("abc", "abc123")).toBe(false);
    expect(tokensEqual("", "abc123")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("fails fast on a missing WC_BASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/WC_BASE_URL/);
  });

  it("applies defaults and trims trailing slashes", () => {
    const c = loadConfig({ WC_BASE_URL: "http://wordpress.store.svc.cluster.local/" });
    expect(c).toMatchObject({
      port: 8080,
      wcTimeoutMs: 8000,
      wcBaseUrl: "http://wordpress.store.svc.cluster.local",
      wcSignatureBaseUrl: "http://wordpress.store.svc.cluster.local",
    });
  });
});
