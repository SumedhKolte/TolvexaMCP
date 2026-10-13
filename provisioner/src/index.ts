import { readFileSync } from "node:fs";
import { z } from "zod";
import { CliHelm } from "./helm.js";
import { HttpKube } from "./kube.js";
import { log } from "./log.js";
import { hashTree, Provisioner } from "./provisioner.js";
import { createApi } from "./server.js";

const env = z
  .object({
    PORT: z.coerce.number().int().default(8080),
    /** File holding the shared gateway <-> provisioner token (mounted Secret). */
    PROVISIONER_TOKEN_FILE: z.string().default("/var/run/secrets/provisioner/PROVISIONER_TOKEN"),
    CHARTS_DIR: z.string().default("/app/charts"),
    VALUES_FILE: z.string().default("/config/tenant-values.yaml"),
    TENANT_CLUSTER_ROLE: z.string().min(1),
    SERVICE_ACCOUNT: z.string().min(1),
    POD_NAMESPACE: z.string().min(1),
    HELM_TIMEOUT: z.string().regex(/^\d+[ms]$/).default("12m"),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  })
  .parse(process.env);

const token = readFileSync(env.PROVISIONER_TOKEN_FILE, "utf8").trim();
if (token.length < 32) throw new Error("PROVISIONER_TOKEN must be at least 32 characters");

const provisioner = new Provisioner(new HttpKube(), new CliHelm(), {
  chartsDir: env.CHARTS_DIR,
  chartsHash: hashTree(env.CHARTS_DIR),
  valuesFile: env.VALUES_FILE,
  tenantClusterRole: env.TENANT_CLUSTER_ROLE,
  serviceAccount: { name: env.SERVICE_ACCOUNT, namespace: env.POD_NAMESPACE },
  helmTimeout: env.HELM_TIMEOUT,
  maxAttempts: env.MAX_ATTEMPTS,
});
const server = createApi(provisioner, token).listen(env.PORT, () => log({ msg: "listening", port: env.PORT }));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    // In-flight Helm runs die with us; the next ensure() cleans up their pending releases.
    log({ msg: "shutting down", signal: sig, busy: !provisioner.idle() });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
