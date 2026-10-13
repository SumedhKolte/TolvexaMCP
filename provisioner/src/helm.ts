import { execFile, type ChildProcess } from "node:child_process";

/**
 * Helm 3 CLI (pinned binary in the image). It finds the cluster through the pod's
 * in-cluster config. Only the last line of Helm's stderr is ever reported: it's the error
 * summary, and it never contains rendered Secret values.
 */
export interface Release {
  name: string;
  status: string; // deployed | failed | pending-install | pending-upgrade | ...
}

export interface UpgradeInstall {
  release: string;
  namespace: string;
  chart: string;
  valuesFile: string;
  setString: Record<string, string>;
  set: Record<string, string>;
  timeout: string;
}

export interface Helm {
  list(namespace: string): Promise<Release[]>;
  upgradeInstall(o: UpgradeInstall, onChild?: (c: ChildProcess) => void): Promise<void>;
  uninstall(namespace: string, release: string, onChild?: (c: ChildProcess) => void): Promise<void>;
}

export class HelmError extends Error {}

const ENV = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST ?? "",
  KUBERNETES_SERVICE_PORT: process.env.KUBERNETES_SERVICE_PORT ?? "",
  // Read-only root filesystem: Helm's caches and config go to the /tmp emptyDir.
  HOME: "/tmp",
  HELM_CACHE_HOME: "/tmp/helm/cache",
  HELM_CONFIG_HOME: "/tmp/helm/config",
  HELM_DATA_HOME: "/tmp/helm/data",
};

export function summarizeHelmError(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.filter((l) => /error/i.test(l)).at(-1) ?? lines.at(-1) ?? "helm failed";
  return last.replace(/^Error:\s*/i, "").slice(0, 300);
}

export class CliHelm implements Helm {
  constructor(private readonly bin = "helm") {}

  private run(args: string[], timeoutMs: number, onChild?: (c: ChildProcess) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.bin, args, { env: ENV, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new HelmError(summarizeHelmError(String(stderr) || err.message)));
        else resolve(String(stdout));
      });
      onChild?.(child);
    });
  }

  async list(namespace: string): Promise<Release[]> {
    const out = await this.run(["list", "-n", namespace, "-a", "-o", "json"], 30_000);
    return (JSON.parse(out || "[]") as { name: string; status: string }[]).map((r) => ({ name: r.name, status: r.status }));
  }

  async upgradeInstall(o: UpgradeInstall, onChild?: (c: ChildProcess) => void): Promise<void> {
    const args = ["upgrade", "--install", o.release, o.chart, "-n", o.namespace, "-f", o.valuesFile, "--wait", "--timeout", o.timeout];
    for (const [k, v] of Object.entries(o.setString)) args.push("--set-string", `${k}=${v}`);
    for (const [k, v] of Object.entries(o.set)) args.push("--set", `${k}=${v}`);
    await this.run(args, 20 * 60_000, onChild);
  }

  async uninstall(namespace: string, release: string, onChild?: (c: ChildProcess) => void): Promise<void> {
    try {
      await this.run(["uninstall", release, "-n", namespace, "--wait", "--timeout", "5m"], 6 * 60_000, onChild);
    } catch (err) {
      if (!/not found/i.test((err as Error).message)) throw err;
    }
  }
}
