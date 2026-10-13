import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Constant-time comparison of two tokens.
 *
 * timingSafeEqual requires equal-length inputs, and returning early on a length mismatch
 * would leak the token's length. Hashing both sides to SHA-256 first gives two 32-byte
 * buffers, so the comparison time never depends on the inputs.
 */
export function tokensEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Express middleware: require `Authorization: Bearer <token>` matching the expected token.
 * The expected token is fetched per request so rotation needs no restart.
 */
export function bearerAuth(getExpected: () => Promise<string | undefined>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const expected = await getExpected();
    if (!expected) {
      // Misconfiguration: refuse everything rather than run unauthenticated.
      res.status(503).json(rpcError("Server is not configured"));
      return;
    }
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1] || !tokensEqual(match[1], expected)) {
      res.set("WWW-Authenticate", 'Bearer realm="woo-mcp"').status(401).json(rpcError("Unauthorized"));
      return;
    }
    next();
  };
}

/** JSON-RPC shaped error body, so MCP clients can display transport-level failures. */
export function rpcError(message: string, code = -32001) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}
