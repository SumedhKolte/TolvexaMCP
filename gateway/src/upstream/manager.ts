import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateMessage } from "../audit/redact.js";
import { exposeToolName, UPSTREAM_TOOL_NAME_RE } from "../router/tool-name.js";
import {
  UpstreamTransportError,
  UpstreamUnavailableError,
  type ExposedTool,
  type UpstreamStatus,
} from "./types.js";

/** Everything needed to talk to one upstream (credential already decrypted). */
export interface UpstreamConfig {
  id: string;
  slug: string;
  url: string;
  enabled: boolean;
  credType: "none" | "header" | "bearer";
  credHeaderName: string | null;
  credential: string | null;
  timeoutMs: number;
  /** Changes whenever the row changes (updated_at); a new version resets the client. */
  version: string;
}

/** A live connection to an upstream. Errors must be classified (see types.ts). */
export interface UpstreamSession {
  listTools(timeoutMs: number): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface Connector {
  connect(cfg: UpstreamConfig, timeoutMs: number): Promise<UpstreamSession>;
}

export interface ManagerOptions {
  connectTimeoutMs: number; // spec: 5 s
  healthTimeoutMs: number; // spec: 3 s
  baseBackoffMs: number; // first retry after this, doubling
  maxBackoffMs: number; // spec: capped at 60 s
  /**
   * Failures in a row after which the upstream counts as "confirmed gone" and its cached
   * tools are removed from listings. Before that, calls already fail fast (status
   * unreachable) but the tool list is kept, so a blip doesn't make tools vanish.
   */
  goneAfterFailures: number;
  onStatusChange?(slug: string, status: UpstreamStatus): void;
}

export const DEFAULT_MANAGER_OPTIONS: ManagerOptions = {
  connectTimeoutMs: 5_000,
  healthTimeoutMs: 3_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  goneAfterFailures: 2,
};

export interface UpstreamSnapshot {
  status: UpstreamStatus;
  lastError: string | null;
  toolCount: number;
  lastCheckedAt: Date | null;
}

interface State {
  cfg: UpstreamConfig;
  session?: UpstreamSession;
  status: UpstreamStatus;
  tools: ExposedTool[];
  /** local name -> original upstream name; undefined until the first successful listing. */
  index?: Map<string, string>;
  failures: number;
  lastError: string | null;
  lastCheckedAt: Date | null;
  retryTimer?: NodeJS.Timeout;
  inflight?: Promise<void>;
  /** Bumped when the config changes or the upstream is removed; stale results are dropped. */
  generation: number;
}

/**
 * Keeps one long-lived MCP client per enabled upstream, plus its health and tool list.
 *
 * Each gateway replica has its own manager. The registry (Postgres) is the source of
 * truth and is re-synced into the manager on every list/dispatch and every health tick,
 * so admin changes made on another replica apply here too.
 */
export class UpstreamManager {
  private readonly states = new Map<string, State>();
  private readonly opts: ManagerOptions;

  constructor(
    private readonly connector: Connector,
    opts: Partial<ManagerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_MANAGER_OPTIONS, ...opts };
  }

  /** Makes the manager match the registry: add new, reset changed, drop removed. */
  sync(configs: UpstreamConfig[]): void {
    const seen = new Set<string>();
    for (const cfg of configs) {
      seen.add(cfg.id);
      this.upsert(cfg);
    }
    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.remove(id);
  }

  upsert(cfg: UpstreamConfig): void {
    const existing = this.states.get(cfg.id);
    if (existing && existing.cfg.version === cfg.version && existing.cfg.enabled === cfg.enabled) return;
    if (existing) this.reset(existing);
    const state: State = existing ?? {
      cfg,
      status: "pending",
      tools: [],
      failures: 0,
      lastError: null,
      lastCheckedAt: null,
      generation: 0,
    };
    state.cfg = cfg;
    state.status = cfg.enabled ? "pending" : "disabled";
    this.states.set(cfg.id, state);
    this.emit(state);
  }

  /** Deleting an upstream closes its client and drops its tools immediately. */
  remove(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    this.reset(s);
    this.states.delete(id);
  }

  status(id: string): UpstreamStatus {
    return this.states.get(id)?.status ?? "pending";
  }

  snapshot(id: string): UpstreamSnapshot {
    const s = this.states.get(id);
    if (!s) return { status: "pending", lastError: null, toolCount: 0, lastCheckedAt: null };
    return { status: s.status, lastError: s.lastError, toolCount: this.listable(s).length, lastCheckedAt: s.lastCheckedAt };
  }

  /**
   * Tools for listings. A "pending" upstream (never tried on this replica) is checked
   * first; callers bound the wait (aggregate.ts) so a dead upstream can't block a list.
   */
  async toolsFor(id: string): Promise<ExposedTool[]> {
    const s = this.states.get(id);
    if (!s || s.status === "disabled") return [];
    if (s.status === "pending") await this.check(id);
    return this.listable(s);
  }

  /** Cached tools only (no network): for admin views of a single server. */
  cachedTools(id: string): ExposedTool[] {
    const s = this.states.get(id);
    return s ? this.listable(s) : [];
  }

  resolveTool(id: string, local: string): string | null | undefined {
    const index = this.states.get(id)?.index;
    if (!index) return undefined;
    return index.get(local) ?? null;
  }

  async callTool(id: string, original: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult> {
    const s = this.states.get(id);
    if (!s || s.status === "disabled" || s.status === "unreachable") throw new UpstreamUnavailableError("unavailable");
    if (!s.session) {
      await this.check(id);
      if (!s.session || s.status !== "connected") throw new UpstreamUnavailableError("unavailable");
    }
    const session = s.session;
    try {
      return await session.callTool(original, args, timeoutMs);
    } catch (err) {
      // Network-level failure: the upstream is down. Timeouts and JSON-RPC errors are not.
      if (err instanceof UpstreamTransportError && s.session === session) this.recordFailure(s, err);
      throw err;
    }
  }

  /** Health check: connect if needed, then tools/list. Concurrent calls share one attempt. */
  check(id: string): Promise<void> {
    const s = this.states.get(id);
    if (!s || s.status === "disabled") return Promise.resolve();
    if (s.inflight) return s.inflight;
    const gen = s.generation;
    s.inflight = (async () => {
      try {
        if (!s.session) s.session = await this.connector.connect(s.cfg, this.opts.connectTimeoutMs);
        const tools = await s.session.listTools(this.opts.healthTimeoutMs);
        if (gen !== s.generation) return;
        this.applyTools(s, tools);
        s.failures = 0;
        this.clearRetry(s);
        this.setStatus(s, "connected");
      } catch (err) {
        if (gen !== s.generation) return;
        this.recordFailure(s, err);
      } finally {
        if (gen === s.generation) s.lastCheckedAt = new Date();
        s.inflight = undefined;
      }
    })();
    return s.inflight;
  }

  /** Health-loop tick: check every enabled upstream that isn't waiting on a backoff retry. */
  async checkAll(): Promise<void> {
    const due = [...this.states.values()].filter((s) => s.status !== "disabled" && !s.retryTimer);
    await Promise.allSettled(due.map((s) => this.check(s.cfg.id)));
  }

  async close(): Promise<void> {
    for (const id of [...this.states.keys()]) this.remove(id);
  }

  // ------------------------------------------------------------------------------------

  private listable(s: State): ExposedTool[] {
    if (s.status === "connected") return s.tools;
    if (s.status === "unreachable" && s.failures < this.opts.goneAfterFailures) return s.tools; // grace
    return [];
  }

  private recordFailure(s: State, err: unknown): void {
    s.failures += 1;
    s.lastError = truncateMessage((err as Error)?.message ?? err, 160);
    this.dropSession(s);
    this.setStatus(s, "unreachable");
    // Exponential backoff: base, 2x, 4x, ... capped. One timer per upstream.
    this.clearRetry(s);
    const delay = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** (s.failures - 1));
    s.retryTimer = setTimeout(() => {
      s.retryTimer = undefined;
      void this.check(s.cfg.id);
    }, delay);
    s.retryTimer.unref?.();
  }

  /**
   * Turns the upstream's tool list into exposed tools. Rejected (and reported in
   * last_error, while the server stays connected):
   *   - names with characters outside [A-Za-z0-9_.-]
   *   - two tools that end up with the same exposed name after "__" -> "_"
   * Descriptions are untrusted text: capped at 1024 chars, and the upstream's own URL and
   * credential are scrubbed so they can never leak through a description.
   */
  private applyTools(s: State, tools: Tool[]): void {
    const byLocal = new Map<string, Tool[]>();
    const rejected: string[] = [];
    for (const t of tools) {
      if (!UPSTREAM_TOOL_NAME_RE.test(t.name)) {
        rejected.push(`invalid name "${truncateMessage(t.name, 40)}"`);
        continue;
      }
      const { local } = exposeToolName(s.cfg.slug, t.name);
      byLocal.set(local, [...(byLocal.get(local) ?? []), t]);
    }
    const exposed: ExposedTool[] = [];
    const index = new Map<string, string>();
    for (const [local, group] of byLocal) {
      if (group.length > 1) {
        rejected.push(`name collision on "${local}" (${group.map((t) => t.name).join(", ")})`);
        continue;
      }
      const t = group[0] as Tool;
      const name = exposeToolName(s.cfg.slug, t.name);
      index.set(local, t.name);
      exposed.push({
        exposedName: name.exposed,
        slug: s.cfg.slug,
        originalName: t.name,
        rewritten: name.rewritten,
        title: t.title ?? t.annotations?.title,
        description: this.scrub(t.description ?? "", s.cfg),
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      });
    }
    s.tools = exposed.sort((a, b) => a.exposedName.localeCompare(b.exposedName));
    s.index = index;
    s.lastError = rejected.length ? truncateMessage(`${rejected.length} tool(s) rejected: ${rejected.join("; ")}`, 300) : null;
  }

  private scrub(description: string, cfg: UpstreamConfig): string {
    let d = description;
    for (const secret of [cfg.credential, cfg.url]) {
      if (secret && secret.length >= 4) d = d.split(secret).join("[redacted]");
    }
    return d.length > 1024 ? `${d.slice(0, 1023)}…` : d;
  }

  private setStatus(s: State, status: UpstreamStatus): void {
    if (s.status === status) return;
    s.status = status;
    this.emit(s);
  }

  private emit(s: State): void {
    this.opts.onStatusChange?.(s.cfg.slug, s.status);
  }

  private reset(s: State): void {
    s.generation += 1;
    this.clearRetry(s);
    this.dropSession(s);
    s.tools = [];
    s.index = undefined;
    s.failures = 0;
    s.lastError = null;
    s.inflight = undefined;
  }

  private dropSession(s: State): void {
    const session = s.session;
    s.session = undefined;
    if (session) void session.close().catch(() => undefined);
  }

  private clearRetry(s: State): void {
    if (s.retryTimer) clearTimeout(s.retryTimer);
    s.retryTimer = undefined;
  }
}
