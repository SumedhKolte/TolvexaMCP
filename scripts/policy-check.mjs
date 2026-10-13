#!/usr/bin/env node
// Production-readiness policy check (Phase 8). Renders every chart with BOTH values files
// (helm template, no cluster needed) and checks every workload and object against the
// rules of spec sections 5 and 6. Prints one line per rule and exits 1 on any violation.
//
//   node scripts/policy-check.mjs            (also run by scripts/helm-check.sh)
//
// Exceptions are listed below, each with its reason; they're mirrored in
// docs/threat-model.md ("Policy checklist"). Anything not listed must comply.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse, parseAllDocuments } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// release, chart dir, namespace, extra args: exactly how up-local.sh installs them.
const RELEASES = [
  ["store", "store", "store", []],
  ["woo-mcp", "woo-mcp", "store", []],
  ["platform", "platform", "platform", []],
  ["mcp-notes", "upstream-mcp", "upstreams", ["--set", "instance=notes"]],
  ["mcp-slow", "upstream-mcp", "upstreams", ["--set", "instance=slow"]],
  // Multi-store bonus: the provisioner, and a sample store exactly as it installs one.
  ["provisioner", "provisioner", "provisioner", []],
  // @HOST@ = store-example + the environment's global.stores.hostSuffix.
  ["store-example", "store", "store-example", ["--set", "tenant.enabled=true", "--set-string", "global.storeHost=@HOST@"]],
  ["store-example-mcp", "woo-mcp", "store-example", ["--set-string", "global.storeHost=@HOST@"]],
];

/**
 * Documented exceptions: "<namespace>/<workload>/<container>" -> rule -> reason.
 * @type {Record<string, Record<string, string>>}
 * Keep in sync with docs/threat-model.md.
 */
const EXCEPTIONS = {
  // None needed: every container, WordPress and MariaDB included, runs as non-root with a
  // read-only root filesystem (writable paths are emptyDirs/PVCs). Example entry:
  // "store/wordpress/wordpress": { readOnlyRootFilesystem: "reason" },
};
const automountAllowed = new Set([
  // Needs the API to patch exactly one Secret (woo-mcp-secrets) with the WooCommerce REST keys.
  "store/store-init",
  "store-example/store-init",
  // Multi-store bonus: creates store namespaces and installs charts (rights fenced to
  // store-* by RBAC + a ValidatingAdmissionPolicy; checked below).
  "provisioner/provisioner",
]);
/** The only cluster-scoped RBAC allowed, with exactly these rules (multi-store bonus). */
const ALLOWED_CLUSTER_ROLES = {
  "team-mcp-provisioner": [
    { apiGroups: [""], resources: ["namespaces"], verbs: ["get", "create", "delete"] },
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"], verbs: ["create"] },
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"], verbs: ["bind"], resourceNames: ["team-mcp-store-tenant"] },
  ],
};

const results = [];
let failures = 0;
const check = (env, rule, ok, detail = "") => {
  if (!ok) failures++;
  results.push(`${ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m"} [${env}] ${rule}${detail ? ` — ${detail}` : ""}`);
};

function render(env) {
  const values = join(process.env.POLICY_VALUES_DIR ?? join(ROOT, "values"), `values-${env}.yaml`);
  const host = `store-example${parse(readFileSync(values, "utf8"))?.global?.stores?.hostSuffix ?? ".localtest.me"}`;
  const objects = [];
  for (const [release, chart, ns, rawExtra] of RELEASES) {
    const extra = rawExtra.map((a) => a.replace("@HOST@", host));
    const out = execFileSync("helm", ["template", release, join(ROOT, "charts", chart), "-n", ns, "-f", values, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const doc of parseAllDocuments(out)) {
      const o = doc.toJS();
      if (o && o.kind) objects.push({ ...o, metadata: { ...o.metadata, namespace: o.metadata?.namespace ?? ns } });
    }
  }
  return objects;
}

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"]);
const podSpecOf = (o) => (o.kind === "Pod" ? o.spec : o.kind === "CronJob" ? o.spec.jobTemplate.spec.template.spec : o.spec.template.spec);

for (const env of ["local", "prod"]) {
  const objects = render(env);
  const v = []; // violations for the aggregated rules
  const workloads = objects.filter((o) => WORKLOADS.has(o.kind));
  const containers = [];
  for (const w of workloads) {
    const spec = podSpecOf(w);
    const id = `${w.metadata.namespace}/${w.metadata.name}`;
    for (const c of spec.initContainers ?? []) containers.push({ w, spec, id, c, init: true });
    for (const c of spec.containers ?? []) containers.push({ w, spec, id, c, init: false });
  }
  const exempt = (x, rule) => EXCEPTIONS[`${x.id}/${x.c.name}`]?.[rule];

  // --- resources: every container, including init containers
  const noRes = containers.filter(({ c }) => !(c.resources?.requests?.cpu && c.resources?.requests?.memory && c.resources?.limits?.cpu && c.resources?.limits?.memory));
  check(env, `requests and limits (cpu+memory) on all ${containers.length} containers, incl. init`, noRes.length === 0, noRes.map((x) => `${x.id}/${x.c.name}`).join(", "));

  // --- probes: long-running workloads' main containers
  const longRunning = containers.filter((x) => !x.init && ["Deployment", "StatefulSet", "DaemonSet"].includes(x.w.kind));
  const noProbe = longRunning.filter(({ c }) => !c.livenessProbe || !c.readinessProbe);
  check(env, `liveness + readiness probes on all ${longRunning.length} long-running containers`, noProbe.length === 0, noProbe.map((x) => `${x.id}/${x.c.name}`).join(", "));

  // --- security context
  const sc = (x, key) => x.c.securityContext?.[key] ?? x.spec.securityContext?.[key];
  const bad = (pred, rule) => containers.filter((x) => !pred(x) && !exempt(x, rule)).map((x) => `${x.id}/${x.c.name}`);
  const r1 = bad((x) => x.c.securityContext?.allowPrivilegeEscalation === false, "allowPrivilegeEscalation");
  check(env, "allowPrivilegeEscalation: false everywhere", r1.length === 0, r1.join(", "));
  const r2 = bad((x) => (x.c.securityContext?.capabilities?.drop ?? []).includes("ALL") && !(x.c.securityContext?.capabilities?.add ?? []).length, "capabilities");
  check(env, "capabilities: drop ALL, add none", r2.length === 0, r2.join(", "));
  const r3 = bad((x) => sc(x, "runAsNonRoot") === true, "runAsNonRoot");
  check(env, "runAsNonRoot: true everywhere", r3.length === 0, r3.join(", "));
  const r4 = bad((x) => x.c.securityContext?.readOnlyRootFilesystem === true, "readOnlyRootFilesystem");
  const r4ex = containers.filter((x) => x.c.securityContext?.readOnlyRootFilesystem !== true && exempt(x, "readOnlyRootFilesystem")).map((x) => `${x.id}/${x.c.name}`);
  check(env, `readOnlyRootFilesystem: true (documented exceptions: ${r4ex.join(", ") || "none"})`, r4.length === 0, r4.join(", "));
  const r5 = bad((x) => sc(x, "seccompProfile")?.type === "RuntimeDefault", "seccompProfile");
  check(env, "seccompProfile: RuntimeDefault everywhere", r5.length === 0, r5.join(", "));
  const r6 = containers.filter((x) => x.c.securityContext?.privileged).map((x) => `${x.id}/${x.c.name}`);
  check(env, "no privileged containers", r6.length === 0, r6.join(", "));
  const hostish = workloads.filter((w) => {
    const s = podSpecOf(w);
    return s.hostNetwork || s.hostPID || s.hostIPC || (s.volumes ?? []).some((vol) => vol.hostPath);
  });
  check(env, "no hostNetwork/hostPID/hostIPC/hostPath", hostish.length === 0, hostish.map((w) => w.metadata.name).join(", "));
  const tokens = workloads.filter((w) => podSpecOf(w).automountServiceAccountToken !== false && !automountAllowed.has(`${w.metadata.namespace}/${w.metadata.name}`));
  check(env, "service account tokens not mounted (except store-init)", tokens.length === 0, tokens.map((w) => w.metadata.name).join(", "));

  // --- images
  const images = containers.map((x) => x.c);
  const badTag = images.filter((c) => !/:[^/]+$/.test(c.image) || /:latest$/.test(c.image));
  check(env, "every image has a pinned tag (no :latest)", badTag.length === 0, badTag.map((c) => c.image).join(", "));
  const wantPull = env === "prod" ? "Always" : "IfNotPresent";
  const ownImages = images.filter((c) => c.image.includes("team-mcp"));
  const badPull = ownImages.filter((c) => c.imagePullPolicy !== wantPull);
  check(env, `our images use imagePullPolicy ${wantPull}`, badPull.length === 0, badPull.map((c) => c.name).join(", "));
  if (env === "prod") {
    const local = ownImages.filter((c) => !c.image.startsWith("ghcr.io/") && !c.image.includes("."));
    check(env, "our images come from a registry (not Kind-loaded :local)", local.length === 0 && ownImages.every((c) => !c.image.endsWith(":local")), local.map((c) => c.image).join(", "));
  }

  // --- secrets never come from the charts
  const secrets = objects.filter((o) => o.kind === "Secret");
  check(env, "no Secret objects in any chart (create-secrets.sh owns them)", secrets.length === 0, secrets.map((s) => s.metadata.name).join(", "));
  // A literal value under a secret-looking name. Allowed: valueFrom (a Secret), "$(VAR)..."
  // (expanded at runtime from another env var that comes from a Secret), a mount path, and
  // the *name* of a Secret object.
  const literal = (e) =>
    e.value !== undefined && String(e.value) !== "" && !/^\$\([A-Z0-9_]+\)/.test(String(e.value)) && !String(e.value).startsWith("/") && !/^[a-z0-9-]+-secrets?$/.test(String(e.value));
  const envSecrets = containers.filter((x) => (x.c.env ?? []).some((e) => /PASSWORD|SECRET|TOKEN|_KEY$/.test(e.name) && literal(e)));
  check(env, "no secret-looking env values inlined in templates", envSecrets.length === 0, envSecrets.map((x) => `${x.id}/${x.c.name}`).join(", "));

  // --- network policies: default deny + DNS in every namespace with workloads
  const namespaces = [...new Set(workloads.map((w) => w.metadata.namespace))].sort();
  const nps = objects.filter((o) => o.kind === "NetworkPolicy");
  for (const ns of namespaces) {
    const deny = nps.some(
      (p) => p.metadata.namespace === ns && Object.keys(p.spec.podSelector ?? {}).length === 0 && ["Ingress", "Egress"].every((t) => p.spec.policyTypes?.includes(t)) && !p.spec.ingress && !p.spec.egress,
    );
    const dns = nps.some((p) => p.metadata.namespace === ns && JSON.stringify(p.spec.egress ?? []).includes('"port":53'));
    check(env, `namespace ${ns}: default-deny ingress+egress and DNS-only allow`, deny && dns);
  }
  const wideOpen = nps.filter((p) => JSON.stringify(p.spec).includes('"from":[{}]') || JSON.stringify(p.spec).includes('"to":[{}]'));
  check(env, "no allow-all NetworkPolicy rules", wideOpen.length === 0, wideOpen.map((p) => p.metadata.name).join(", "));

  // --- services, ingress, storage, replicas
  const svc = objects.filter((o) => o.kind === "Service" && (o.spec.type ?? "ClusterIP") !== "ClusterIP");
  check(env, "every Service is ClusterIP", svc.length === 0, svc.map((s) => s.metadata.name).join(", "));
  const ingresses = objects.filter((o) => o.kind === "Ingress");
  const hosts = ingresses.flatMap((i) => i.spec.rules.map((r) => r.host));
  if (env === "prod") {
    check(env, `ingresses use real hosts (${hosts.join(", ")})`, hosts.every((h) => !h.endsWith("localtest.me")));
    check(env, "every ingress host has TLS via cert-manager", ingresses.every((i) => (i.spec.tls ?? []).length > 0 && i.metadata.annotations?.["cert-manager.io/cluster-issuer"]));
  } else {
    check(env, `ingresses use localtest.me hosts (${hosts.join(", ")})`, hosts.every((h) => h.endsWith("localtest.me")));
  }
  const pvcs = objects.filter((o) => o.kind === "PersistentVolumeClaim");
  const wantSc = env === "prod" ? "local-path" : undefined;
  check(env, `PVCs (${pvcs.map((p) => `${p.metadata.namespace}/${p.metadata.name} ${p.spec.resources.requests.storage}`).join(", ")}) use storageClass ${wantSc ?? "default"}`, pvcs.length >= 3 && pvcs.every((p) => p.spec.storageClassName === wantSc));
  const gw = workloads.find((w) => w.kind === "Deployment" && w.metadata.name === "gateway");
  check(env, `gateway replicas = ${env === "prod" ? 2 : 1}`, gw?.spec.replicas === (env === "prod" ? 2 : 1));

  // --- RBAC: namespaced, minimal
  const clusterRoles = objects.filter((o) => o.kind === "ClusterRole");
  const clusterBindings = objects.filter((o) => o.kind === "ClusterRoleBinding");
  const provisionerOn = objects.some((o) => o.kind === "Deployment" && o.metadata.name === "provisioner");
  if (!provisionerOn) {
    check(env, "no ClusterRole/ClusterRoleBinding (stores off)", clusterRoles.length + clusterBindings.length === 0, [...clusterRoles, ...clusterBindings].map((o) => o.metadata.name).join(", "));
  } else {
    // Cluster-wide rights: exactly the provisioner's, rule for rule.
    const cr = clusterRoles.find((r) => r.metadata.name === "team-mcp-provisioner");
    const sameRules = JSON.stringify(cr?.rules ?? null) === JSON.stringify(ALLOWED_CLUSTER_ROLES["team-mcp-provisioner"]);
    const bindings = clusterBindings.map((b) => `${b.metadata.name}->${b.roleRef.name}`);
    check(env, "cluster RBAC: only team-mcp-provisioner (namespaces get/create/delete, create rolebindings, bind one role)", sameRules && bindings.join() === "team-mcp-provisioner->team-mcp-provisioner", `${bindings.join()} ${sameRules ? "" : "rules differ"}`);
    // The tenant role is never bound cluster-wide, and grants nothing cluster-scoped.
    const tenant = clusterRoles.find((r) => r.metadata.name === "team-mcp-store-tenant");
    const clusterScoped = ["namespaces", "nodes", "clusterroles", "clusterrolebindings", "persistentvolumes", "customresourcedefinitions"];
    const tenantOk = tenant && !(tenant.rules ?? []).some((r) => r.resources.some((x) => x === "*" || clusterScoped.includes(x)) || r.verbs.includes("*") || r.verbs.includes("escalate") || r.verbs.includes("bind") || r.verbs.includes("impersonate"));
    check(env, "team-mcp-store-tenant: namespaced resources only, no wildcards/escalate/bind/impersonate, never bound cluster-wide", Boolean(tenantOk) && !clusterBindings.some((b) => b.roleRef.name === "team-mcp-store-tenant"));
    const unknown = clusterRoles.filter((r) => !["team-mcp-provisioner", "team-mcp-store-tenant"].includes(r.metadata.name));
    check(env, "no other ClusterRoles", unknown.length === 0, unknown.map((r) => r.metadata.name).join(", "));
    // The hard fence: an admission policy confines the provisioner to store-* namespaces.
    const vap = objects.find((o) => o.kind === "ValidatingAdmissionPolicy" && o.metadata.name === "team-mcp-provisioner-scope");
    const vapb = objects.find((o) => o.kind === "ValidatingAdmissionPolicyBinding" && o.spec?.policyName === "team-mcp-provisioner-scope");
    const fenced =
      vap?.spec.failurePolicy === "Fail" &&
      JSON.stringify(vap.spec.validations).includes("startsWith('store-')") &&
      String(vap.spec.matchConditions?.[0]?.expression).includes("system:serviceaccount:provisioner:provisioner") &&
      vapb?.spec.validationActions?.includes("Deny");
    check(env, "ValidatingAdmissionPolicy confines the provisioner to store-* namespaces (Deny, failurePolicy Fail)", Boolean(fenced));
    // Each provisioned store is capped.
    const quota = objects.find((o) => o.kind === "ResourceQuota" && o.metadata.namespace === "store-example");
    const limits = objects.find((o) => o.kind === "LimitRange" && o.metadata.namespace === "store-example");
    check(env, "provisioned stores get a ResourceQuota and a LimitRange", Boolean(quota?.spec.hard?.["limits.memory"] && quota.spec.hard["services.loadbalancers"] === "0" && limits));
  }
  const roles = objects.filter((o) => o.kind === "Role");
  const wideRules = roles.flatMap((r) => (r.rules ?? []).filter((rule) => !rule.resourceNames?.length || rule.verbs.some((vb) => ["*", "list", "watch", "delete", "create"].includes(vb)) || rule.resources.includes("*")).map(() => r.metadata.name));
  check(env, `Roles (${roles.map((r) => `${r.metadata.namespace}/${r.metadata.name}`).join(", ")}) grant only named resources, no list/watch/create/delete`, wideRules.length === 0, wideRules.join(", "));
}

console.log(results.join("\n"));
console.log(failures ? `\n\x1b[31m${failures} policy violation(s)\x1b[0m` : "\n\x1b[32mAll policy checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
