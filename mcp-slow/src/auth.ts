// Same as mcp-notes/src/auth.ts (small, deliberately duplicated: see docs/design.md D4.1).
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";

/**
 * Constant-time token comparison. Both sides are hashed to 32 bytes first, so neither the
 * comparison time nor an early length check reveals anything about the expected token.
 */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Reads MCP_BEARER_TOKEN per request: from the mounted Secret directory (refreshed by the
 * kubelet when the Secret changes, so rotation needs no restart) or, locally, from env.
 */
export function tokenReader(secretsDir: string | undefined) {
  return async (): Promise<string | undefined> => {
    if (!secretsDir) return process.env.MCP_BEARER_TOKEN?.trim() || undefined;
    try {
      return (await readFile(join(secretsDir, "MCP_BEARER_TOKEN"), "utf8")).trim() || undefined;
    } catch {
      return undefined;
    }
  };
}

export function rpcError(message: string, code = -32001) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

/** Require `Authorization: Bearer <token>`. No configured token = refuse everything (503). */
export function bearerAuth(getExpected: () => Promise<string | undefined>, realm: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const expected = await getExpected();
    if (!expected) {
      res.status(503).json(rpcError("Server is not configured"));
      return;
    }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") ?? "");
    if (!m?.[1] || !tokensEqual(m[1], expected)) {
      res.set("WWW-Authenticate", `Bearer realm="${realm}"`).status(401).json(rpcError("Unauthorized"));
      return;
    }
    next();
  };
}
