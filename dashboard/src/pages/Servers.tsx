import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { ExpandButton } from "@/components/ExpandButton";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/Badges";
import { PageHeader } from "@/components/Layout";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, type Server, type Tool } from "@/lib/api";
import { useMe } from "@/lib/session";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { ServerForm } from "./ServerForm";

export function ServersPage() {
  const isAdmin = useMe().data?.role === "admin";
  const qc = useQueryClient();
  // Poll so status changes (a server going down, recovering) show up without a reload.
  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => api<{ servers: Server[] }>("/api/servers").then((r) => r.servers),
    refetchInterval: 10_000,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; server?: Server }>({ open: false });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["tools"] });
  };
  const action = useMutation({
    mutationFn: ({ s, op }: { s: Server; op: "enable" | "disable" | "refresh" | "delete" }) =>
      op === "delete" ? api(`/api/servers/${s.id}`, "DELETE") : api<{ server: Server }>(`/api/servers/${s.id}/${op}`, "POST"),
    onSuccess: (_d, { s, op }) => {
      invalidate();
      const verb = { enable: "enabled", disable: "disabled (its tools are hidden from everyone)", refresh: "checked", delete: "deleted" }[op];
      toast.success(`${s.name} ${verb}.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title="Servers"
        description={
          <>
            {isAdmin ? "Upstream MCP servers the whole team uses through the gateway." : "Upstream MCP servers available to you through the gateway (read-only)."}
            {servers.data && servers.data.length > 0 && <HealthSummary servers={servers.data} />}
          </>
        }
      >
        {isAdmin && (
          <Button onClick={() => setForm({ open: true })}>
            <PlusIcon /> Add server
          </Button>
        )}
      </PageHeader>

      <Card className="p-2">
        {servers.isPending ? (
          <LoadingState label="Loading servers…" />
        ) : servers.isError ? (
          <ErrorState error={servers.error} />
        ) : servers.data.length === 0 ? (
          <EmptyState title="No servers registered">{isAdmin ? "Add one with “Add server”." : "Ask an admin to add one."}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tools</TableHead>
                <TableHead>Last checked</TableHead>
                {isAdmin && <TableHead>Enabled</TableHead>}
                {isAdmin && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.data.map((s) => (
                <Fragment key={s.id}>
                  <TableRow className="cursor-pointer" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                    <TableCell>
                      <ExpandButton expanded={expanded === s.id} label={`tools of ${s.name}`} onToggle={() => setExpanded(expanded === s.id ? null : s.id)} />
                    </TableCell>
                    <TableCell className="font-medium">
                      {s.name} {s.builtin && <Badge variant="outline" className="ml-1">built-in</Badge>}
                      {isAdmin && (
                        <div className="max-w-xs truncate font-mono text-xs font-normal text-muted-foreground" title={s.url}>
                          {s.url}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.slug}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <StatusBadge status={s.status} lastError={s.last_error} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.tool_count}</TableCell>
                    <TableCell title={s.last_checked_at ? formatDateTime(s.last_checked_at) : undefined}>{relativeTime(s.last_checked_at)}</TableCell>
                    {isAdmin && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={s.enabled}
                          aria-label={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`}
                          disabled={action.isPending}
                          onCheckedChange={(on) => action.mutate({ s, op: on ? "enable" : "disable" })}
                        />
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" title="Refresh (health check now)" aria-label={`Refresh ${s.name}`} disabled={!s.enabled} onClick={() => action.mutate({ s, op: "refresh" })}>
                            <RefreshCwIcon />
                          </Button>
                          <Button variant="ghost" size="icon" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setForm({ open: true, server: s })}>
                            <PencilIcon />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" title="Delete" aria-label={`Delete ${s.name}`}>
                                <Trash2Icon />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {s.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Its {s.tool_count} tools disappear for everyone immediately and its stored credential is deleted.
                                  {s.builtin && " It's the built-in server: it will be re-registered the next time the gateway starts."}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => action.mutate({ s, op: "delete" })}>Delete server</AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                  {expanded === s.id && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={isAdmin ? 7 : 5}>
                        <ServerTools server={s} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {isAdmin && <ServerForm open={form.open} server={form.server} onOpenChange={(open) => setForm((f) => ({ ...f, open }))} />}
    </div>
  );
}

/** At-a-glance health: is everything fine, and if not, what isn't? */
function HealthSummary({ servers }: { servers: Server[] }) {
  const count = (st: Server["status"]) => servers.filter((s) => s.status === st).length;
  const down = servers.filter((s) => s.status === "unreachable");
  const tools = servers.filter((s) => s.status === "connected").reduce((n, s) => n + s.tool_count, 0);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Badge variant="success">{count("connected")} connected</Badge>
      <Badge variant={down.length ? "danger" : "muted"}>{down.length} unreachable</Badge>
      <Badge variant="muted">{count("disabled")} disabled</Badge>
      <span className="text-xs">
        {tools} tools live{down.length ? ` · check ${down.map((s) => s.name).join(", ")}` : " · everything is reachable"}
      </span>
    </div>
  );
}

function ServerTools({ server }: { server: Server }) {
  const tools = useQuery({
    queryKey: ["servers", server.id, "tools"],
    queryFn: () => api<{ tools: Tool[] }>(`/api/servers/${server.id}/tools`).then((r) => r.tools),
  });
  if (!server.enabled) return <p className="py-2 text-sm text-muted-foreground">Disabled: its tools are hidden from every user and client.</p>;
  if (tools.isPending) return <LoadingState label="Loading tools…" className="py-4" />;
  if (tools.isError) return <ErrorState error={tools.error} className="py-4" />;
  if (tools.data.length === 0) return <EmptyState title="No tools available" className="py-4">{server.last_error ?? "The server hasn't listed any tools yet."}</EmptyState>;
  return (
    <ul className="divide-y py-1">
      {tools.data.map((t) => (
        <li key={t.name} className="flex items-start gap-3 py-2">
          <code className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{t.name}</code>
          <span className="text-sm text-muted-foreground">{t.description || "No description."}</span>
          <span className="ml-auto flex shrink-0 gap-1">
            {t.annotations?.readOnlyHint && <Badge variant="secondary">read-only</Badge>}
            {t.annotations?.destructiveHint && <Badge variant="warning">destructive</Badge>}
            {t.allowed === false && <Badge variant="muted">admin only</Badge>}
          </span>
        </li>
      ))}
    </ul>
  );
}
