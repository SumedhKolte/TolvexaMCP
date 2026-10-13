import { createHmac, hkdfSync } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Customer-data masking for the chat agent (decision D6.12). Everything the LLM provider
 * receives (tool results and the conversation history) is masked first:
 *
 *   - customer names  -> "Customer_402913"                 (pseudonym, reversible)
 *   - customer emails -> "customer_402913@masked.invalid"  (same number as the name)
 *   - phone numbers   -> "[phone hidden]"
 *   - street lines, company, IP address, user agent -> removed
 *     (city, state, postcode and country are kept: enough for shipping questions)
 *
 * Pseudonyms are deterministic (HMAC of the customer's email, or name, under a key derived
 * from SESSION_SECRET), so the same customer gets the same pseudonym on every turn and in
 * every request, and the model can refer back to them. The gateway keeps a per-user map
 * from pseudonym to real value in memory and swaps real values back in only on the text
 * streamed to that user's browser. The provider never sees the map.
 *
 * Masking is best effort for free text (e.g. a customer note): known names/emails, any
 * email address and common phone formats are caught; a name the store never returned as
 * a customer field is not.
 */

const NAME_KEYS = new Set(["name", "full_name", "first_name", "customer_name", "billing_name", "shipping_name"]);
const EMAIL_KEYS = new Set(["email", "billing_email", "customer_email"]);
const PHONE_KEYS = new Set(["phone", "billing_phone", "shipping_phone"]);
const DROP_KEYS = new Set(["last_name", "address_1", "address_2", "street", "line1", "line2", "company", "customer_ip_address", "customer_user_agent"]);
/** Objects under these keys describe a person (their `name` is a customer's name). */
const PERSON_PARENTS = new Set(["billing", "shipping", "customer"]);

// Models sometimes write "Customer _402913" (a stray space from tokenization): accept it.
const NAME_TOKEN = /\bCustomer ?_(\d{6})\b/g;
const EMAIL_TOKEN = /\bcustomer_(\d{6})@masked\.invalid\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// "+44 20 7946 0958", "(555) 123-4567", "555.123.4567": a leading + or a 3-3-4 grouping.
// Deliberately narrow so dates, totals and IDs are never caught.
const PHONE = /\+\d[\d\s().-]{6,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Per-user pseudonym map, in memory and bounded (oldest entries are dropped first). */
export class PseudonymVault {
  private readonly tokens = new Map<string, string>(); // token -> real value (as shown)
  private readonly values = new Map<string, string>(); // normalized real value -> token
  private readonly owners = new Map<string, string>(); // number -> identity it belongs to
  private pattern: RegExp | null = null;

  constructor(private readonly maxEntries = 5_000) {}

  ownerOf(num: string): string | undefined {
    return this.owners.get(num);
  }

  claim(num: string, identity: string): void {
    this.owners.set(num, identity);
  }

  tokenOf(value: string): string | undefined {
    return this.values.get(norm(value));
  }

  /** Real value for a pseudonym (email pseudonyms are looked up in lower case). */
  reveal(token: string): string | undefined {
    return this.tokens.get(token);
  }

  remember(token: string, value: string): void {
    if (!value.trim() || this.values.get(norm(value)) === token) return;
    this.tokens.set(token, value);
    this.values.set(norm(value), token);
    this.pattern = null;
    while (this.tokens.size > this.maxEntries) {
      const [oldest, real] = this.tokens.entries().next().value as [string, string];
      this.tokens.delete(oldest);
      this.values.delete(norm(real));
    }
    while (this.owners.size > this.maxEntries) this.owners.delete(this.owners.keys().next().value as string);
  }

  /** One regex matching every known real value (longest first), or null if none. */
  knownValues(): RegExp | null {
    if (this.pattern === null && this.values.size > 0) {
      const alts = [...this.values.keys()].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length);
      this.pattern = alts.length ? new RegExp(alts.map((v) => escapeRe(v).replace(/ /g, "\\s+")).join("|"), "gi") : null;
    }
    return this.pattern;
  }
}

export interface PiiMasker {
  /** The tool result as the model should see it. */
  maskResult(result: CallToolResult): CallToolResult;
  /** Free text (history messages) as the model should see it. */
  maskText(text: string): string;
  /** Real values back in, for text shown to the user. Unknown pseudonyms stay as they are. */
  unmask(text: string): string;
  /** Unmasks a stream of text deltas without splitting a pseudonym across two deltas. */
  streamUnmasker(): { push(delta: string): string; flush(): string };
}

export function pseudonymKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, "", "tolvexa chat pseudonyms v1", 32));
}

export function createMasker(key: Buffer, vault: PseudonymVault): PiiMasker {
  /** A stable 6-digit number for a customer identity (email, else name). */
  const numberFor = (identity: string): string => {
    for (let n = 0; ; n++) {
      const h = createHmac("sha256", key).update(`${n}:${identity}`).digest();
      const num = String(100_000 + (h.readUInt32BE(0) % 900_000));
      const owner = vault.ownerOf(num);
      if (owner === undefined || owner === identity) {
        vault.claim(num, identity);
        return num;
      }
    }
  };

  const emailToken = (email: string): string => {
    const known = vault.tokenOf(email);
    if (known) return known;
    const token = `customer_${numberFor(`email:${norm(email)}`)}@masked.invalid`;
    vault.remember(token, email.trim());
    return token;
  };

  const scrub = (text: string): string => {
    let out = text;
    const known = vault.knownValues();
    if (known) out = out.replace(known, (m) => vault.tokenOf(m) ?? m);
    return out.replace(EMAIL, (m) => (/@masked\.invalid$/i.test(m) ? m : emailToken(m))).replace(PHONE, "[phone hidden]");
  };

  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

  /** Gives every person record a pseudonym, before masking, so free text can use them too. */
  const register = (value: unknown, parentKey: string | null): void => {
    if (Array.isArray(value)) return value.forEach((v) => register(v, parentKey));
    if (!isRecord(value)) return;
    const person = parentKey !== null && PERSON_PARENTS.has(parentKey);
    const email = [...EMAIL_KEYS].map((k) => value[k]).find((v): v is string => typeof v === "string" && v.includes("@"));
    const first = typeof value.first_name === "string" ? value.first_name : "";
    const last = typeof value.last_name === "string" ? value.last_name : "";
    const fullName =
      [first, last].filter(Boolean).join(" ") ||
      (["full_name", "customer_name", "billing_name", "shipping_name", ...(person ? ["name"] : [])].map((k) => value[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined) ||
      "";
    if (email || fullName) {
      // Reuse a pseudonym the name or email already has, so a customer keeps one number.
      const existing = (email && vault.tokenOf(email)) || (fullName && vault.tokenOf(fullName)) || undefined;
      const num = existing?.match(/(\d{6})/)?.[1] ?? numberFor(email ? `email:${norm(email)}` : `name:${norm(fullName)}`);
      if (fullName) vault.remember(`Customer_${num}`, fullName.trim());
      if (email) vault.remember(`customer_${num}@masked.invalid`, email.trim());
    }
    for (const [k, v] of Object.entries(value)) register(v, k);
  };

  const mask = (value: unknown, parentKey: string | null): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map((v) => mask(v, parentKey));
    if (!isRecord(value)) return value;
    const person = parentKey !== null && PERSON_PARENTS.has(parentKey);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      if (PHONE_KEYS.has(k) && typeof v === "string") {
        out[k] = v ? "[phone hidden]" : v;
      } else if (k === "first_name" && typeof v === "string") {
        // first + last become one pseudonym in first_name (last_name is dropped).
        const full = [v, typeof value.last_name === "string" ? value.last_name : ""].filter(Boolean).join(" ");
        out[k] = full ? (vault.tokenOf(full) ?? scrub(full)) : v;
      } else if (NAME_KEYS.has(k) && (k !== "name" || person) && typeof v === "string") {
        out[k] = v ? (vault.tokenOf(v) ?? scrub(v)) : v;
      } else if (EMAIL_KEYS.has(k) && typeof v === "string") {
        out[k] = v ? emailToken(v) : v;
      } else {
        out[k] = mask(v, k);
      }
    }
    return out;
  };

  const maskJsonOrText = (text: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return scrub(text);
    }
    if (typeof parsed !== "object" || parsed === null) return scrub(text);
    register(parsed, null);
    return JSON.stringify(mask(parsed, null), null, 2);
  };

  const unmask = (text: string): string =>
    text.replace(EMAIL_TOKEN, (m) => vault.reveal(m.toLowerCase()) ?? m).replace(NAME_TOKEN, (m, num: string) => vault.reveal(`Customer_${num}`) ?? m);

  return {
    maskResult(result) {
      return {
        ...result,
        content: (result.content ?? []).map((c) => (c.type === "text" ? { ...c, text: maskJsonOrText(c.text) } : c)),
      };
    },
    maskText: scrub,
    unmask,
    streamUnmasker() {
      let pending = "";
      return {
        push(delta) {
          pending += delta;
          const hold = partialTokenStart(pending);
          const ready = pending.slice(0, hold);
          pending = pending.slice(hold);
          return unmask(ready);
        },
        flush() {
          const rest = unmask(pending);
          pending = "";
          return rest;
        },
      };
    },
  };
}

/** Forms a pseudonym can take (lower case), with "#" standing for a digit. */
const TEMPLATES = ["customer_######@masked.invalid", "customer _######"];
const LONGEST = Math.max(...TEMPLATES.map((t) => t.length));

/**
 * Index where a pseudonym that may continue in the next delta starts (text.length if
 * none). Text before it is safe to unmask and send now.
 */
export function partialTokenStart(text: string): number {
  for (let i = Math.max(0, text.length - LONGEST); i < text.length; i++) {
    if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1] as string)) continue; // not at a word start
    const tail = text.slice(i).toLowerCase();
    const partial = TEMPLATES.some((tpl) => {
      // A complete longest form can't grow any further, so it is not partial.
      if (tail.length >= tpl.length) return false;
      for (let j = 0; j < tail.length; j++) {
        const t = tpl[j] as string;
        if (t === "#" ? !/\d/.test(tail[j] as string) : tail[j] !== t) return false;
      }
      return true;
    });
    if (partial) return i;
  }
  return text.length;
}

/** Added to the system prompt when masking is on. */
export const MASKING_PROMPT = [
  "- Customer names and emails in tool results are pseudonyms like Customer_402913 and customer_402913@masked.invalid. Write them exactly as given, with no spaces inside; the user's screen shows the real names in their place. Never make up a pseudonym email: only use one that appears in a tool result.",
  "- Phone numbers and street addresses are hidden from you on purpose. Don't guess them; if the user needs them, tell them to open the order in the tool-call panel or in WooCommerce.",
].join("\n");
