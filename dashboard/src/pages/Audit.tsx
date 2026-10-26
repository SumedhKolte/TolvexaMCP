import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { OutcomeBadge } from "@/components/Badges";
import { PageHeader } from "@/components/Layout";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type AuditItem, type AuditPage as Page, type Outcome, type Server, type ServerStats, type UserWithKeys } from "@/lib/api";
import { useMe } from "@/lib/session";
import { formatDateTime, formatDuration, formatShortDateTime, localInputToIso } from "@/lib/utils";

const ALL = "__all__"; // Radix Select items can't have an empty value
const OUTCOMES: Outcome[] = ["ok", "error", "denied", "timeout", "unreachable", "disabled"];
const PAGE_SIZE = 50;

/** Audit log: admins see everyone's calls, members only their own (the gateway enforces it). */
export function AuditPage() {
  const isAdmin = useMe().data?.role === "admin";
  const qc = useQueryClient();
  const [userId, setUserId] = useState(ALL);
  const [server, setServer] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<AuditItem | null>(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api<{ users: UserWithKeys[] }>("/api/users").then((r) => r.users),
    enabled: isAdmin,
  });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: Server[] }>("/api/servers").then((r) => r.servers) });

  const filters = {
    userId: isAdmin && userId !== ALL ? userId : undefined,
    serverSlug: server !== ALL ? server : undefined,
    outcome: outcome !== ALL ? outcome : undefined,
    from: localInputToIso(from),
    to: localInputToIso(to),
  };
  const audit = useInfiniteQuery({
    queryKey: ["audit", filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
      if (pageParam) q.set("cursor", String(pageParam));
      return api<Page>(`/api/audit?${q}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div>
      <PageHeader title="Audit Log" description={isAdmin ? "Every tool call through the gateway, by everyone." : "Every tool call you made through the gateway."}>
        <Button
          variant="outline"
          onClick={() => {
            void audit.refetch();
            void qc.invalidateQueries({ queryKey: ["audit-stats"] });
          }}
          disabled={audit.isFetching}
        >
          <RefreshCwIcon className={audit.isFetching ? "animate-spin" : undefined} /> Refresh
        </Button>
      </PageHeader>

      <LastHourStats isAdmin={isAdmin} />

      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4 [&>*]:w-40">
        {isAdmin && <FilterSelect label="User" value={userId} onChange={setUserId} options={(users.data ?? []).map((u) => [u.id, u.email])} />}
        <FilterSelect label="Server" value={server} onChange={setServer} options={(servers.data ?? []).map((s) => [s.slug, s.slug])} />
        <FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={OUTCOMES.map((o) => [o, o])} />
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button
          className="!w-auto"
          variant="ghost"
          disabled={!filtered}
          onClick={() => {
            setUserId(ALL);
            setServer(ALL);
            setOutcome(ALL);
            setFrom("");
            setTo("");
          }}
        >
          Clear
        </Button>
      </Card>

      <Card className="p-2">
        {audit.isPending ? (
          <LoadingState label="Loading audit log…" />
        ) : audit.isError ? (
          <ErrorState error={audit.error} />
        ) : rows.length === 0 ? (
          <EmptyState title={filtered ? "No calls match these filters" : "No tool calls yet"}>
            {filtered ? "Try clearing a filter." : "Calls made through /mcp or the chat agent appear here."}
          </EmptyState>
        ) : (
          <>
            <Table className="table-fixed text-[13px]">
              {/* Fixed widths sized to the longest real values, so all 8 columns fit at 1280px. */}
              <colgroup>
                <col className="w-[118px]" />
                <col className="w-[160px]" />
                <col className="w-[56px]" />
                <col className="w-[96px]" />
                <col />
                <col className="w-[64px]" />
                <col className="w-[100px]" />
                <col className="w-[150px]" />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Tool</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Error code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                    <TableCell className="whitespace-nowrap tabular-nums" title={formatDateTime(r.ts)}>
                      {formatShortDateTime(r.ts)}
                    </TableCell>
                    <TableCell className="truncate" title={r.userEmail ?? undefined}>
                      {r.userEmail ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.source}</Badge>
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={r.serverSlug ?? undefined}>
                      {r.serverSlug ?? "—"}
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={r.tool ?? undefined}>
                      {r.tool ?? "—"}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">{formatDuration(r.durationMs)}</TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={r.outcome} />
                    </TableCell>
                    <TableCell className="truncate font-mono text-xs" title={r.errorCode ?? undefined}>
                      {r.errorCode ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between px-2 py-3 text-sm text-muted-foreground">
              <span>{rows.length} calls shown</span>
              {audit.hasNextPage ? (
                <Button variant="outline" size="sm" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                  {audit.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              ) : (
                <span>End of log</span>
              )}
            </div>
          </>
        )}
      </Card>

      <Dialog open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono text-base">{selected.tool ?? "(no tool)"}</DialogTitle>
                <DialogDescription>
                  {formatDateTime(selected.ts)} · {selected.userEmail ?? "unknown user"} · via {selected.source} · {selected.durationMs} ms
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Outcome</dt>
                <dd>
                  <OutcomeBadge outcome={selected.outcome} /> {selected.errorCode && <code className="ml-2 text-xs">{selected.errorCode}</code>}
                </dd>
                <dt className="text-muted-foreground">Arguments (redacted)</dt>
                <dd>
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{selected.argsSummary ?? "(none)"}</pre>
                </dd>
                <dt className="text-muted-foreground">Error message</dt>
                <dd className="break-words">{selected.errorMessage ?? "—"}</dd>
                <dt className="text-muted-foreground">Server</dt>
                <dd className="font-mono text-xs">{selected.serverSlug ?? "—"}</dd>
                <dt className="text-muted-foreground">API key id</dt>
                <dd className="font-mono text-xs">{selected.apiKeyId ?? "— (dashboard session)"}</dd>
                <dt className="text-muted-foreground">Entry id</dt>
                <dd className="font-mono text-xs">{selected.id}</dd>
              </dl>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={`Filter by ${label.toLowerCase()}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Per-server error rate and average latency over the last hour, computed by the gateway from audit_log. */
function LastHourStats({ isAdmin }: { isAdmin: boolean }) {
  const stats = useQuery({
    queryKey: ["audit-stats"],
    queryFn: () => api<{ minutes: number; servers: ServerStats[] }>("/api/audit/stats?minutes=60"),
    refetchInterval: 30_000,
  });
  if (stats.isError) return <ErrorState error={stats.error} className="mb-4" />;
  const servers = stats.data?.servers ?? [];
  return (
    <section aria-labelledby="last-hour" className="mb-4">
      <h2 id="last-hour" className="mb-2 text-sm font-medium">
        Last hour by server <span className="font-normal text-muted-foreground">({isAdmin ? "all users" : "your calls"})</span>
      </h2>
      {stats.isPending ? (
        <Card className="p-4 text-sm text-muted-foreground">Loading…</Card>
      ) : servers.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">No tool calls in the last hour.</Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {servers.map((s) => {
            const pct = Math.round(s.error_rate * 1000) / 10;
            const tone = pct >= 20 ? "text-danger-fg" : pct > 0 ? "text-warning-fg" : "text-success-fg";
            return (
              <Card key={s.server} className="p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <code className="truncate text-sm font-medium">{s.server}</code>
                  <span className="text-xs text-muted-foreground tabular-nums">{s.calls} {s.calls === 1 ? "call" : "calls"}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">Error rate</dt>
                    <dd className={`font-semibold tabular-nums ${tone}`} title={`${s.errors} of ${s.calls} calls failed (error, timeout or unreachable)`}>
                      {pct}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Avg latency</dt>
                    <dd className="font-semibold tabular-nums" title="Over calls that reached the server">
                      {s.avg_latency_ms === null ? "—" : formatDuration(s.avg_latency_ms)}
                    </dd>
                  </div>
                </dl>
                {s.denied > 0 && <p className="mt-2 text-xs text-muted-foreground">{s.denied} refused (permission or server disabled)</p>}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
