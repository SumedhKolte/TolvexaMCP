import type { FastifyBaseLogger } from "fastify";
import { writeAudit } from "./audit/service.js";
import type { Config } from "./config/index.js";
import type { Db } from "./db/client.js";
import type { GatewayMetrics } from "./metrics/index.js";
import { toolPermissions } from "./db/schema.js";
import type { Registry, UpstreamRow } from "./registry/service.js";
import { aggregateTools } from "./router/aggregate.js";
import { dispatch, type DispatchRequest, type DispatchResult, type UpstreamRef } from "./router/dispatch.js";
import { makePolicy, type PermissionPolicy, type Role } from "./router/permissions.js";
import type { UpstreamManager } from "./upstream/manager.js";
import type { ExposedTool } from "./upstream/types.js";

/** Max time a tools listing waits for any single upstream (aggregate.ts). */
export const LIST_WAIT_MS = 3_000;

/**
 * Wires the pure core (dispatch, aggregate) to real dependencies: Postgres, the upstream
 * manager, and the audit log. /mcp and the chat agent both use this object, so the two
 * entry points can't drift apart.
 */
export class Core {
  /** Set by buildApp; every dispatch() result is counted (stand-out B). */
  metrics?: GatewayMetrics;

  constructor(
    readonly db: Db,
    readonly config: Config,
    readonly registry: Registry,
    readonly manager: UpstreamManager,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Re-reads the registry and syncs the manager. Called on every list/dispatch and every
   * health tick: the upstreams table is tiny, and this is what makes an enable/disable/
   * delete done on one replica apply instantly on all of them.
   */
  async syncUpstreams(): Promise<UpstreamRow[]> {
    const rows = await this.registry.list();
    this.manager.sync(rows.map((r) => this.registry.toConfig(r)));
    return rows;
  }

  async loadPolicy(): Promise<PermissionPolicy> {
    const rules = await this.db.select().from(toolPermissions);
    return makePolicy(
      rules.map((r) => ({ toolName: r.toolName, allowedRoles: r.allowedRoles as Role[] })),
      this.config.DEFAULT_MEMBER_TOOL_ACCESS,
    );
  }

  /** The permission-filtered tool list for a role (tools/list and the chat agent). */
  async listTools(role: Role): Promise<ExposedTool[]> {
    const rows = await this.syncUpstreams();
    const refs = rows.filter((r) => r.enabled).map(toRef);
    return aggregateTools(role, {
      listEnabledUpstreams: async () => refs,
      toolsFor: (u) => this.manager.toolsFor(u.id),
      loadPolicy: () => this.loadPolicy(),
      perUpstreamTimeoutMs: LIST_WAIT_MS,
    });
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    const result = await dispatch(req, {
      findUpstream: async (slug) => {
        const rows = await this.syncUpstreams();
        const row = rows.find((r) => r.slug === slug);
        return row ? toRef(row) : null;
      },
      upstreamStatus: (u) => this.manager.status(u.id),
      resolveTool: (u, local) => this.manager.resolveTool(u.id, local),
      callTool: (u, name, args, timeoutMs) => this.manager.callTool(u.id, name, args, timeoutMs),
      loadPolicy: () => this.loadPolicy(),
      writeAudit: (e) => writeAudit(this.db, e),
      onAuditFailure: (err, e) => this.log.error({ err, tool: e.tool, outcome: e.outcome }, "audit write failed"),
    });
    this.metrics?.recordCall(req.toolName, result);
    return result;
  }

  /** Every registered upstream and whether this replica is connected to it (metrics gauge). */
  async upstreamStates(): Promise<{ slug: string; up: boolean }[]> {
    const rows = await this.syncUpstreams();
    return rows.map((r) => ({ slug: r.slug, up: r.enabled && this.manager.status(r.id) === "connected" }));
  }
}

export function toRef(r: UpstreamRow): UpstreamRef {
  return { id: r.id, slug: r.slug, enabled: r.enabled, timeoutMs: r.timeoutMs };
}
