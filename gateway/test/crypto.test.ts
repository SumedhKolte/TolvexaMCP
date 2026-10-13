import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, parseEncryptionKey } from "../src/crypto/credentials.js";
import {
  apiKeyMatches,
  apiKeyPrefix,
  generateApiKey,
  sessionIdFor,
  sha256Hex,
} from "../src/crypto/tokens.js";

const key = randomBytes(32);

describe("credential encryption (AES-256-GCM)", () => {
  it("round-trips", () => {
    const enc = encryptCredential("s3cret-token", key, "up-1");
    expect(decryptCredential(enc, key, "up-1")).toBe("s3cret-token");
  });

  it("uses a fresh nonce every time", () => {
    const a = encryptCredential("same", key, "up-1");
    const b = encryptCredential("same", key, "up-1");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails on a tampered ciphertext", () => {
    const enc = encryptCredential("s3cret-token", key, "up-1");
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    expect(() => decryptCredential({ ciphertext: tampered, nonce: enc.nonce }, key, "up-1")).toThrow();
  });

  it("fails on a tampered auth tag or nonce", () => {
    const enc = encryptCredential("s3cret-token", key, "up-1");
    const tag = Buffer.from(enc.ciphertext);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptCredential({ ciphertext: tag, nonce: enc.nonce }, key, "up-1")).toThrow();
    const nonce = Buffer.from(enc.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0x01;
    expect(() => decryptCredential({ ciphertext: enc.ciphertext, nonce }, key, "up-1")).toThrow();
  });

  it("is bound to its upstream row (AAD): another row's id can't decrypt it", () => {
    const enc = encryptCredential("s3cret-token", key, "up-1");
    expect(() => decryptCredential(enc, key, "up-2")).toThrow();
  });

  it("fails with the wrong key", () => {
    const enc = encryptCredential("s3cret-token", key, "up-1");
    expect(() => decryptCredential(enc, randomBytes(32), "up-1")).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow();
    expect(parseEncryptionKey(key.toString("base64")).length).toBe(32);
  });
});

describe("API keys", () => {
  it("have the format wk_<8 chars>_<secret>", () => {
    const { key: k, prefix } = generateApiKey();
    expect(k).toMatch(/^wk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(k.startsWith(`wk_${prefix}_`)).toBe(true);
    expect(apiKeyPrefix(k)).toBe(prefix);
  });

  it("are unique", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key));
    expect(keys.size).toBe(500);
  });

  it("store a SHA-256 hash, never the key itself", () => {
    const g = generateApiKey();
    expect(g.hash).toBe(sha256Hex(g.key));
    expect(g.hash).not.toContain(g.key);
    expect(g.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify only the exact key", () => {
    const g = generateApiKey();
    expect(apiKeyMatches(g.key, g.hash)).toBe(true);
    expect(apiKeyMatches(`${g.key.slice(0, -1)}x`, g.hash)).toBe(false);
    expect(apiKeyMatches(generateApiKey().key, g.hash)).toBe(false);
  });

  it("reject malformed candidates by format before any lookup", () => {
    expect(apiKeyPrefix("wk_short_abc")).toBeNull();
    expect(apiKeyPrefix("Bearer wk_...")).toBeNull();
    expect(apiKeyPrefix("")).toBeNull();
  });
});

describe("session ids", () => {
  it("are an HMAC of the token, so the DB never holds the cookie value", () => {
    const id = sessionIdFor("tok", "secret-a");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toBe(sha256Hex("tok"));
    expect(sessionIdFor("tok", "secret-b")).not.toBe(id);
  });
});
