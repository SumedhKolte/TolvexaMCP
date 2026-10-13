import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF guard for admin-entered upstream URLs (docs/threat-model.md, "SSRF").
 *
 * Two layers:
 *   1. At registration (checkUpstreamUrl): scheme, no userinfo, host policy, and, when
 *      the name resolves, every resolved address.
 *   2. At connect time (checkResolvedAddresses, used by the upstream connector's DNS
 *      lookup hook): the address the socket is ACTUALLY about to connect to is checked
 *      again on every connection. A DNS answer that changes after registration (DNS
 *      rebinding) is therefore caught when it matters.
 *
 * Host policy:
 *   - *.svc.cluster.local: allowed (in-cluster Services; the normal case).
 *   - hosts on UPSTREAM_HOST_ALLOWLIST (exact name, or ".suffix"): allowed.
 *   - other public DNS names: only if ALLOW_PUBLIC_UPSTREAMS=true, and then they must
 *     resolve to PUBLIC addresses (a public name pointing at 10.x is rejected).
 *   - IP literals: rejected unless allowlisted (no "http://10.0.0.5" shortcuts).
 * Always blocked, whatever the host: loopback, link-local (incl. cloud metadata
 * 169.254.169.254), unspecified, multicast, and broadcast addresses.
 */

const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" incl. 0.0.0.0
ALWAYS_BLOCKED.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
ALWAYS_BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
ALWAYS_BLOCKED.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
ALWAYS_BLOCKED.addAddress("255.255.255.255", "ipv4"); // broadcast
ALWAYS_BLOCKED.addAddress("::", "ipv6"); // unspecified
ALWAYS_BLOCKED.addAddress("::1", "ipv6"); // loopback
ALWAYS_BLOCKED.addSubnet("fe80::", 10, "ipv6"); // link-local
ALWAYS_BLOCKED.addSubnet("ff00::", 8, "ipv6"); // multicast

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

export interface SsrfPolicy {
  allowlist: string[];
  allowPublic: boolean;
}

export class SsrfError extends Error {
  override name = "SsrfError";
}

/** Normalizes IPv4-mapped IPv6 ("::ffff:127.0.0.1") to plain IPv4 before checking. */
function normalize(address: string): { addr: string; family: "ipv4" | "ipv6" } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return { addr: mapped[1], family: "ipv4" };
  return { addr: address, family: isIP(address) === 6 ? "ipv6" : "ipv4" };
}

export function isAlwaysBlocked(address: string): boolean {
  const { addr, family } = normalize(address);
  return ALWAYS_BLOCKED.check(addr, family);
}

export function isPrivate(address: string): boolean {
  const { addr, family } = normalize(address);
  return PRIVATE.check(addr, family);
}

const lower = (h: string) => h.toLowerCase().replace(/\.$/, "");

function onAllowlist(host: string, allowlist: string[]): boolean {
  const h = lower(host);
  return allowlist.some((entry) => {
    const e = lower(entry.trim());
    if (!e) return false;
    return e.startsWith(".") ? h.endsWith(e) : h === e;
  });
}

export type HostKind = "cluster" | "allowlisted" | "public";

/** Classifies a hostname by policy, or throws if it isn't allowed at all. */
export function classifyHost(hostname: string, policy: SsrfPolicy): HostKind {
  const host = lower(hostname.replace(/^\[|\]$/g, ""));
  if (onAllowlist(host, policy.allowlist)) return "allowlisted";
  if (isIP(host)) throw new SsrfError("IP addresses are not allowed; use a DNS name (or add it to the allowlist)");
  if (host === "localhost" || host.endsWith(".localhost")) throw new SsrfError("localhost is not allowed");
  if (host.endsWith(".svc.cluster.local")) return "cluster";
  if (policy.allowPublic) return "public";
  throw new SsrfError("host must end in .svc.cluster.local or be on the allowlist");
}

/** Checks the addresses a hostname resolved to. Used at registration AND at connect time. */
export function checkResolvedAddresses(hostname: string, addresses: string[], policy: SsrfPolicy): void {
  const kind = classifyHost(hostname, policy);
  for (const a of addresses) {
    if (isAlwaysBlocked(a)) throw new SsrfError(`${hostname} resolves to a blocked address (${a})`);
    if (kind === "public" && isPrivate(a)) {
      throw new SsrfError(`${hostname} is a public name but resolves to a private address (${a})`);
    }
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Registration-time check. Throws SsrfError with a message suitable for the admin.
 * A name that doesn't resolve YET is accepted (the spec lets admins register a server
 * that is down); the connect-time check still guards every real connection.
 */
export async function checkUpstreamUrl(rawUrl: string, policy: SsrfPolicy, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("URL must use http or https");
  if (url.username || url.password) throw new SsrfError("URL must not contain credentials; use the credential field");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  classifyHost(host, policy);
  if (isIP(host)) {
    checkResolvedAddresses(host, [host], policy);
    return url;
  }
  let addresses: string[] = [];
  try {
    addresses = await resolve(host);
  } catch {
    return url; // not resolvable right now; guarded again at connect time
  }
  checkResolvedAddresses(host, addresses, policy);
  return url;
}
