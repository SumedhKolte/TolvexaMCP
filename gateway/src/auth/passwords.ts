import argon2 from "argon2";

/**
 * argon2id with the library defaults (m=64 MiB, t=3, p=4): OWASP-compliant and ~50 ms
 * per hash on the target hardware. Hash strings embed their parameters, so raising them
 * later doesn't break existing hashes.
 */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash
  }
}

// A real hash of a random value, computed once. Verifying against it when the email
// doesn't exist makes "no such user" take as long as "wrong password", so login timing
// doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}`);
  await verifyPassword(await dummyHash, password);
}
