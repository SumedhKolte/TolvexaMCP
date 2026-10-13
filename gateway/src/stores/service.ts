import { randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, inArray, like, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Core } from "../core.js";
import { decryptCredential, encryptCredential } from "../crypto/credentials.js";
import { stores, toolPermissions, users } from "../db/schema.js";
import { conflict, HttpError, isUniqueViolation, notFound } from "../http/errors.js";
import { ProvisionerError, type ProvisionerClient } from "./provisioner-client.js";

/**
 * Multi-store provisioning (bonus). The gateway owns the desired state (the `stores`
 * table); the provisioner service does the Kubernetes work. A reconciler loop moves each
 * store along:
 *
 *   provisioning --(provisioner: ready)--> register woo-mcp as upstream "<slug>" --> ready
 *   provisioning --(provisioner: failed | deadline passed)--> failed (with a reason)
 *   deleting --> unregister the upstream (tools vanish) --> provisioner removes the
 *                namespace --> row deleted
 *
 * Restart safety: everything is idempotent and driven from the DB, so a gateway or
 * provisioner restart mid-way resumes on the next tick. Several gateway replicas share
 * the work through a per-store lease (UPDATE ... FOR UPDATE SKIP LOCKED).
 */
export type StoreRow = typeof stores.$inferSelect;
type User = { id: string; role: "admin" | "member" };

/** Store names become DNS labels: "store-<name>" is the namespace and the tool prefix. */
export const STORE_NAME_RE = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;
export const STORE_SLUG_PREFIX = "store-";
const LEASE_SECONDS = 60;
const BATCH = 5;

/** Tools of a store that members may NOT call (mirrors the main store's defaults). */
const ADMIN_ONLY_TOOLS = ["create_product", "update_order_status"];

export interface StoreOptions {
  maxPerUser: number;
  maxTotal: number;
  provisionTimeoutMs: number;
  /** Ready stores are re-checked this often, so chart/values changes reach them. */
  resyncMs: number;
  /** Public host = slug + suffix, e.g. ".localtest.me" -> store-a.localtest.me. */
  hostSuffix: string;
  /** http or https, for the URL shown in the dashboard. */
  publicScheme: string;
}

// The token is packed as nonce || ciphertext, bound to the store id (AAD).
const aadId = (id: string) => `store:${id}`;
function sealToken(token: string, key: Buffer, id: string): Buffer {
  const enc = encryptCredential(token, key, aadId(id));
  return Buffer.concat([enc.nonce, enc.ciphertext]);
}
function openToken(sealed: Buffer, key: Buffer, id: string): string {
  return decryptCredential({ nonce: sealed.subarray(0, 12), ciphertext: sealed.subarray(12) }, key, aadId(id));
}

export class StoreService {
  constructor(
    private readonly core: Core,
    private readonly encKey: Buffer,
    private readonly provisioner: ProvisionerClient | null,
    private readonly opts: StoreOptions,
    private readonly log: FastifyBaseLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return this.provisioner !== null;
  }

  private get db() {
    return this.core.db;
  }

  view(row: StoreRow & { ownerEmail?: string | null }) {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      status_reason: row.statusReason,
      url: `${this.opts.publicScheme}://${row.host}`,
      tool_prefix: `${row.slug}__`,
      owner_email: row.ownerEmail ?? null,
      deadline_at: row.deadlineAt.toISOString(),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /** Admins see every store; members see their own. */
  async list(user: User) {
    const q = this.db
      .select({ store: stores, ownerEmail: users.email })
      .from(stores)
      .leftJoin(users, eq(users.id, stores.ownerId))
      .orderBy(stores.createdAt);
    const rows = user.role === "admin" ? await q : await q.where(eq(stores.ownerId, user.id));
    return rows.map((r) => this.view({ ...r.store, ownerEmail: r.ownerEmail }));
  }

  /** Limits and this user's usage, for the dashboard. */
  async limits(user: User) {
    const [{ mine = 0 } = {}] = await this.db.select({ mine: count() }).from(stores).where(eq(stores.ownerId, user.id));
    const [{ all = 0 } = {}] = await this.db.select({ all: count() }).from(stores);
    return {
      enabled: this.enabled,
      per_user: this.opts.maxPerUser,
      total: this.opts.maxTotal,
      mine,
      all,
      // For the "Create store" preview: <scheme>://store-<name><suffix>
      url_template: `${this.opts.publicScheme}://store-{name}${this.opts.hostSuffix}`,
    };
  }

  /**
   * Retry-safe create: the same name again returns the existing store (and restarts a
   * failed one) instead of making a second one.
   */
  async create(user: User, name: string): Promise<{ store: StoreRow; created: boolean }> {
    if (!this.enabled) throw new HttpError(503, "STORES_UNAVAILABLE", "Store provisioning is not enabled on this gateway");
    const slug = `${STORE_SLUG_PREFIX}${name}`;
    const [existing] = await this.db.select().from(stores).where(eq(stores.slug, slug));
    if (existing) {
      if (existing.ownerId !== user.id && user.role !== "admin") throw conflict(`A store named "${name}" already exists`);
      if (existing.status === "deleting") throw conflict(`Store "${name}" is being deleted; try again when it's gone`);
      if (existing.status === "failed") {
        const [row] = await this.db
          .update(stores)
          .set({ status: "provisioning", statusReason: "Retrying", deadlineAt: this.deadline(), leaseUntil: null, updatedAt: this.now() })
          .where(eq(stores.id, existing.id))
          .returning();
        return { store: row as StoreRow, created: false };
      }
      return { store: existing, created: false };
    }

    const [{ mine = 0 } = {}] = await this.db.select({ mine: count() }).from(stores).where(eq(stores.ownerId, user.id));
    if (mine >= this.opts.maxPerUser) {
      throw new HttpError(429, "STORE_LIMIT", `You already have ${mine} of ${this.opts.maxPerUser} stores. Delete one first.`);
    }
    const [{ all = 0 } = {}] = await this.db.select({ all: count() }).from(stores);
    if (all >= this.opts.maxTotal) throw new HttpError(429, "STORE_LIMIT", `The gateway's limit of ${this.opts.maxTotal} stores is reached.`);
    const taken = (await this.core.registry.list()).some((u) => u.slug === slug);
    if (taken) throw conflict(`The server slug "${slug}" is already in use`);

    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    try {
      const [row] = await this.db
        .insert(stores)
        .values({
          id,
          slug,
          name,
          ownerId: user.id,
          host: `${slug}${this.opts.hostSuffix}`,
          status: "provisioning",
          statusReason: "Queued",
          tokenEncrypted: sealToken(token, this.encKey, id),
          deadlineAt: this.deadline(),
        })
        .returning();
      this.log.info({ store: slug, by: user.id }, "store requested");
      return { store: row as StoreRow, created: true };
    } catch (err) {
      if (isUniqueViolation(err)) return this.create(user, name); // lost a race with an identical request
      throw err;
    }
  }

  /** Owner or admin. Tools disappear on the next reconciler tick (seconds). */
  async requestDelete(user: User, id: string): Promise<StoreRow> {
    const [row] = await this.db.select().from(stores).where(eq(stores.id, id));
    if (!row || (row.ownerId !== user.id && user.role !== "admin")) throw notFound("Store not found");
    if (row.status === "deleting") return row;
    const [updated] = await this.db
      .update(stores)
      .set({ status: "deleting", statusReason: "Deletion requested", leaseUntil: null, updatedAt: this.now() })
      .where(eq(stores.id, id))
      .returning();
    this.log.info({ store: row.slug, by: user.id }, "store deletion requested");
    return updated as StoreRow;
  }

  private deadline(): Date {
    return new Date(this.now().getTime() + this.opts.provisionTimeoutMs);
  }

  /** Claims up to BATCH stores needing work (lease) and moves each one step forward. */
  async reconcileOnce(): Promise<number> {
    if (!this.provisioner) return 0;
    const claimed = (await this.db.execute(sql`
      UPDATE stores SET lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
      WHERE id IN (
        SELECT id FROM stores
        WHERE (status IN ('provisioning', 'deleting')
               OR (status = 'ready' AND updated_at < now() - make_interval(secs => ${Math.round(this.opts.resyncMs / 1000)})))
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY updated_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING id`)) as unknown as { rows: { id: string }[] };
    const ids = claimed.rows.map((r) => r.id);
    if (!ids.length) return 0;
    const rows = await this.db.select().from(stores).where(inArray(stores.id, ids));
    for (const row of rows) {
      try {
        if (row.status === "provisioning") await this.stepProvisioning(row);
        else if (row.status === "deleting") await this.stepDeleting(row);
        else if (row.status === "ready") await this.stepReady(row);
      } catch (err) {
        const reason = err instanceof ProvisionerError ? err.message : "internal error (see gateway logs)";
        if (!(err instanceof ProvisionerError)) this.log.error({ err, store: row.slug }, "store reconcile failed");
        await this.patch(row.id, { statusReason: reason });
      } finally {
        await this.db.update(stores).set({ leaseUntil: null }).where(eq(stores.id, row.id));
      }
    }
    return rows.length;
  }

  private patch(id: string, set: Partial<typeof stores.$inferInsert>) {
    return this.db.update(stores).set({ ...set, updatedAt: this.now() }).where(eq(stores.id, id));
  }

  private async stepProvisioning(row: StoreRow): Promise<void> {
    if (this.now() > row.deadlineAt) {
      const minutes = Math.round(this.opts.provisionTimeoutMs / 60_000);
      await this.patch(row.id, { status: "failed", statusReason: `Timed out after ${minutes} min (last step: ${row.statusReason ?? "none"}). Retry or delete it.` });
      this.log.warn({ store: row.slug }, "store provisioning timed out");
      return;
    }
    const provisioner = this.provisioner as ProvisionerClient;
    const token = openToken(row.tokenEncrypted, this.encKey, row.id);
    const s = await provisioner.ensure(row.slug, { host: row.host, wooMcpToken: token, attemptBudget: row.deadlineAt.toISOString() });
    if (s.phase === "failed") {
      await this.patch(row.id, { status: "failed", statusReason: s.detail || "Provisioning failed" });
      return;
    }
    if (s.phase !== "ready") {
      await this.patch(row.id, { statusReason: s.detail || "Installing" });
      return;
    }
    const upstreamId = row.upstreamId ?? (await this.registerUpstream(row, token));
    await this.patch(row.id, { status: "ready", statusReason: null, upstreamId });
    this.log.info({ store: row.slug }, "store ready");
  }

  /**
   * Periodic re-check of a ready store. The provisioner upgrades it in place if the
   * charts or values changed; the store stays "ready" (and its tools stay listed) while
   * that happens, and a failed upgrade is reported without taking the store down.
   */
  private async stepReady(row: StoreRow): Promise<void> {
    const token = openToken(row.tokenEncrypted, this.encKey, row.id);
    const s = await (this.provisioner as ProvisionerClient).ensure(row.slug, { host: row.host, wooMcpToken: token, attemptBudget: row.deadlineAt.toISOString() });
    const reason = s.phase === "ready" ? s.detail || null : s.phase === "failed" ? `Update failed: ${s.detail}` : `Updating: ${s.detail}`;
    await this.patch(row.id, { statusReason: reason });
  }

  /** Registers the store's woo-mcp like an admin would add a server; adopts a leftover one. */
  private async registerUpstream(row: StoreRow, token: string): Promise<string> {
    const { registry, manager } = this.core;
    const url = `http://woo-mcp.${row.slug}.svc.cluster.local:8080/mcp`;
    let upstream = (await registry.list()).find((u) => u.slug === row.slug);
    if (upstream) {
      upstream = await registry.update(upstream.id, { url, credType: "bearer", credential: token });
    } else {
      upstream = await registry.create({ slug: row.slug, name: `Store: ${row.name}`, url, credType: "bearer", credHeaderName: null, credential: token });
    }
    // Write tools are admin-only, like the main store's (only where no rule exists yet).
    await this.db
      .insert(toolPermissions)
      .values(ADMIN_ONLY_TOOLS.map((t) => ({ toolName: `${row.slug}__${t}`, allowedRoles: ["admin"] })))
      .onConflictDoNothing();
    await this.core.syncUpstreams();
    await manager.check(upstream.id).catch(() => undefined); // connect now; the health loop retries anyway
    return upstream.id;
  }

  private async stepDeleting(row: StoreRow): Promise<void> {
    // Tools first, so nobody can call a store that's going away.
    const upstream = (await this.core.registry.list()).find((u) => u.slug === row.slug);
    if (upstream) {
      await this.core.registry.delete(upstream.id);
      this.core.manager.remove(upstream.id);
    }
    await this.db.delete(toolPermissions).where(like(toolPermissions.toolName, `${row.slug}\\_\\_%`));
    const s = await (this.provisioner as ProvisionerClient).remove(row.slug);
    if (s.phase === "gone") {
      await this.db.delete(stores).where(and(eq(stores.id, row.id), eq(stores.status, "deleting")));
      this.log.info({ store: row.slug }, "store deleted");
    } else {
      await this.patch(row.id, { statusReason: s.detail || "Deleting", upstreamId: null });
    }
  }
}
