import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { decryptCredential, encryptCredential } from "../crypto/credentials.js";
import type { Db } from "../db/client.js";
import { upstreams } from "../db/schema.js";
import { badRequest, conflict, isUniqueViolation, notFound } from "../http/errors.js";
import type { UpstreamConfig } from "../upstream/manager.js";
import { checkUpstreamUrl, SsrfError, systemResolver, type Resolver, type SsrfPolicy } from "./ssrf.js";

export type UpstreamRow = typeof upstreams.$inferSelect;
export type CredType = "none" | "header" | "bearer";

export interface CreateUpstreamInput {
  slug: string;
  name: string;
  url: string;
  credType: CredType;
  credHeaderName?: string | null;
  credential?: string | null;
  timeoutMs?: number;
  enabled?: boolean;
}

export interface UpdateUpstreamInput {
  name?: string;
  url?: string;
  credType?: CredType;
  credHeaderName?: string | null;
  /** Write-only. Absent or "" keeps the stored value (spec: blank = keep). */
  credential?: string | null;
  timeoutMs?: number;
}

/**
 * Upstream registry: the only code that writes the upstreams table and the only code
 * that decrypts credentials (into UpstreamConfig, which goes to the upstream manager and
 * nowhere else; API responses are built from rows and report only `credential_set`).
 */
export class Registry {
  constructor(
    private readonly db: Db,
    private readonly encKey: Buffer,
    private readonly ssrf: SsrfPolicy,
    private readonly defaultTimeoutMs: number,
    private readonly resolve: Resolver = systemResolver,
  ) {}

  /** Built-in first (the WooCommerce row is shown first, with a "built-in" label), then oldest first. */
  list(): Promise<UpstreamRow[]> {
    return this.db.select().from(upstreams).orderBy(desc(upstreams.builtin), asc(upstreams.createdAt));
  }

  async get(id: string): Promise<UpstreamRow> {
    const [row] = await this.db.select().from(upstreams).where(eq(upstreams.id, id));
    if (!row) throw notFound("Server not found");
    return row;
  }

  /** Decrypts for the manager. An undecryptable credential becomes null (shows up as a connect error). */
  toConfig(row: UpstreamRow): UpstreamConfig {
    let credential: string | null = null;
    if (row.credEncrypted && row.credNonce) {
      try {
        credential = decryptCredential({ ciphertext: row.credEncrypted, nonce: row.credNonce }, this.encKey, row.id);
      } catch {
        credential = null;
      }
    }
    return {
      id: row.id,
      slug: row.slug,
      url: row.url,
      enabled: row.enabled,
      credType: row.credType,
      credHeaderName: row.credHeaderName,
      credential,
      timeoutMs: row.timeoutMs,
      version: row.updatedAt.toISOString(),
    };
  }

  async create(input: CreateUpstreamInput): Promise<UpstreamRow> {
    await this.checkUrl(input.url);
    validateCredential(input.credType, input.credHeaderName, input.credential, true);
    const id = randomUUID();
    const enc = input.credType !== "none" && input.credential ? encryptCredential(input.credential, this.encKey, id) : null;
    try {
      const [row] = await this.db
        .insert(upstreams)
        .values({
          id,
          slug: input.slug,
          name: input.name,
          url: input.url,
          enabled: input.enabled ?? true,
          credType: input.credType,
          credHeaderName: input.credType === "header" ? input.credHeaderName ?? null : null,
          credEncrypted: enc?.ciphertext ?? null,
          credNonce: enc?.nonce ?? null,
          timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
        })
        .returning();
      return row as UpstreamRow;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("A server with this slug or name already exists");
      throw err;
    }
  }

  async update(id: string, input: UpdateUpstreamInput): Promise<UpstreamRow> {
    const row = await this.get(id);
    if (row.builtin && (input.url !== undefined || input.credType !== undefined || input.credential)) {
      // Its URL and token come from the deployment (WOO_MCP_URL / WOO_MCP_BEARER_TOKEN)
      // and are re-applied on every boot; an edit here would silently revert.
      throw badRequest("The built-in server's URL and credential are managed by the deployment");
    }
    if (input.url !== undefined && input.url !== row.url) await this.checkUrl(input.url);

    const credType = input.credType ?? row.credType;
    const newCredential = input.credential ? input.credential : null; // "" or absent = keep
    const hasStored = row.credEncrypted !== null;
    const headerName = credType === "header" ? input.credHeaderName ?? row.credHeaderName : null;
    validateCredential(credType, headerName, newCredential ?? (hasStored ? "(stored)" : null), false);

    const set: Partial<typeof upstreams.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.url !== undefined) set.url = input.url;
    if (input.timeoutMs !== undefined) set.timeoutMs = input.timeoutMs;
    set.credType = credType;
    set.credHeaderName = headerName;
    if (credType === "none") {
      set.credEncrypted = null;
      set.credNonce = null;
    } else if (newCredential) {
      const enc = encryptCredential(newCredential, this.encKey, id);
      set.credEncrypted = enc.ciphertext;
      set.credNonce = enc.nonce;
    }
    try {
      const [updated] = await this.db.update(upstreams).set(set).where(eq(upstreams.id, id)).returning();
      return updated as UpstreamRow;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("A server with this name already exists");
      throw err;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<UpstreamRow> {
    const [row] = await this.db.update(upstreams).set({ enabled, updatedAt: new Date() }).where(eq(upstreams.id, id)).returning();
    if (!row) throw notFound("Server not found");
    return row;
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.db.delete(upstreams).where(eq(upstreams.id, id)).returning({ id: upstreams.id });
    if (!deleted.length) throw notFound("Server not found");
  }

  private async checkUrl(url: string): Promise<void> {
    try {
      await checkUpstreamUrl(url, this.ssrf, this.resolve);
    } catch (err) {
      if (err instanceof SsrfError) throw badRequest(`url: ${err.message}`);
      throw err;
    }
  }
}

/** Header names an admin may not hijack with a "header" credential. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie", "accept", "mcp-session-id", "mcp-protocol-version"]);

function validateCredential(credType: CredType, headerName: string | null | undefined, credential: string | null | undefined, creating: boolean): void {
  if (credType === "none") return;
  if (!credential) throw badRequest(`credential: required for credential type "${credType}"${creating ? "" : " (none is stored)"}`);
  if (credType === "header") {
    if (!headerName || !/^[A-Za-z0-9-]{1,64}$/.test(headerName)) throw badRequest("cred_header_name: required, letters/digits/dashes only");
    if (RESERVED_HEADERS.has(headerName.toLowerCase())) throw badRequest(`cred_header_name: "${headerName}" is reserved`);
  }
}
