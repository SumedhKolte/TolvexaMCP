import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests of equal algorithm. */
export function hexDigestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------
// API keys: wk_<prefix>_<secret>
//   prefix: 8 random chars [a-z0-9], stored in clear (unique) to find the row
//   secret: 32 random bytes, base64url (43 chars; may itself contain "_" or "-")
//   stored: prefix + SHA-256 hex of the FULL key. The key itself is returned once.
// SHA-256 (not argon2) is right here: the secret has 256 bits of entropy, so there's
// nothing to brute-force, and verification must be fast on every MCP request.
// ---------------------------------------------------------------------------------------

const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RE = /^wk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  let prefix = "";
  for (let i = 0; i < 8; i++) prefix += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
  const key = `wk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: sha256Hex(key) };
}

/** Returns the prefix if the string has the API key format, else null. */
export function apiKeyPrefix(candidate: string): string | null {
  return KEY_RE.exec(candidate)?.[1] ?? null;
}

export function apiKeyMatches(candidate: string, storedHash: string): boolean {
  return hexDigestsEqual(sha256Hex(candidate), storedHash);
}

// ---------------------------------------------------------------------------------------
// Sessions: the cookie holds a random 32-byte token; the DB holds HMAC-SHA256(SESSION_SECRET,
// token) as the session id. A DB dump alone can't be turned into valid cookies, and
// SESSION_SECRET alone is useless without a session row.
// ---------------------------------------------------------------------------------------

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionIdFor(token: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(token, "utf8").digest("hex");
}

/** Random password for users created by an admin (shown once). */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url"); // 24 chars, ~144 bits
}
