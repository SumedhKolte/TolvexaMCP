import { describe, expect, it } from "vitest";
import { checkResolvedAddresses, checkUpstreamUrl, SsrfError, type Resolver } from "../src/registry/ssrf.js";

const policy = { allowlist: [] as string[], allowPublic: false };
const resolveTo = (...addrs: string[]): Resolver => async () => addrs;
const nxdomain: Resolver = async () => {
  throw new Error("ENOTFOUND");
};

describe("SSRF guard: registration", () => {
  it("accepts a valid *.svc.cluster.local URL", async () => {
    const u = await checkUpstreamUrl("http://mcp-notes.upstreams.svc.cluster.local:8080/mcp", policy, resolveTo("10.96.12.34"));
    expect(u.hostname).toBe("mcp-notes.upstreams.svc.cluster.local");
  });

  it("accepts a cluster name that doesn't resolve yet (server registered while down)", async () => {
    await expect(checkUpstreamUrl("http://later.upstreams.svc.cluster.local/mcp", policy, nxdomain)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ["loopback IPv4", "http://127.0.0.1:8080/mcp"],
    ["loopback IPv6", "http://[::1]:8080/mcp"],
    ["metadata service", "http://169.254.169.254/latest/meta-data/"],
    ["link-local IPv6", "http://[fe80::1]/mcp"],
    ["unspecified", "http://0.0.0.0/mcp"],
    ["localhost name", "http://localhost:8080/mcp"],
  ])("rejects %s", async (_l, url) => {
    await expect(checkUpstreamUrl(url, policy, resolveTo("10.0.0.1"))).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a cluster name that resolves to loopback or metadata", async () => {
    await expect(checkUpstreamUrl("http://evil.ns.svc.cluster.local/mcp", policy, resolveTo("127.0.0.1"))).rejects.toThrow(/blocked/);
    await expect(checkUpstreamUrl("http://evil.ns.svc.cluster.local/mcp", policy, resolveTo("169.254.169.254"))).rejects.toThrow(/blocked/);
    await expect(checkUpstreamUrl("http://evil.ns.svc.cluster.local/mcp", policy, resolveTo("::ffff:127.0.0.1"))).rejects.toThrow(/blocked/);
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    await expect(checkUpstreamUrl("file:///etc/passwd", policy)).rejects.toThrow(/http or https/);
    await expect(checkUpstreamUrl("gopher://x.svc.cluster.local/", policy)).rejects.toThrow(/http or https/);
    await expect(checkUpstreamUrl("http://u:p@x.ns.svc.cluster.local/mcp", policy)).rejects.toThrow(/credentials/);
  });

  it("rejects public hostnames unless public upstreams are enabled", async () => {
    await expect(checkUpstreamUrl("https://mcp.example.com/mcp", policy, resolveTo("93.184.216.34"))).rejects.toThrow(/svc.cluster.local/);
    const open = { allowlist: [], allowPublic: true };
    await expect(checkUpstreamUrl("https://mcp.example.com/mcp", open, resolveTo("93.184.216.34"))).resolves.toBeInstanceOf(URL);
    // ...but a public name pointing at a private address is still rejected.
    await expect(checkUpstreamUrl("https://sneaky.example.com/mcp", open, resolveTo("10.0.0.5"))).rejects.toThrow(/private/);
  });

  it("accepts allowlisted hosts (exact and .suffix), still blocking loopback", async () => {
    const p = { allowlist: ["mcp.partner.io", ".internal.corp"], allowPublic: false };
    await expect(checkUpstreamUrl("https://mcp.partner.io/mcp", p, resolveTo("203.0.113.9"))).resolves.toBeInstanceOf(URL);
    await expect(checkUpstreamUrl("https://a.internal.corp/mcp", p, resolveTo("10.1.2.3"))).resolves.toBeInstanceOf(URL);
    await expect(checkUpstreamUrl("https://a.internal.corp/mcp", p, resolveTo("127.0.0.1"))).rejects.toThrow(/blocked/);
  });
});

describe("SSRF guard: connect time (DNS rebinding)", () => {
  it("blocks a name that now resolves to a blocked address", () => {
    expect(() => checkResolvedAddresses("mcp-notes.upstreams.svc.cluster.local", ["169.254.169.254"], policy)).toThrow(SsrfError);
    expect(() => checkResolvedAddresses("mcp-notes.upstreams.svc.cluster.local", ["10.96.0.10"], policy)).not.toThrow();
  });
});
