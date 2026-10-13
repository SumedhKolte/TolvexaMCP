import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Helm, Release, UpgradeInstall } from "../src/helm.js";
import { summarizeHelmError } from "../src/helm.js";
import type { Kube, NamespaceInfo } from "../src/kube.js";
import { Provisioner } from "../src/provisioner.js";
import { createApi } from "../src/server.js";

/** In-memory Kubernetes: namespaces, secrets, configmaps, rolebindings, deployments. */
class FakeKube implements Kube {
  ns = new Map<string, NamespaceInfo>();
  secrets = new Map<string, Record<string, string>>();
  cms = new Map<string, Record<string, string>>();
  bindings: string[] = [];
  available = new Set<string>();
  async getNamespace(name: string) {
    return this.ns.get(name) ?? null;
  }
  async createNamespace(name: string, labels: Record<string, string>) {
    if (!this.ns.has(name)) this.ns.set(name, { labels, terminating: false });
  }
  async deleteNamespace(name: string) {
    const n = this.ns.get(name);
    if (n) n.terminating = true;
  }
  async ensureRoleBinding(ns: string, name: string, role: string, sa: { name: string; namespace: string }) {
    const b = `${ns}/${name}->${role}:${sa.namespace}/${sa.name}`;
    if (!this.bindings.includes(b)) this.bindings.push(b);
  }
  async getSecret(ns: string, name: string) {
    return this.secrets.get(`${ns}/${name}`) ?? null;
  }
  async createSecret(ns: string, name: string, data: Record<string, string>) {
    if (!this.secrets.has(`${ns}/${name}`)) this.secrets.set(`${ns}/${name}`, { ...data });
  }
  async patchSecret(ns: string, name: string, data: Record<string, string>) {
    this.secrets.set(`${ns}/${name}`, { ...(this.secrets.get(`${ns}/${name}`) ?? {}), ...data });
  }
  async getConfigMap(ns: string, name: string) {
    return this.cms.get(`${ns}/${name}`) ?? null;
  }
  async putConfigMap(ns: string, name: string, data: Record<string, string>) {
    this.cms.set(`${ns}/${name}`, { ...(this.cms.get(`${ns}/${name}`) ?? {}), ...data });
  }
  async unavailableDeployments(ns: string, names: string[]) {
    return names.filter((n) => !this.available.has(`${ns}/${n}`));
  }
}

/** Helm that records calls; `fail` makes the next install throw; `releases` is the cluster's view. */
class FakeHelm implements Helm {
  releases = new Map<string, Release[]>();
  calls: string[] = [];
  fail: string | null = null;
  gate: Promise<void> = Promise.resolve();
  async list(ns: string) {
    return this.releases.get(ns) ?? [];
  }
  async upgradeInstall(o: UpgradeInstall) {
    this.calls.push(`install ${o.release} host=${o.setString["global.storeHost"]} tenant=${o.set["tenant.enabled"] ?? "-"}`);
    await this.gate;
    if (this.fail) {
      const f = this.fail;
      this.fail = null;
      this.set(o.namespace, o.release, "failed");
      throw new Error(f);
    }
    this.set(o.namespace, o.release, "deployed");
  }
  async uninstall(ns: string, release: string) {
    this.calls.push(`uninstall ${release}`);
    this.releases.set(ns, (this.releases.get(ns) ?? []).filter((r) => r.name !== release));
  }
  set(ns: string, name: string, status: string) {
    this.releases.set(ns, [...(this.releases.get(ns) ?? []).filter((r) => r.name !== name), { name, status }]);
  }
}

const opts = {
  chartsDir: "/app/charts",
  valuesFile: "/config/tenant-values.yaml",
  tenantClusterRole: "team-mcp-store-tenant",
  serviceAccount: { name: "provisioner", namespace: "provisioner" },
  helmTimeout: "12m",
  maxAttempts: 2,
};
const req = { host: "store-a.localtest.me", wooMcpToken: "t".repeat(64), attemptBudget: "b1" };
const settle = () => new Promise((r) => setTimeout(r, 10));
function setup() {
  const kube = new FakeKube();
  const helm = new FakeHelm();
  return { kube, helm, p: new Provisioner(kube, helm, opts) };
}

describe("ensure", () => {
  it("creates a restricted, labelled namespace, binds the tenant role, creates consistent secrets, installs both charts", async () => {
    const { kube, helm, p } = setup();
    let release!: () => void;
    helm.gate = new Promise((r) => (release = r));
    expect(await p.ensure("store-a", req)).toMatchObject({ phase: "installing", detail: "Starting install (attempt 1 of 2)" });
    expect(kube.ns.get("store-a")?.labels).toMatchObject({ "team-mcp/tenant": "true", "pod-security.kubernetes.io/enforce": "restricted" });
    expect(kube.bindings).toEqual(["store-a/team-mcp-provisioner->team-mcp-store-tenant:provisioner/provisioner"]);
    const db = kube.secrets.get("store-a/mariadb-secrets") as Record<string, string>;
    const wp = kube.secrets.get("store-a/wordpress-secrets") as Record<string, string>;
    expect(wp.WORDPRESS_DB_PASSWORD).toBe(db.MARIADB_PASSWORD);
    expect(wp.WP_ADMIN_EMAIL).toBe("admin@store-a.localtest.me");
    expect(kube.secrets.get("store-a/woo-mcp-secrets")).toEqual({ WOO_MCP_BEARER_TOKEN: req.wooMcpToken });
    // While Helm runs, repeated calls report progress and start nothing new.
    await settle();
    expect((await p.ensure("store-a", req)).detail).toMatch(/^Installing WordPress/);
    release();
    await settle();
    expect(helm.calls).toEqual(["install store-a host=store-a.localtest.me tenant=true", "install store-a-mcp host=store-a.localtest.me tenant=-"]);
    expect(await p.ensure("store-a", req)).toEqual({ phase: "installing", detail: "Waiting for mariadb, wordpress, woo-mcp" });
    for (const d of ["mariadb", "wordpress", "woo-mcp"]) kube.available.add(`store-a/${d}`);
    expect(await p.ensure("store-a", req)).toEqual({ phase: "ready", detail: "" });
    expect(helm.calls).toHaveLength(2); // ready stores aren't reinstalled
  });

  it("keeps existing secrets but follows a changed gateway token", async () => {
    const { kube, p } = setup();
    await p.ensure("store-a", req);
    const before = kube.secrets.get("store-a/mariadb-secrets");
    kube.secrets.set("store-a/woo-mcp-secrets", { WOO_MCP_BEARER_TOKEN: "old", WC_CONSUMER_KEY: "ck" });
    await settle();
    await p.ensure("store-a", { ...req, wooMcpToken: "n".repeat(64) });
    expect(kube.secrets.get("store-a/mariadb-secrets")).toBe(before);
    expect(kube.secrets.get("store-a/woo-mcp-secrets")).toEqual({ WOO_MCP_BEARER_TOKEN: "n".repeat(64), WC_CONSUMER_KEY: "ck" });
  });

  it("retries a failed install, gives up after maxAttempts with Helm's error, and resets on a new budget", async () => {
    const { helm, p } = setup();
    helm.fail = "timed out waiting for the condition";
    await p.ensure("store-a", req);
    await settle();
    helm.fail = "timed out waiting for the condition";
    expect((await p.ensure("store-a", req)).detail).toBe("Starting install (attempt 2 of 2)");
    await settle();
    expect(await p.ensure("store-a", req)).toEqual({ phase: "failed", detail: "Failed after 2 attempts: timed out waiting for the condition" });
    // The gateway's retry sends a new budget: a fresh attempt, which succeeds.
    expect((await p.ensure("store-a", { ...req, attemptBudget: "b2" })).detail).toBe("Starting install (attempt 1 of 2)");
    await settle();
    expect(helm.releases.get("store-a")?.map((r) => r.status)).toEqual(["deployed", "deployed"]);
  });

  it("recovers from a provisioner restart mid-install: a pending release is uninstalled and reinstalled", async () => {
    const { helm, p } = setup();
    helm.set("store-a", "store-a", "pending-install"); // left behind by a Helm process that died
    await p.ensure("store-a", req);
    await settle();
    expect(helm.calls).toEqual(["uninstall store-a", "install store-a host=store-a.localtest.me tenant=true", "install store-a-mcp host=store-a.localtest.me tenant=-"]);
  });

  it("upgrades a ready store in place when the charts or values change, staying ready", async () => {
    const kube = new FakeKube();
    const helm = new FakeHelm();
    const v1 = new Provisioner(kube, helm, { ...opts, chartsHash: "charts-v1" });
    await v1.ensure("store-a", req);
    await settle();
    for (const d of ["mariadb", "wordpress", "woo-mcp"]) kube.available.add(`store-a/${d}`);
    expect(await v1.ensure("store-a", req)).toEqual({ phase: "ready", detail: "" });
    expect(await v1.ensure("store-a", req)).toEqual({ phase: "ready", detail: "" }); // same version: nothing to do
    expect(helm.calls).toHaveLength(2);
    // A new provisioner image (new charts) sees the old fingerprint and upgrades.
    const v2 = new Provisioner(kube, helm, { ...opts, chartsHash: "charts-v2" });
    expect(await v2.ensure("store-a", req)).toEqual({ phase: "ready", detail: "Upgrading to the current version in the background" });
    await settle();
    expect(helm.calls).toHaveLength(4);
    expect(await v2.ensure("store-a", req)).toEqual({ phase: "ready", detail: "" });
    expect(helm.calls).toHaveLength(4);
  });

  it("never adopts a namespace that isn't a provisioned store", async () => {
    const { kube, p } = setup();
    kube.ns.set("store-x", { labels: {}, terminating: false });
    expect(await p.ensure("store-x", req)).toEqual({ phase: "failed", detail: "Namespace store-x exists and isn't a provisioned store" });
    expect(await p.remove("store-x")).toEqual({ phase: "failed", detail: "Namespace store-x isn't a provisioned store; not deleting it" });
    expect(kube.ns.get("store-x")?.terminating).toBe(false);
  });
});

describe("remove", () => {
  it("uninstalls both releases, deletes the namespace, then reports gone", async () => {
    const { kube, helm, p } = setup();
    await p.ensure("store-a", req);
    await settle();
    helm.calls.length = 0;
    expect((await p.remove("store-a")).phase).toBe("deleting");
    await settle();
    expect(helm.calls).toEqual(["uninstall store-a-mcp", "uninstall store-a"]);
    expect(await p.remove("store-a")).toEqual({ phase: "deleting", detail: "Deleting the namespace" });
    kube.ns.delete("store-a"); // Kubernetes finished deleting it
    expect(await p.remove("store-a")).toEqual({ phase: "gone", detail: "" });
    // Re-creating with the same name while a namespace is still terminating waits.
    kube.ns.set("store-a", { labels: { "team-mcp/tenant": "true" }, terminating: true });
    expect((await p.ensure("store-a", req)).phase).toBe("deleting");
  });
});

describe("HTTP API", () => {
  it("requires the bearer token and validates input", async () => {
    const { p } = setup();
    const server = createApi(p, "s".repeat(40)).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, token: string | null, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    expect((await call("GET", "/healthz", null)).status).toBe(200);
    expect((await call("PUT", "/v1/stores/store-ab", null, req)).status).toBe(401);
    expect((await call("PUT", "/v1/stores/store-ab", "wrong", req)).status).toBe(401);
    expect((await call("PUT", "/v1/stores/platform", "s".repeat(40), req)).status).toBe(400);
    expect((await call("PUT", "/v1/stores/store-ab", "s".repeat(40), { host: "x" })).status).toBe(400);
    // Store names need 2+ characters (same rule as the gateway), so "store-a" is invalid.
    expect((await call("PUT", "/v1/stores/store-a", "s".repeat(40), req)).status).toBe(400);
    const ok = await call("PUT", "/v1/stores/store-ab", "s".repeat(40), req);
    expect(ok.status).toBe(200);
    expect((await ok.json()).phase).toBe("installing");
    server.close();
  });
});

describe("helm errors", () => {
  it("reports only the final error line", () => {
    expect(summarizeHelmError("walk.go:75: debug stuff\nError: INSTALLATION FAILED: context deadline exceeded\n")).toBe("INSTALLATION FAILED: context deadline exceeded");
  });
});
