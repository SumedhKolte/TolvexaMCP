import { describe, expect, it } from "vitest";
import { runChat, type ChatEvent } from "../src/chat/agent.js";
import type { ChatMessage, ChatModel, ModelTurn } from "../src/chat/model.js";
import { createMasker, partialTokenStart, pseudonymKey, PseudonymVault } from "../src/chat/privacy.js";

const key = pseudonymKey("s".repeat(32));

/** An order as mcp-woo's get_order returns it. */
const order = {
  id: 15,
  status: "processing",
  total: "42.00",
  date_created: "2026-10-12T09:14:02",
  billing: {
    name: "John Doe",
    email: "john.doe@example.com",
    phone: "+1 555 123 4567",
    address: { street: "12 Elm Street, Apt 4", city: "Springfield", state: "IL", postcode: "62701", country: "US" },
  },
  customer_note: "Please call John Doe at (555) 123-4567 or mail jd@other.org before delivery.",
  line_items: [{ name: "QA Hoodie", quantity: 2 }],
};
const asResult = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("customer-data masking", () => {
  it("pseudonymizes names and emails, hides phones and streets, keeps city/state/postcode", () => {
    const m = createMasker(key, new PseudonymVault());
    const masked = JSON.parse(textOf(m.maskResult(asResult(order))));
    expect(masked.billing.name).toMatch(/^Customer_\d{6}$/);
    const num = masked.billing.name.slice("Customer_".length);
    expect(masked.billing.email).toBe(`customer_${num}@masked.invalid`);
    expect(masked.billing.phone).toBe("[phone hidden]");
    expect(masked.billing.address).toEqual({ city: "Springfield", state: "IL", postcode: "62701", country: "US" });
    // Product names, totals, dates and IDs are business data, not customer data.
    expect(masked.line_items[0].name).toBe("QA Hoodie");
    expect(masked).toMatchObject({ id: 15, total: "42.00", date_created: "2026-10-12T09:14:02" });
    // Free text: the known name, any email and the phone number are caught.
    expect(masked.customer_note).toBe(`Please call Customer_${num} at [phone hidden] or mail ${masked.customer_note.match(/customer_\d{6}@masked\.invalid/)?.[0]} before delivery.`);
    const all = JSON.stringify(masked);
    for (const secret of ["John", "Doe", "john.doe", "555", "Elm", "jd@other.org"]) expect(all).not.toContain(secret);
  });

  it("gives a customer the same pseudonym every time, and different customers different ones", () => {
    const a = createMasker(key, new PseudonymVault());
    const b = createMasker(key, new PseudonymVault()); // another request, empty vault
    const first = JSON.parse(textOf(a.maskResult(asResult(order)))).billing.name;
    expect(JSON.parse(textOf(b.maskResult(asResult(order)))).billing.name).toBe(first);
    const other = JSON.parse(textOf(a.maskResult(asResult({ billing: { name: "Jane Roe", email: "jane@example.com" } })))).billing.name;
    expect(other).not.toBe(first);
  });

  it("handles first_name/last_name records and leaves product 'name' fields alone", () => {
    const m = createMasker(key, new PseudonymVault());
    const masked = JSON.parse(textOf(m.maskResult(asResult({ customer: { first_name: "Ada", last_name: "Lovelace", company: "Analytical Ltd" }, product: { name: "Sticker Pack" } }))));
    expect(masked.customer.first_name).toMatch(/^Customer_\d{6}$/);
    expect(masked.customer).not.toHaveProperty("last_name");
    expect(masked.customer).not.toHaveProperty("company");
    expect(masked.product.name).toBe("Sticker Pack");
    expect(m.unmask(`Hello ${masked.customer.first_name}`)).toBe("Hello Ada Lovelace");
  });

  it("masks known customers in history text and unmasks only what this vault knows", () => {
    const vault = new PseudonymVault();
    const m = createMasker(key, vault);
    const name = JSON.parse(textOf(m.maskResult(asResult(order)))).billing.name as string;
    expect(m.maskText("What else did john  doe buy?")).toBe(`What else did ${name} buy?`);
    expect(m.unmask(`${name} paid.`)).toBe("John Doe paid.");
    expect(m.unmask(`${name.replace("_", " _")} paid.`)).toBe("John Doe paid."); // stray space from the model
    expect(m.unmask("Customer_999999 is unknown")).toBe("Customer_999999 is unknown");
    // A different user's vault can't reveal it.
    expect(createMasker(key, new PseudonymVault()).unmask(name)).toBe(name);
  });

  it("leaves non-JSON results readable while scrubbing them", () => {
    const m = createMasker(key, new PseudonymVault());
    expect(textOf(m.maskResult({ content: [{ type: "text", text: "Contact: someone@example.org, +44 20 7946 0958" }] }))).toMatch(
      /^Contact: customer_\d{6}@masked\.invalid, \[phone hidden\]$/,
    );
  });

  it("never splits a pseudonym across streamed deltas", () => {
    const vault = new PseudonymVault();
    const m = createMasker(key, vault);
    const name = JSON.parse(textOf(m.maskResult(asResult(order)))).billing.name as string;
    const s = m.streamUnmasker();
    const text = `Order #15 is from ${name}, who paid 42.00.`;
    let shown = "";
    for (const ch of text) shown += s.push(ch); // worst case: one character per delta
    shown += s.flush();
    expect(shown).toBe("Order #15 is from John Doe, who paid 42.00.");
    expect(partialTokenStart("from Custo")).toBe(5);
    expect(partialTokenStart("mail customer_123456@masked")).toBe(5); // "d" in "masked" is a letter
    // Emails streamed in pieces are unmasked too.
    const email = JSON.parse(textOf(m.maskResult(asResult(order)))).billing.email as string;
    const e = m.streamUnmasker();
    expect(e.push(email.slice(0, 22)) + e.push(email.slice(22)) + e.flush()).toBe("john.doe@example.com");
    expect(partialTokenStart("abc")).toBe(3);
  });
});

describe("chat agent with masking", () => {
  it("sends the provider masked data, shows the user real data, and returns model_text for history", async () => {
    const seen: ChatMessage[][] = [];
    const turns: ModelTurn[] = [
      { text: "", toolCalls: [{ id: "c1", name: "woocommerce__get_order", arguments: '{"id":15}' }] },
      { text: "", toolCalls: [] }, // replaced below once the pseudonym is known
    ];
    const model: ChatModel = {
      async complete(messages, _tools, { onText }) {
        seen.push(structuredClone(messages));
        const t = turns.shift() as ModelTurn;
        if (seen.length === 2) {
          const pseudonym = String(messages.at(-1)?.content).match(/Customer_\d{6}/)?.[0];
          t.text = `Order 15 is from ${pseudonym}.`;
          for (const piece of [t.text.slice(0, 20), t.text.slice(20)]) onText(piece);
        }
        return t;
      },
    };
    const events: ChatEvent[] = [];
    await runChat(
      { user: { id: "u1", role: "admin", email: "a@x" }, history: [{ role: "user", content: "Who placed order 15? Is it john.doe@example.com?" }], signal: new AbortController().signal, emit: (e) => events.push(e) },
      {
        model,
        listTools: async () => [],
        dispatch: async () => ({ result: asResult(order), outcome: "ok", errorCode: null, durationMs: 5, serverSlug: "woocommerce" }),
        maxIterations: 3,
        maxResultBytes: 8192,
        masker: createMasker(key, new PseudonymVault()),
      },
    );
    const sentToProvider = JSON.stringify(seen);
    expect(sentToProvider).not.toContain("John Doe");
    expect(sentToProvider).not.toContain("john.doe@example.com"); // the user's own message was masked too
    expect(sentToProvider).not.toContain("Elm Street");
    expect(String(seen[0]?.[0]?.content)).toMatch(/pseudonyms like Customer_/);

    const shown = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(shown).toBe("Order 15 is from John Doe.");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ preview: expect.stringContaining("John Doe") });
    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(done.model_text).toMatch(/^Order 15 is from Customer_\d{6}\.$/);
  });
});
