import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/Layout";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, type PermissionTable, type ToolPermission } from "@/lib/api";
import { useMe } from "@/lib/session";

/**
 * Which roles can call which tools (stand-out A). Admins can always call everything; the
 * switch decides whether members can. The gateway enforces it on every call and listing,
 * so a change applies to MCP clients and the chat agent right away.
 */
export function PermissionsPage() {
  const isAdmin = useMe().data?.role === "admin";
  const qc = useQueryClient();
  const table = useQuery({ queryKey: ["permissions"], queryFn: () => api<PermissionTable>("/api/permissions") });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["permissions"] });
    // Tool lists elsewhere (Servers, Connect, Chat) depend on permissions too.
    void qc.invalidateQueries({ queryKey: ["tools"] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
  };
  const setMember = useMutation({
    mutationFn: ({ tool, member }: { tool: string; member: boolean }) => api(`/api/permissions/${encodeURIComponent(tool)}`, "PUT", { member }),
    onSuccess: (_r, { tool, member }) => {
      refresh();
      toast.success(member ? `Members can now call ${tool}.` : `${tool} is now admin-only: hidden from members and refused if called.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reset = useMutation({
    mutationFn: (tool: string) => api(`/api/permissions/${encodeURIComponent(tool)}`, "DELETE"),
    onSuccess: (_r, tool) => {
      refresh();
      toast.success(`${tool} follows the default policy again.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = table.data;
  const groups = new Map<string, ToolPermission[]>();
  for (const t of data?.tools ?? []) groups.set(t.server, [...(groups.get(t.server) ?? []), t]);
  const busy = setMember.isPending || reset.isPending;

  return (
    <div>
      <PageHeader
        title="Permissions"
        description={
          isAdmin
            ? "Choose which tools members can call. Admins can always call every tool. Changes apply immediately to MCP clients and the chat assistant."
            : "Which tools each role can call. Only admins can change this."
        }
      />
      {table.isLoading && <LoadingState />}
      {table.isError && <ErrorState error={table.error} />}
      {data && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            Tools without their own rule follow the default:{" "}
            <span className="font-medium text-foreground">{data.default_member_access === "allow" ? "members can call them" : "admin-only"}</span>. New
            servers' tools start out that way.
          </p>
          {groups.size === 0 && <EmptyState title="No tools yet">Tools appear here once a server is connected.</EmptyState>}
          <div className="space-y-4">
            {[...groups.entries()].map(([server, tools]) => (
              <Card key={server} className="overflow-hidden">
                <div className="flex items-center gap-2 border-b bg-zinc-50 px-4 py-2.5 text-sm font-medium">
                  {tools[0]?.server_name ?? server} <code className="text-xs font-normal text-muted-foreground">{server}</code>
                </div>
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40%] min-w-48">Tool</TableHead>
                      <TableHead className="w-20 text-center">Admin</TableHead>
                      <TableHead className="w-24 text-center">Member</TableHead>
                      <TableHead className="w-44">Rule</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tools.map((t) => {
                      const member = t.roles.includes("member");
                      return (
                        <TableRow key={t.name}>
                          <TableCell className="whitespace-normal">
                            <code className="text-sm font-medium break-all">{t.name.split("__")[1] ?? t.name}</code>
                            {!t.available && (
                              <Badge variant="outline" className="ml-2 align-middle">
                                not listed now
                              </Badge>
                            )}
                            {t.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</p>}
                          </TableCell>
                          <TableCell className="text-center">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Switch checked disabled aria-label={`Admins can call ${t.name}`} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>Admins can always call every tool.</TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="text-center">
                            {isAdmin ? (
                              <Switch
                                checked={member}
                                disabled={busy}
                                onCheckedChange={(v) => setMember.mutate({ tool: t.name, member: v })}
                                aria-label={`Members can call ${t.name}`}
                              />
                            ) : (
                              <Badge variant={member ? "secondary" : "outline"}>{member ? "allowed" : "admin only"}</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">{t.source === "rule" ? "Custom" : "Default"}</span>
                              {isAdmin && t.source === "rule" && (
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => reset.mutate(t.name)}>
                                  <RotateCcwIcon className="size-3.5" /> Use default
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
