import { describe, expect, it } from "vitest";
import { oauthAuthorizationHeader, rfc3986, signatureBaseString } from "../src/oauth1.js";

/**
 * Expected values were produced by WooCommerce 11.2.1's own PHP code
 * (wc_rest_urlencode_rfc3986, normalize_parameters, join_with_equals_sign, copied verbatim
 * from the installed plugin) on the same inputs: a cross-implementation check, not a
 * re-statement of our own algorithm. The search value covers every character where
 * encodeURIComponent and PHP rawurlencode disagree, plus space, '&' and '+'.
 */
const FIXTURE = {
  base:
    "GET&http%3A%2F%2Fstore.localtest.me%2Fwp-json%2Fwc%2Fv3%2Fproducts&oauth_consumer_key%3Dck_test%26oauth_nonce%3D0123456789abcdef0123456789abcdef%26oauth_signature_method%3DHMAC-SHA256%26oauth_timestamp%3D1791700000%26page%3D1%26per_page%3D20%26search%3DTeam%2520MCP%2520Mug%2520%2526%2520co%252B1%2520~%252A%2527%2521%2528x%2529%26status%3Dany",
  signature: "6jfeBN0Gk+8eJyI8GO8f+qHClHO6vK1zRFXXoe+HUJ0=",
};

const query = { search: "Team MCP Mug & co+1 ~*'!(x)", status: "any", per_page: "20", page: "1" };
const oauth = {
  oauth_consumer_key: "ck_test",
  oauth_nonce: "0123456789abcdef0123456789abcdef",
  oauth_signature_method: "HMAC-SHA256",
  oauth_timestamp: "1791700000",
};

describe("rfc3986", () => {
  it("matches PHP rawurlencode for characters encodeURIComponent leaves alone", () => {
    expect(rfc3986("!'()*")).toBe("%21%27%28%29%2A");
    expect(rfc3986("a b~c")).toBe("a%20b~c");
  });
});

describe("OAuth 1.0a signing (WooCommerce variant)", () => {
  it("builds the same signature base string as WooCommerce", () => {
    const base = signatureBaseString("GET", "http://store.localtest.me/wp-json/wc/v3/products", { ...query, ...oauth });
    expect(base).toBe(FIXTURE.base);
  });

  it("produces the same HMAC-SHA256 signature as WooCommerce", () => {
    const header = oauthAuthorizationHeader({
      method: "GET",
      signatureUrl: "http://store.localtest.me/wp-json/wc/v3/products",
      query,
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      nonce: oauth.oauth_nonce,
      timestamp: Number(oauth.oauth_timestamp),
    });
    const sig = /oauth_signature="([^"]+)"/.exec(header)?.[1];
    expect(sig && decodeURIComponent(sig)).toBe(FIXTURE.signature);
  });

  it("never puts the consumer secret in the header", () => {
    const header = oauthAuthorizationHeader({
      method: "GET",
      signatureUrl: "http://x/wp-json/wc/v3/orders",
      query: {},
      consumerKey: "ck_abc",
      consumerSecret: "cs_super_secret_value",
    });
    expect(header.startsWith("OAuth ")).toBe(true);
    expect(header).not.toContain("cs_super_secret_value");
  });

  it("uses a fresh nonce per request", () => {
    const make = () =>
      /oauth_nonce="([^"]+)"/.exec(
        oauthAuthorizationHeader({ method: "GET", signatureUrl: "http://x", query: {}, consumerKey: "k", consumerSecret: "s" }),
      )?.[1];
    const a = make();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(make()).not.toBe(a);
  });
});
