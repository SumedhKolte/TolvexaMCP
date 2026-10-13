import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, type ApiKey } from "@/lib/api";
import { formatDateTime, maskedKey, relativeTime } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
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
} from "./ui/alert-dialog";
import { OneTimeSecret } from "./OneTimeSecret";
import { EmptyState, ErrorState, InlineError, LoadingState } from "./States";

/**
 * List / create / revoke API keys for one user. `userId` undefined = the logged-in user
 * (My Keys); an admin passes another user's id (Team page). The gateway enforces who may
 * manage whose keys; this component just reflects it.
 */
export function KeyManager({ userId, ownerLabel }: { userId?: string; ownerLabel?: string }) {
  const qc = useQueryClient();
  const queryKey = ["keys", userId ?? "me"];
  const keys = useQuery({
    queryKey,
    queryFn: () => api<{ keys: ApiKey[] }>(`/api/keys${userId ? `?userId=${userId}` : ""}`).then((r) => r.keys),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ key: ApiKey; secret: string }>("/api/keys", "POST", { name: name.trim(), ...(userId ? { user_id: userId } : {}) }),
    onSuccess: () => {
      setCreateOpen(false);
      setName("");
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/keys/${id}`, "DELETE"),
    onSuccess: () => {
      toast.success("Key revoked. It stops working on its next request.");
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {ownerLabel ? `Keys for ${ownerLabel}.` : "Use a key with any MCP client (see Connect)."} The full key is shown once, at creation.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon /> Create key
        </Button>
      </div>

      {keys.isPending ? (
        <LoadingState label="Loading keys…" />
      ) : keys.isError ? (
        <ErrorState error={keys.error} />
      ) : keys.data.length === 0 ? (
        <EmptyState title="No API keys yet">Create one to connect an MCP client.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.map((k) => (
              <TableRow key={k.id} className={k.revoked_at ? "text-muted-foreground" : undefined}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs">{maskedKey(k.prefix)}</TableCell>
                <TableCell title={formatDateTime(k.created_at)}>{relativeTime(k.created_at)}</TableCell>
                <TableCell title={k.last_used_at ? formatDateTime(k.last_used_at) : undefined}>{relativeTime(k.last_used_at)}</TableCell>
                <TableCell>
                  {k.revoked_at ? (
                    <Badge variant="muted" title={formatDateTime(k.revoked_at)}>
                      Revoked
                    </Badge>
                  ) : (
                    <Badge variant="success">Active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!k.revoked_at && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          Revoke
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke "{k.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Clients using {maskedKey(k.prefix)} will be rejected (401) on their next request. This can't be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => revoke.mutate(k.id)}>Revoke key</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) create.reset();
        }}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>Name it after where you'll use it, e.g. "cursor-laptop".</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
            </div>
            <InlineError error={create.error} />
            <DialogFooter>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <OneTimeSecret
        title="Your new API key"
        description={`Key "${create.data?.key.name ?? ""}". Next: open the Connect page for copy-paste setup in Cursor, Claude Code, or MCP Inspector.`}
        secret={create.data?.secret ?? null}
        // Drop the only copy of the secret (the mutation result) when the dialog closes.
        onDone={() => create.reset()}
      />
    </div>
  );
}
