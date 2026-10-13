import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlusIcon } from "lucide-react";
import { ExpandButton } from "@/components/ExpandButton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { KeyManager } from "@/components/KeyManager";
import { PageHeader } from "@/components/Layout";
import { OneTimeSecret } from "@/components/OneTimeSecret";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, type Role, type User, type UserWithKeys } from "@/lib/api";
import { useMe } from "@/lib/session";
import { formatDateTime, relativeTime } from "@/lib/utils";

/** Team (admin only): users, roles, enable/disable, and each user's API keys. */
export function TeamPage() {
  const me = useMe().data;
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: UserWithKeys[] }>("/api/users").then((r) => r.users) });
  const [expanded, setExpanded] = useState<string | null>(null);
  // Role changes and disabling take effect immediately for that person, so both ask first.
  const [pending, setPending] = useState<{ user: UserWithKeys; patch: { role?: Role; disabled?: boolean } } | null>(null);

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { role?: Role; disabled?: boolean } }) => api<{ user: User }>(`/api/users/${id}`, "PATCH", patch),
    onSuccess: ({ user }, { patch }) => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(
        patch.disabled === undefined
          ? `${user.email} is now ${user.role}.`
          : `${user.email} ${patch.disabled ? "disabled: their sessions and keys stop working now" : "enabled"}.`,
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Create user: the server returns a generated initial password exactly once.
  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const create = useMutation({
    mutationFn: () => api<{ user: User; initial_password: string }>("/api/users", "POST", { email: email.trim(), role }),
    onSuccess: () => {
      setCreateOpen(false);
      setEmail("");
      setRole("member");
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  return (
    <div>
      <PageHeader title="Team" description="Who can use the gateway, with what role, and with which API keys.">
        <Button onClick={() => setCreateOpen(true)}>
          <UserPlusIcon /> Create user
        </Button>
      </PageHeader>

      <Card className="p-2">
        {users.isPending ? (
          <LoadingState label="Loading users…" />
        ) : users.isError ? (
          <ErrorState error={users.error} />
        ) : users.data.length === 0 ? (
          <EmptyState title="No users" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Active keys</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((u) => {
                const self = u.id === me?.id;
                return (
                  <Fragment key={u.id}>
                    <TableRow className={u.disabled ? "cursor-pointer text-muted-foreground" : "cursor-pointer"} onClick={() => setExpanded(expanded === u.id ? null : u.id)}>
                      <TableCell>
                        <ExpandButton expanded={expanded === u.id} label={`API keys of ${u.email}`} onToggle={() => setExpanded(expanded === u.id ? null : u.id)} />
                      </TableCell>
                      <TableCell className="font-medium">
                        {u.email} {self && <Badge variant="outline">you</Badge>}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()} className="w-36">
                        <Select value={u.role} onValueChange={(v) => setPending({ user: u, patch: { role: v as Role } })} disabled={update.isPending}>
                          <SelectTrigger className="h-8" aria-label={`Role of ${u.email}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">admin</SelectItem>
                            <SelectItem value="member">member</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>{u.disabled ? <Badge variant="muted">Disabled</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.active_keys}</TableCell>
                      <TableCell title={formatDateTime(u.created_at)}>{relativeTime(u.created_at)}</TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={self || update.isPending}
                          title={self ? "You can't disable yourself" : undefined}
                          onClick={() => (u.disabled ? update.mutate({ id: u.id, patch: { disabled: false } }) : setPending({ user: u, patch: { disabled: true } }))}
                        >
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expanded === u.id && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <KeyManager userId={u.id} ownerLabel={u.email} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

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
              <DialogTitle>Create user</DialogTitle>
              <DialogDescription>A strong initial password is generated and shown to you once. Hand it over securely.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="user-email">Email</Label>
              <Input id="user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                <SelectTrigger aria-label="Role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member: calls tools allowed for members, manages own keys</SelectItem>
                  <SelectItem value="admin">admin: everything, including servers and users</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <InlineError error={create.error} />
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create user"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pending.patch.disabled ? `Disable ${pending.user.email}?` : `Make ${pending.user.email} ${pending.patch.role === "admin" ? "an admin" : "a member"}?`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pending.patch.disabled
                    ? "They're signed out everywhere and all their API keys stop working on the next request. You can enable them again later."
                    : pending.patch.role === "admin"
                      ? "Admins can manage servers, users, and keys, call every tool, and see the whole audit log."
                      : "They lose admin access immediately and can only call tools allowed for members."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={pending.patch.disabled ? undefined : "bg-primary hover:bg-primary/90"}
                  onClick={() => update.mutate({ id: pending.user.id, patch: pending.patch })}
                >
                  {pending.patch.disabled ? "Disable user" : "Change role"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      <OneTimeSecret
        title={`Initial password for ${create.data?.user.email ?? ""}`}
        description="Share it with the user over a secure channel. They sign in with it on the login page."
        secret={create.data?.initial_password ?? null}
        onDone={() => create.reset()}
      />
    </div>
  );
}
