import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for upstream credentials stored in Postgres.
 *
 * - Key: CREDENTIAL_ENC_KEY, 32 random bytes (base64 in the Secret). Never stored in the DB.
 * - Nonce: 12 fresh random bytes per encryption, stored in cred_nonce.
 * - Stored ciphertext = encrypted bytes || 16-byte GCM auth tag (cred_encrypted).
 * - AAD = "upstream:<id>": the ciphertext is bound to its row, so copying one upstream's
 *   encrypted credential onto another row (with DB write access) fails to decrypt.
 *
 * GCM authenticates: any change to ciphertext, tag, nonce, or AAD makes decrypt throw.
 */
const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_ENC_KEY must be base64 of exactly 32 bytes");
  return key;
}

const aad = (upstreamId: string) => Buffer.from(`upstream:${upstreamId}`, "utf8");

export function encryptCredential(plaintext: string, key: Buffer, upstreamId: string): EncryptedCredential {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(upstreamId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

export function decryptCredential(enc: EncryptedCredential, key: Buffer, upstreamId: string): string {
  if (enc.nonce.length !== NONCE_BYTES || enc.ciphertext.length < TAG_BYTES) {
    throw new Error("malformed encrypted credential");
  }
  const body = enc.ciphertext.subarray(0, enc.ciphertext.length - TAG_BYTES);
  const tag = enc.ciphertext.subarray(enc.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, enc.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(upstreamId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
