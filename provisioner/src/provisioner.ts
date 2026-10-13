import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Helm } from "./helm.js";
import type { Kube } from "./kube.js";
import { log } from "./log.js";

/**
 * One WooCommerce store per namespace (bonus). `ensure` and `remove` are idempotent and
 * return quickly; the slow work (helm --wait) runs in the background, one job per store.
 *
 * Durable state lives in the cluster, not in this process, so a restart mid-install is
 * safe: the next `ensure` finds the release left `pending-*` by the dead Helm process,
 * uninstalls it (the store's PVCs are kept by `helm.sh/resource-policy: keep`) and
 * installs again. A ConfigMap in the store's namespace counts attempts; after
 * MAX_ATTEMPTS the store is `failed` with Helm's error, until the gateway retries it with
 * a new attempt budget.
 */
export type Phase = "installing" | "ready" | "failed" | "deleting" | "gone";
export interface Status {
  phase: Phase;
  detail: string;
}

export interface ProvisionerOptions {
  /** Fingerprint of the bundled charts (computed once: the image is immutable). */
  chartsHash?: string;
  chartsDir: string;
  /** Environment values for tenant stores (global, store, wordpress, mariadb, wooMcp). */
  valuesFile: string;
  /** ClusterRole bound to this ServiceAccount inside each store namespace. */
  tenantClusterRole: string;
  serviceAccount: { name: string; namespace: string };
  helmTimeout: string;
  maxAttempts: number;
}

export const SLUG_RE = /^store-[a-z][a-z0-9-]{0,22}[a-z0-9]$/;

/** sha256 over every file of a directory tree (sorted paths + contents). */
export function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(dir.length)).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}
const STATE = "provisioner-state";
const TENANT_LABEL = "team-mcp/tenant";
const WORKLOADS = ["mariadb", "wordpress", "woo-mcp"];

const rand = (bytes: number) => randomBytes(bytes).toString("hex");
const randPass = () => randomBytes(18).toString("base64url");

interface Job {
  kind: "install" | "remove";
  /** An in-place upgrade of a ready store (it keeps serving meanwhile). */
  upgrade?: boolean;
  step: string;
  child?: ChildProcess;
}

export class Provisioner {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly kube: Kube,
    private readonly helm: Helm,
    private readonly opts: ProvisionerOptions,
  ) {}

  /**
   * What a store should be running: charts + environment values + its host. Recorded in
   * the store's state ConfigMap after each successful install; a mismatch on a ready
   * store (new provisioner image, changed values) triggers a background upgrade.
   */
  private desiredHash(host: string): string {
    let values = "";
    try {
      values = readFileSync(this.opts.valuesFile, "utf8");
    } catch {
      /* tests without a values file */
    }
    return createHash("sha256").update(this.opts.chartsHash ?? "").update("\0").update(values).update("\0").update(host).digest("hex");
  }

  /** For tests and graceful shutdown. */
  idle(): boolean {
    return this.jobs.size === 0;
  }

  async ensure(slug: string, req: { host: string; wooMcpToken: string; attemptBudget: string }): Promise<Status> {
    const ns = slug;
    const job = this.jobs.get(slug);
    if (job?.kind === "remove") return { phase: "deleting", detail: "A previous store with this name is still being deleted" };

    const existing = await this.kube.getNamespace(ns);
    if (existing?.terminating) return { phase: "deleting", detail: "A previous store with this name is still being deleted" };
    if (existing && existing.labels[TENANT_LABEL] !== "true") return { phase: "failed", detail: `Namespace ${ns} exists and isn't a provisioned store` };
    if (!existing) {
      await this.kube.createNamespace(ns, {
        [TENANT_LABEL]: "true",
        "team-mcp/store": slug,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
        "pod-security.kubernetes.io/warn": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
      });
      log({ msg: "namespace created", store: slug });
    }
    // Our rights inside the store namespace (the tenant ClusterRole, bound here only).
    await this.kube.ensureRoleBinding(ns, "team-mcp-provisioner", this.opts.tenantClusterRole, this.opts.serviceAccount);
    await this.ensureSecrets(ns, req.host, req.wooMcpToken);

    if (job) return job.upgrade ? { phase: "ready", detail: `Upgrading: ${job.step}` } : { phase: "installing", detail: job.step };

    const releases = new Map((await this.helm.list(ns)).map((r) => [r.name, r.status]));
    const store = releases.get(slug);
    const mcp = releases.get(`${slug}-mcp`);
    const state = (await this.kube.getConfigMap(ns, STATE)) ?? {};
    const desired = this.desiredHash(req.host);
    if (store === "deployed" && mcp === "deployed") {
      const waiting = await this.kube.unavailableDeployments(ns, WORKLOADS);
      if (waiting.length) return { phase: "installing", detail: `Waiting for ${waiting.join(", ")}` };
      if (state.appliedHash && state.appliedHash !== desired) {
        // Charts or values changed since this store was installed: upgrade it in place,
        // in the background. It keeps serving (rolling updates) and stays "ready".
        this.startInstall(slug, req.host, { store, mcp }, 1, desired, true);
        log({ msg: "upgrading store to the current charts/values", store: slug });
        return { phase: "ready", detail: "Upgrading to the current version in the background" };
      }
      if (!state.appliedHash) await this.kube.putConfigMap(ns, STATE, { appliedHash: desired });
      return { phase: "ready", detail: "" };
    }

    let attempts = Number(state.attempts ?? 0);
    if (state.budget !== req.attemptBudget) attempts = 0; // the gateway started a new try
    if (attempts >= this.opts.maxAttempts) {
      return { phase: "failed", detail: `Failed after ${attempts} attempts: ${state.lastError || "unknown error"}` };
    }
    attempts += 1;
    await this.kube.putConfigMap(ns, STATE, { attempts: String(attempts), budget: req.attemptBudget, lastError: state.lastError ?? "" });
    this.startInstall(slug, req.host, { store, mcp }, attempts, desired, false);
    return { phase: "installing", detail: `Starting install (attempt ${attempts} of ${this.opts.maxAttempts})` };
  }

  private async ensureSecrets(ns: string, host: string, wooMcpToken: string): Promise<void> {
    let db = await this.kube.getSecret(ns, "mariadb-secrets");
    if (!db) {
      db = { MARIADB_ROOT_PASSWORD: rand(24), MARIADB_PASSWORD: rand(24) };
      await this.kube.createSecret(ns, "mariadb-secrets", db);
    }
    if (!(await this.kube.getSecret(ns, "wordpress-secrets"))) {
      await this.kube.createSecret(ns, "wordpress-secrets", {
        WORDPRESS_DB_PASSWORD: db.MARIADB_PASSWORD as string,
        WP_ADMIN_USER: "storeadmin",
        WP_ADMIN_PASSWORD: randPass(),
        WP_ADMIN_EMAIL: `admin@${host}`,
        WORDPRESS_SALT: rand(32),
      });
    }
    // The gateway's bearer for this store's woo-mcp; the store-init Job adds the WC keys.
    const mcp = await this.kube.getSecret(ns, "woo-mcp-secrets");
    if (!mcp) await this.kube.createSecret(ns, "woo-mcp-secrets", { WOO_MCP_BEARER_TOKEN: wooMcpToken });
    else if (mcp.WOO_MCP_BEARER_TOKEN !== wooMcpToken) await this.kube.patchSecret(ns, "woo-mcp-secrets", { WOO_MCP_BEARER_TOKEN: wooMcpToken });
  }

  private startInstall(slug: string, host: string, current: { store?: string; mcp?: string }, attempt: number, desired: string, upgrade: boolean): void {
    const ns = slug;
    const job: Job = { kind: "install", step: upgrade ? "Upgrading" : "Starting install", upgrade };
    this.jobs.set(slug, job);
    const onChild = (c: ChildProcess) => (job.child = c);
    const common = { namespace: ns, valuesFile: this.opts.valuesFile, timeout: this.opts.helmTimeout };
    void (async () => {
      try {
        // A release left pending-* by a Helm process that died (provisioner restart)
        // blocks every further operation; remove it and start over.
        for (const [release, status] of [[slug, current.store], [`${slug}-mcp`, current.mcp]] as const) {
          if (status?.startsWith("pending")) {
            job.step = `Cleaning up an interrupted install (${release})`;
            log({ msg: "cleaning up an interrupted install", store: slug, release, status });
            await this.helm.uninstall(ns, release, onChild);
          }
        }
        job.step = `Installing WordPress, MariaDB and WooCommerce (attempt ${attempt}; takes a few minutes)`;
        await this.helm.upgradeInstall(
          { ...common, release: slug, chart: `${this.opts.chartsDir}/store`, setString: { "global.storeHost": host }, set: { "tenant.enabled": "true" } },
          onChild,
        );
        job.step = "Installing the WooCommerce MCP server";
        await this.helm.upgradeInstall({ ...common, release: `${slug}-mcp`, chart: `${this.opts.chartsDir}/woo-mcp`, setString: { "global.storeHost": host }, set: {} }, onChild);
        await this.kube.putConfigMap(ns, STATE, { lastError: "", appliedHash: desired });
        log({ msg: upgrade ? "store upgraded" : "store installed", store: slug, attempt });
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        log({ msg: "store install failed", store: slug, attempt, error: message });
        await this.kube.putConfigMap(ns, STATE, { lastError: message }).catch(() => undefined);
      } finally {
        if (this.jobs.get(slug) === job) this.jobs.delete(slug);
      }
    })();
  }

  async remove(slug: string): Promise<Status> {
    const ns = slug;
    const job = this.jobs.get(slug);
    if (job?.kind === "remove") return { phase: "deleting", detail: job.step };
    const existing = await this.kube.getNamespace(ns);
    if (!existing) return { phase: "gone", detail: "" };
    if (existing.labels[TENANT_LABEL] !== "true") return { phase: "failed", detail: `Namespace ${ns} isn't a provisioned store; not deleting it` };
    if (existing.terminating) return { phase: "deleting", detail: "Deleting the namespace" };

    if (job?.child) job.child.kill("SIGTERM"); // stop an install in progress
    const removal: Job = { kind: "remove", step: "Uninstalling" };
    this.jobs.set(slug, removal);
    const onChild = (c: ChildProcess) => (removal.child = c);
    void (async () => {
      try {
        removal.step = "Uninstalling the WooCommerce MCP server";
        await this.helm.uninstall(ns, `${slug}-mcp`, onChild);
        removal.step = "Uninstalling the store";
        await this.helm.uninstall(ns, slug, onChild);
      } catch (err) {
        // The namespace deletion below removes everything anyway.
        log({ msg: "helm uninstall failed; deleting the namespace anyway", store: slug, error: (err as Error).message.slice(0, 300) });
      }
      try {
        removal.step = "Deleting the namespace";
        await this.kube.deleteNamespace(ns);
        log({ msg: "store namespace deleted", store: slug });
      } catch (err) {
        log({ msg: "namespace delete failed", store: slug, error: (err as Error).message.slice(0, 300) });
      } finally {
        if (this.jobs.get(slug) === removal) this.jobs.delete(slug);
      }
    })();
    return { phase: "deleting", detail: "Uninstalling" };
  }
}
