/**
 * Client for the provisioner service (charts/provisioner, ../../provisioner). The gateway
 * never touches the Kubernetes API itself: the provisioner is the only component with
 * cluster rights, and those are fenced to store-* namespaces (docs/design.md D10.2).
 *
 * Both calls are idempotent and cheap: they report where a store is and nudge it forward
 * (start or resume an install, start an uninstall). The gateway's reconciler calls them
 * repeatedly until the store is ready, failed, or gone.
 */
export type ProvisionPhase = "installing" | "ready" | "failed" | "deleting" | "gone";

export interface ProvisionStatus {
  phase: ProvisionPhase;
  detail: string;
}

export interface ProvisionerClient {
  /**
   * Create or resume the store. `wooMcpToken` is the bearer the gateway will use for it.
   * `attemptBudget` identifies this try (the store's deadline): a new value gives the
   * provisioner a fresh set of attempts after a failure.
   */
  ensure(slug: string, req: EnsureRequest): Promise<ProvisionStatus>;
  /** Start or continue deleting the store; "gone" once its namespace no longer exists. */
  remove(slug: string): Promise<ProvisionStatus>;
}

export interface EnsureRequest {
  host: string;
  wooMcpToken: string;
  attemptBudget: string;
}

export class ProvisionerError extends Error {}

const PHASES = new Set<ProvisionPhase>(["installing", "ready", "failed", "deleting", "gone"]);

export class HttpProvisionerClient implements ProvisionerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {}

  ensure(slug: string, req: EnsureRequest): Promise<ProvisionStatus> {
    return this.call("PUT", slug, req);
  }

  remove(slug: string): Promise<ProvisionStatus> {
    return this.call("DELETE", slug);
  }

  private async call(method: string, slug: string, body?: unknown): Promise<ProvisionStatus> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/stores/${encodeURIComponent(slug)}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // No URLs or tokens in the message: it ends up in the dashboard.
      throw new ProvisionerError(`provisioner unreachable (${(err as Error).name === "TimeoutError" ? "timeout" : "connection failed"})`);
    }
    const json = (await res.json().catch(() => null)) as { phase?: string; detail?: string; error?: { message?: string } } | null;
    if (!res.ok) throw new ProvisionerError(`provisioner answered ${res.status}: ${json?.error?.message ?? "no details"}`.slice(0, 300));
    if (!json || !PHASES.has(json.phase as ProvisionPhase)) throw new ProvisionerError("provisioner sent an invalid answer");
    return { phase: json.phase as ProvisionPhase, detail: String(json.detail ?? "").slice(0, 500) };
  }
}
