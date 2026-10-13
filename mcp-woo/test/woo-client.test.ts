import { describe, expect, it } from "vitest";
import { sanitizeMessage, WooClient, WooError } from "../src/woo-client.js";

const CREDS = { consumerKey: "ck_0123456789abcdef0123", consumerSecret: "cs_fedcba9876543210fedc" };

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>;

function client(fetchImpl: FakeFetch, timeoutMs = 8000) {
  return new WooClient({
    baseUrl: "http://wordpress.store.svc.cluster.local",
    signatureBaseUrl: "http://store.localtest.me",
    timeoutMs,
    credentials: async () => CREDS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function catchWooError(p: Promise<unknown>): Promise<WooError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WooError) return e;
    throw e;
  }
  throw new Error("expected a WooError");
}

describe("WooClient", () => {
  it("calls the in-cluster URL, signs with OAuth in a header, and keeps secrets out of the URL", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const woo = client(async (url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get("authorization") ?? "";
      return jsonResponse(200, [], { "x-wp-total": "3", "x-wp-totalpages": "1" });
    });
    const r = await woo.get("/orders", { status: "any", after: undefined });
    expect(seenUrl).toBe("http://wordpress.store.svc.cluster.local/wp-json/wc/v3/orders?status=any");
    expect(seenAuth).toMatch(/^OAuth oauth_consumer_key="ck_0123456789abcdef0123"/);
    expect(seenUrl).not.toContain("ck_");
    expect(seenAuth).not.toContain(CREDS.consumerSecret);
    expect(r.total).toBe(3);
  });

  it("maps 404 to not_found", async () => {
    const e = await catchWooError(
      client(async () => jsonResponse(404, { code: "woocommerce_rest_shop_order_invalid_id", message: "Invalid ID." })).get("/orders/9999"),
    );
    expect(e.kind).toBe("not_found");
  });

  it("maps WooCommerce's 400 *_invalid_id (returned on updates) to not_found", async () => {
    const e = await catchWooError(
      client(async () => jsonResponse(400, { code: "woocommerce_rest_shop_order_invalid_id", message: "ID is invalid." })).put("/orders/9999", {
        status: "completed",
      }),
    );
    expect(e.kind).toBe("not_found");
  });

  it("maps 401 to auth without leaking key material", async () => {
    const e = await catchWooError(
      client(async () => jsonResponse(401, { message: `Consumer key ${CREDS.consumerKey} is invalid.` })).get("/orders"),
    );
    expect(e.kind).toBe("auth");
    expect(e.message).not.toContain(CREDS.consumerKey);
    expect(e.message).toContain("[redacted]");
  });

  it("never forwards an HTML error page", async () => {
    const e = await catchWooError(
      client(async () => new Response("<html><body><h1>Fatal error</h1> in /var/www/html/x.php</body></html>", { status: 500 })).get("/orders"),
    );
    expect(e.kind).toBe("upstream");
    expect(e.message).toBe("WooCommerce returned HTTP 500");
  });

  it("refuses to follow redirects", async () => {
    let redirectMode: RequestRedirect | undefined;
    const e = await catchWooError(
      client(async (_u, init) => {
        redirectMode = init.redirect;
        return new Response(null, { status: 301, headers: { location: "http://store.localtest.me/" } });
      }).get("/orders"),
    );
    expect(redirectMode).toBe("manual");
    expect(e.kind).toBe("upstream");
  });

  it("times out", async () => {
    const hang: FakeFetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const e = await catchWooError(client(hang, 50).get("/orders"));
    expect(e.kind).toBe("timeout");
  });

  it("reports network failures as unreachable without socket details", async () => {
    const e = await catchWooError(
      client(async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 10.96.1.2:80");
      }).get("/orders"),
    );
    expect(e.kind).toBe("unreachable");
    expect(e.message).toBe("WooCommerce is unreachable");
  });

  it("errors clearly when credentials are missing", async () => {
    const woo = new WooClient({
      baseUrl: "http://x",
      signatureBaseUrl: "http://x",
      timeoutMs: 1000,
      credentials: async () => undefined,
    });
    const e = await catchWooError(woo.get("/orders"));
    expect(e.kind).toBe("auth");
  });
});

describe("sanitizeMessage", () => {
  it("strips tags, redacts keys, and truncates", () => {
    expect(sanitizeMessage("<b>Bad</b> key ck_aaaaaaaaaaaaaaaaaaaa")).toBe("Bad key [redacted]");
    expect(sanitizeMessage("x".repeat(500)).length).toBe(200);
  });
});
