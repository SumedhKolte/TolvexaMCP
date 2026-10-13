import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorMessage } from "../src/lib/api";
import { formatDuration, formatShortDateTime, localInputToIso, maskedKey, relativeTime, slugify } from "../src/lib/utils";

describe("slugify (must match the gateway's rule)", () => {
  it.each([
    ["Notes", "notes"],
    ["My Notes Server!", "my-notes-server"],
    ["  Store A  ", "store-a"],
    ["x".repeat(40), "x".repeat(30)],
    ["Ünïcode — Tools", "n-code-tools"],
  ])("%s -> %s", (input, out) => expect(slugify(input)).toBe(out));
});

describe("api()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON on success and sends JSON bodies", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api("/api/x", "POST", { a: 1 })).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/x", expect.objectContaining({ method: "POST", credentials: "same-origin", body: '{"a":1}' }));
  });

  it("turns the gateway's {error:{code,message}} into ApiError with that message", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"code":"RATE_LIMITED","message":"Too many failed logins."}}', { status: 429 }));
    const err = await api("/api/auth/login", "POST", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", message: "Too many failed logins." });
  });

  it("never surfaces raw HTML or network internals", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    expect(errorMessage(await api("/api/x").catch((e: unknown) => e))).toBe("Request failed (HTTP 502)");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch: ECONNREFUSED 10.0.0.1");
    });
    expect(errorMessage(await api("/api/x").catch((e: unknown) => e))).toMatch(/^Can't reach the gateway/);
    expect(errorMessage(new Error("internal stack details"))).toBe("Something went wrong. Please try again.");
  });
});

describe("display helpers", () => {
  it("masks keys down to their prefix", () => expect(maskedKey("abcd1234")).toBe("wk_abcd1234_••••••••"));
  it("formats relative times", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime("2026-10-11T11:57:00Z", now)).toBe("3 min. ago");
  });
  it("converts datetime-local input to ISO with offset", () => {
    expect(localInputToIso("")).toBeUndefined();
    expect(localInputToIso("2026-10-11T09:30")).toMatch(/^2026-10-1\dT\d\d:30:00\.000Z$/);
  });
});

describe("audit table formatters (keep columns one line wide)", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(138)).toBe("138 ms");
    expect(formatDuration(10010)).toBe("10.0 s");
  });
  it("formats compact timestamps without the year", () => {
    const s = formatShortDateTime("2026-10-12T03:48:30Z");
    expect(s).not.toMatch(/2026/);
    expect(s).toMatch(/\d{2}:\d{2}:\d{2}$/);
  });
});

describe("chat stream parsing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("parses SSE blocks split across chunks and skips keep-alives", async () => {
    const { streamChat } = await import("../src/lib/chat");
    const chunks = [
      'event: tool_call\ndata: {"type":"tool_call","id":"c1","name":"woocommerce__list_orders","server":"woocommerce","args_summary":null}\n\n: keep-alive\n\nevent: te',
      'xt\ndata: {"type":"text","delta":"Hello"}\n\nevent: done\ndata: {"type":"done","iterations":1,"limit_reached":false}\n\n',
    ];
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const events: { type: string }[] = [];
    await streamChat([{ role: "user", content: "hi" }], (e) => events.push(e), new AbortController().signal);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "text", "done"]);
  });
  it("surfaces the gateway's error message (e.g. chat not configured)", async () => {
    const { streamChat } = await import("../src/lib/chat");
    vi.stubGlobal("fetch", async () => new Response('{"error":{"code":"CHAT_UNAVAILABLE","message":"Chat is not configured yet"}}', { status: 503 }));
    await expect(streamChat([{ role: "user", content: "hi" }], () => {}, new AbortController().signal)).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
  });
});
