import { useQuery } from "@tanstack/react-query";
import { ActivityIcon, ArrowRightIcon, GaugeIcon, KeyRoundIcon, MessageSquareIcon, PlugIcon, ServerIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { OutcomeBadge, StatusBadge } from "@/components/Badges";
import { PageHeader } from "@/components/Layout";
import { EmptyState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api, type AuditPage, type Server, type ServerStats, type Store, type StoreLimits, type Tool } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn, formatDuration, relativeTime } from "@/lib/utils";

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

/** One headline number, with the thing it counts and a line of context under it. */
function Kpi({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub: ReactNode; icon: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        {label}
        <span aria-hidden="true" className="text-muted-foreground/70 [&>svg]:size-4">
          {icon}
        </span>
      </div>
      <div
        className={cn(
          "mt-2 text-3xl font-semibold tracking-tight tabular-nums",
          tone === "good" && "text-success-fg",
          tone === "warn" && "text-warning-fg",
          tone === "bad" && "text-danger-fg",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </Card>
  );
}

/**
 * The landing page: is everything healthy, what is happening, and what can I do next.
 * Everything here comes from the same endpoints as the other pages; nothing is new on the
 * gateway. Members see their own calls (the gateway scopes the audit data).
 */
export function OverviewPage() {
  const me = useMe().data;
  const isAdmin = me?.role === "admin";
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: Server[] }>("/api/servers").then((r) => r.servers), refetchInterval: 15_000 });
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api<{ tools: Tool[] }>("/api/tools").then((r) => r.tools) });
  const stats = useQuery({
    queryKey: ["audit-stats"],
    queryFn: () => api<{ minutes: number; servers: ServerStats[] }>("/api/audit/stats?minutes=60"),
    refetchInterval: 30_000,
  });
  const recent = useQuery({ queryKey: ["audit", "recent"], queryFn: () => api<AuditPage>("/api/audit?limit=8"), refetchInterval: 15_000 });
  const stores = useQuery({ queryKey: ["stores"], queryFn: () => api<{ stores: Store[]; limits: StoreLimits }>("/api/stores"), refetchInterval: 30_000 });

  const list = servers.data ?? [];
  const connected = list.filter((s) => s.status === "connected").length;
  const unreachable = list.filter((s) => s.status === "unreachable").length;
  const statsBy = new Map((stats.data?.servers ?? []).map((s) => [s.server, s]));
  const totals = (stats.data?.servers ?? []).reduce((a, s) => ({ calls: a.calls + s.calls, errors: a.errors + s.errors, denied: a.denied + s.denied }), { calls: 0, errors: 0, denied: 0 });
  const ok = Math.max(0, totals.calls - totals.errors - totals.denied);
  const errorRate = totals.calls ? (totals.errors / totals.calls) * 100 : 0;
  const readyStores = stores.data?.stores.filter((s) => s.status === "ready").length ?? 0;
  const firstName = me?.email.split("@")[0] ?? "";

  return (
    <div>
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ""}`}
        description={isAdmin ? "Here is how the gateway is doing across the whole team." : "Here is the gateway and your own recent activity."}
      />

      <section aria-label="Key numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Servers connected"
          value={servers.isPending ? "–" : `${connected}/${list.length}`}
          tone={servers.isPending ? undefined : unreachable > 0 ? "bad" : "good"}
          sub={unreachable > 0 ? `${unreachable} unreachable right now` : "Every enabled server is reachable"}
          icon={<ServerIcon />}
        />
        <Kpi
          label="Tools you can use"
          value={tools.isPending ? "–" : tools.data?.length ?? 0}
          sub={`Across ${new Set((tools.data ?? []).map((t) => t.server)).size} servers, filtered by your role`}
          icon={<WrenchIcon />}
        />
        <Kpi
          label="Tool calls, last hour"
          value={stats.isPending ? "–" : totals.calls}
          sub={isAdmin ? "From every user, MCP clients and chat" : "Your own calls"}
          icon={<ActivityIcon />}
        />
        <Kpi
          label="Error rate, last hour"
          value={stats.isPending ? "–" : totals.calls ? `${errorRate.toFixed(errorRate % 1 ? 1 : 0)}%` : "0%"}
          tone={totals.calls === 0 ? undefined : errorRate >= 20 ? "bad" : errorRate > 0 ? "warn" : "good"}
          sub={totals.calls ? `${totals.errors} failed of ${totals.calls}${totals.denied ? ` · ${totals.denied} refused` : ""}` : "No calls yet"}
          icon={<GaugeIcon />}
        />
      </section>

      {totals.calls > 0 && (
        <section aria-label="Outcomes in the last hour" className="mt-3">
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">Outcomes, last hour</span>
              <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <Legend color="bg-success-fg" label={`${ok} succeeded`} />
                <Legend color="bg-warning-fg" label={`${totals.denied} refused`} />
                <Legend color="bg-danger-fg" label={`${totals.errors} failed`} />
              </span>
            </div>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${ok} succeeded, ${totals.denied} refused, ${totals.errors} failed`}>
              <div className="bg-success-fg" style={{ width: `${(ok / totals.calls) * 100}%` }} />
              <div className="bg-warning-fg" style={{ width: `${(totals.denied / totals.calls) * 100}%` }} />
              <div className="bg-danger-fg" style={{ width: `${(totals.errors / totals.calls) * 100}%` }} />
            </div>
          </Card>
        </section>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="health-h" className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="health-h" className="text-sm font-semibold">
              Server health
            </h2>
            <Link to="/servers" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Manage <ArrowRightIcon className="size-3" />
            </Link>
          </div>
          <Card className="divide-y">
            {servers.isPending ? (
              <div className="p-4 text-sm text-muted-foreground">Loading servers…</div>
            ) : list.length === 0 ? (
              <EmptyState title="No servers yet">An admin can add one on the Servers page.</EmptyState>
            ) : (
              list.map((s) => {
                const st = statsBy.get(s.slug);
                return (
                  <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{s.name}</span>
                        {s.builtin && <Badge variant="outline">built-in</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {s.tool_count} tools · checked {relativeTime(s.last_checked_at)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-right text-xs text-muted-foreground tabular-nums">
                      <span title="Average latency, last hour">{st?.avg_latency_ms != null ? formatDuration(st.avg_latency_ms) : "–"}</span>
                      <span title="Calls, last hour" className="w-14">
                        {st ? `${st.calls} ${st.calls === 1 ? "call" : "calls"}` : "0 calls"}
                      </span>
                    </div>
                    <StatusBadge status={s.status} lastError={s.last_error} />
                  </div>
                );
              })
            )}
          </Card>
          {stores.data?.limits.enabled && (
            <Link to="/stores" className="mt-3 flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-sm transition-colors hover:bg-accent/50">
              <span>
                <span className="font-medium">Stores</span>{" "}
                <span className="text-muted-foreground">
                  · {readyStores} ready{stores.data.stores.length > readyStores ? `, ${stores.data.stores.length - readyStores} in progress` : ""} · limit {stores.data.limits.per_user} each
                </span>
              </span>
              <ArrowRightIcon className="size-4 text-muted-foreground" />
            </Link>
          )}
        </section>

        <section aria-labelledby="recent-h" className="min-w-0">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="recent-h" className="text-sm font-semibold">
              Recent activity
            </h2>
            <Link to="/audit" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Full audit log <ArrowRightIcon className="size-3" />
            </Link>
          </div>
          <Card className="divide-y">
            {recent.isPending ? (
              <div className="p-4 text-sm text-muted-foreground">Loading activity…</div>
            ) : (recent.data?.items.length ?? 0) === 0 ? (
              <EmptyState title="No tool calls yet">Calls made through /mcp or the chat show up here.</EmptyState>
            ) : (
              recent.data?.items.map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[13px]" title={r.tool ?? undefined}>
                      {r.tool ?? "(unknown tool)"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {isAdmin ? `${r.userEmail?.split("@")[0] ?? "unknown"} · ` : ""}
                      {r.source === "chat" ? "chat" : "mcp"} · {relativeTime(r.ts)} · {formatDuration(r.durationMs)}
                    </div>
                  </div>
                  <OutcomeBadge outcome={r.outcome} />
                </div>
              ))
            )}
          </Card>
        </section>
      </div>

      <section aria-label="Quick actions" className="mt-6 grid gap-3 sm:grid-cols-3">
        <Action to="/chat" icon={<MessageSquareIcon />} title="Ask the assistant" text="Questions answered with live tools, every call logged under you." />
        <Action to="/keys" icon={<KeyRoundIcon />} title="Create an API key" text="One key gives any MCP client every tool your role allows." />
        <Action to="/connect" icon={<PlugIcon />} title="Connect a client" text="Copy-paste setup for Cursor, Claude Code and MCP Inspector." />
      </section>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("size-2 rounded-full", color)} /> {label}
    </span>
  );
}

function Action({ to, icon, title, text }: { to: string; icon: ReactNode; title: string; text: string }) {
  return (
    <Link to={to} className="group flex gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1 text-sm font-medium">
          {title} <ArrowRightIcon className="size-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{text}</span>
      </span>
    </Link>
  );
}
