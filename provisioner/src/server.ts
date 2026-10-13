import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";
import { log } from "./log.js";
import { SLUG_RE, type Provisioner } from "./provisioner.js";

/**
 * Internal API, called only by the gateway (NetworkPolicy + bearer token):
 *   PUT    /v1/stores/:slug   {"host","wooMcpToken","attemptBudget"} -> {phase, detail}
 *   DELETE /v1/stores/:slug                                            -> {phase, detail}
 *   GET    /healthz
 */
const EnsureBody = z.object({
  host: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/).max(253),
  wooMcpToken: z.string().min(32).max(256),
  attemptBudget: z.string().min(1).max(64),
});

const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenMatches = (header: string | undefined, token: string) =>
  Boolean(header?.startsWith("Bearer ")) && timingSafeEqual(digest(header!.slice(7)), digest(token));

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createApi(p: Provisioner, token: string): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    };
    const err = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") return send(200, { status: "ok" });
    if (!tokenMatches(req.headers.authorization, token)) return err(401, "UNAUTHORIZED", "Missing or invalid token");
    const m = /^\/v1\/stores\/([^/]+)$/.exec(url.pathname);
    if (!m) return err(404, "NOT_FOUND", "Not found");
    const slug = decodeURIComponent(m[1] as string);
    if (!SLUG_RE.test(slug)) return err(400, "BAD_REQUEST", "Invalid store slug");
    try {
      if (req.method === "PUT") {
        const parsed = EnsureBody.safeParse(await readJson(req));
        if (!parsed.success) return err(400, "BAD_REQUEST", "Invalid body: host, wooMcpToken and attemptBudget are required");
        return send(200, await p.ensure(slug, parsed.data));
      }
      if (req.method === "DELETE") return send(200, await p.remove(slug));
      return err(405, "METHOD_NOT_ALLOWED", "Use PUT or DELETE");
    } catch (e) {
      // Kubernetes/Helm messages carry object names and reasons, never secret values.
      log({ msg: "request failed", method: req.method, store: slug, error: (e as Error).message.slice(0, 300) });
      return err(502, "PROVISIONER_ERROR", (e as Error).message.slice(0, 300));
    }
  });
}
