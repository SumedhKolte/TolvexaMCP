import { readFile } from "node:fs/promises";

/**
 * The few Kubernetes API calls the provisioner makes, over plain HTTPS with the pod's
 * ServiceAccount token (re-read per call: kubelet rotates it). The cluster CA comes from
 * NODE_EXTRA_CA_CERTS, so Node's built-in fetch verifies the API server's certificate.
 *
 * What these calls may touch is limited by RBAC and, on top, by a
 * ValidatingAdmissionPolicy: only namespaces named store-* (charts/provisioner).
 */
export interface NamespaceInfo {
  labels: Record<string, string>;
  terminating: boolean;
}

export interface Kube {
  getNamespace(name: string): Promise<NamespaceInfo | null>;
  createNamespace(name: string, labels: Record<string, string>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  ensureRoleBinding(ns: string, name: string, clusterRole: string, subject: { name: string; namespace: string }): Promise<void>;
  getSecret(ns: string, name: string): Promise<Record<string, string> | null>;
  createSecret(ns: string, name: string, data: Record<string, string>): Promise<void>;
  patchSecret(ns: string, name: string, data: Record<string, string>): Promise<void>;
  getConfigMap(ns: string, name: string): Promise<Record<string, string> | null>;
  putConfigMap(ns: string, name: string, data: Record<string, string>): Promise<void>;
  /** Deployments (by name) that don't have an available replica yet. */
  unavailableDeployments(ns: string, names: string[]): Promise<string[]>;
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const MANAGED = { "app.kubernetes.io/managed-by": "team-mcp-provisioner" };

export class HttpKube implements Kube {
  private readonly base: string;

  constructor(env = process.env) {
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("not running in a cluster (KUBERNETES_SERVICE_HOST is unset)");
    this.base = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  }

  private async req(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<{ status: number; json: any }> {
    const token = (await readFile(`${SA_DIR}/token`, "utf8")).trim();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": contentType } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  private async ok(method: string, path: string, body?: unknown, contentType?: string, allow: number[] = []): Promise<any> {
    const r = await this.req(method, path, body, contentType);
    if (r.status >= 300 && !allow.includes(r.status)) {
      // Kubernetes Status messages name the object and the reason, never secret data.
      throw new KubeError(r.status, `${method} ${path.replace(/\?.*$/, "")}: ${r.status} ${r.json?.message ?? ""}`.trim().slice(0, 300));
    }
    return r;
  }

  async getNamespace(name: string): Promise<NamespaceInfo | null> {
    const r = await this.ok("GET", `/api/v1/namespaces/${name}`, undefined, undefined, [404]);
    if (r.status === 404) return null;
    return { labels: r.json.metadata?.labels ?? {}, terminating: Boolean(r.json.metadata?.deletionTimestamp) || r.json.status?.phase === "Terminating" };
  }

  async createNamespace(name: string, labels: Record<string, string>): Promise<void> {
    await this.ok("POST", "/api/v1/namespaces", { apiVersion: "v1", kind: "Namespace", metadata: { name, labels: { ...labels, ...MANAGED } } }, undefined, [409]);
  }

  async deleteNamespace(name: string): Promise<void> {
    await this.ok("DELETE", `/api/v1/namespaces/${name}`, undefined, undefined, [404]);
  }

  async ensureRoleBinding(ns: string, name: string, clusterRole: string, subject: { name: string; namespace: string }): Promise<void> {
    await this.ok(
      "POST",
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings`,
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name, namespace: ns, labels: MANAGED },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRole },
        subjects: [{ kind: "ServiceAccount", name: subject.name, namespace: subject.namespace }],
      },
      undefined,
      [409],
    );
  }

  async getSecret(ns: string, name: string): Promise<Record<string, string> | null> {
    const r = await this.ok("GET", `/api/v1/namespaces/${ns}/secrets/${name}`, undefined, undefined, [404]);
    if (r.status === 404) return null;
    return Object.fromEntries(Object.entries((r.json.data ?? {}) as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]));
  }

  async createSecret(ns: string, name: string, data: Record<string, string>): Promise<void> {
    await this.ok("POST", `/api/v1/namespaces/${ns}/secrets`, { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name, namespace: ns, labels: MANAGED }, stringData: data }, undefined, [409]);
  }

  async patchSecret(ns: string, name: string, data: Record<string, string>): Promise<void> {
    await this.ok("PATCH", `/api/v1/namespaces/${ns}/secrets/${name}`, { stringData: data }, "application/merge-patch+json");
  }

  async getConfigMap(ns: string, name: string): Promise<Record<string, string> | null> {
    const r = await this.ok("GET", `/api/v1/namespaces/${ns}/configmaps/${name}`, undefined, undefined, [404]);
    return r.status === 404 ? null : ((r.json.data ?? {}) as Record<string, string>);
  }

  async putConfigMap(ns: string, name: string, data: Record<string, string>): Promise<void> {
    const r = await this.ok("PATCH", `/api/v1/namespaces/${ns}/configmaps/${name}`, { data }, "application/merge-patch+json", [404]);
    if (r.status === 404) {
      await this.ok("POST", `/api/v1/namespaces/${ns}/configmaps`, { apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: ns, labels: MANAGED }, data });
    }
  }

  async unavailableDeployments(ns: string, names: string[]): Promise<string[]> {
    const r = await this.ok("GET", `/apis/apps/v1/namespaces/${ns}/deployments`);
    const available = new Set(
      ((r.json.items ?? []) as { metadata: { name: string }; status?: { availableReplicas?: number } }[])
        .filter((d) => (d.status?.availableReplicas ?? 0) >= 1)
        .map((d) => d.metadata.name),
    );
    return names.filter((n) => !available.has(n));
  }
}
