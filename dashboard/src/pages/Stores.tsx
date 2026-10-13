import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, Loader2Icon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage, type Store, type StoreLimits } from "@/lib/api";
import { useMe } from "@/lib/session";
import { formatDateTime, formatShortDateTime } from "@/lib/utils";

const NAME_RE = /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/;

function StoreStatusBadge({ store }: { store: Store }) {
  switch (store.status) {
    case "ready":
      return <Badge variant="success">Ready</Badge>;
    case "failed":
      return <Badge variant="danger">Failed</Badge>;
    case "deleting":
      return (
        <Badge variant="muted" className="gap-1">
          <Loader2Icon className="size-3 animate-spin" /> Deleting
        </Badge>
      );
    default:
      return (
        <Badge variant="info" className="gap-1">
          <Loader2Icon className="size-3 animate-spin" /> Provisioning
        </Badge>
      );
  }
}

/**
 * Stores (bonus): every store is a full WooCommerce install in its own namespace, created
 * in the background by the provisioner. Its tools appear for the whole team as
 * `store-<name>__<tool>` once it's ready.
 */
export function StoresPage() {
  const isAdmin = useMe().data?.role === "admin";
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [toDelete, setToDelete] = useState<Store | null>(null);

  const stores = useQuery({
    queryKey: ["stores"],
    queryFn: () => api<{ stores: Store[]; limits: StoreLimits }>("/api/stores"),
    // Poll while anything is in progress; otherwise refresh occasionally.
    refetchInterval: (q) => (q.state.data?.stores.some((s) => s.status === "provisioning" || s.status === "deleting") ? 4_000 : 30_000),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["stores"] });
    void qc.invalidateQueries({ queryKey: ["tools"] });
    void qc.invalidateQueries({ queryKey: ["servers"] });
  };
  const create = useMutation({
    mutationFn: (n: string) => api<{ store: Store }>("/api/stores", "POST", { name: n }),
    onSuccess: ({ store }) => {
      refresh();
      setOpen(false);
      setName("");
      toast.success(
        store.status === "ready" ? `${store.slug} already exists and is ready.` : `Creating ${store.slug}. This takes a few minutes; you can leave this page.`,
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Store) => api<{ store: Store }>(`/api/stores/${s.id}`, "DELETE"),
    onSuccess: ({ store }) => {
      refresh();
      toast.success(`Deleting ${store.slug}: its tools are removed now; the store and its data follow.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = stores.data;
  const limits = data?.limits;
  const atLimit = limits ? limits.mine >= limits.per_user || limits.all >= limits.total : false;
  const nameOk = NAME_RE.test(name);

  return (
    <div>
      <PageHeader
        title="Stores"
        description="Create a separate WooCommerce store in a few minutes. Each store gets its own storefront and its own tools (store-<name>__…) for the whole team."
      >
        {limits?.enabled && (
          <Button onClick={() => setOpen(true)} disabled={atLimit} title={atLimit ? "Store limit reached" : undefined}>
            <PlusIcon /> Create store
          </Button>
        )}
      </PageHeader>

      {stores.isLoading && <LoadingState />}
      {stores.isError && <ErrorState error={stores.error} />}
      {data && !limits?.enabled && (
        <EmptyState title="Store provisioning is turned off">An admin can enable it with global.stores.enabled in the values file.</EmptyState>
      )}
      {data && limits?.enabled && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            You have {limits.mine} of {limits.per_user} stores
            {isAdmin ? ` · ${limits.all} of ${limits.total} on this gateway` : ""}. Write tools (create product, change order status) are admin-only on
            new stores; adjust them on Permissions.
          </p>
          {data.stores.length === 0 ? (
            <EmptyState title="No stores yet">Create one to get a storefront and its WooCommerce tools.</EmptyState>
          ) : (
            <Card className="p-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Store</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Storefront</TableHead>
                    {isAdmin && <TableHead>Owner</TableHead>}
                    <TableHead>Created</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.stores.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-normal">
                        <div className="font-medium">{s.name}</div>
                        <code className="text-xs text-muted-foreground">{s.tool_prefix}…</code>
                      </TableCell>
                      <TableCell className="max-w-72 whitespace-normal">
                        <StoreStatusBadge store={s} />
                        {s.status_reason && (
                          <p className={`mt-1 text-xs ${s.status === "failed" ? "text-red-700" : "text-muted-foreground"}`}>{s.status_reason}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.status === "ready" ? (
                          <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline">
                            {s.url.replace(/^https?:\/\//, "")} <ExternalLinkIcon className="size-3.5" />
                          </a>
                        ) : (
                          <span className="text-sm text-muted-foreground">{s.url.replace(/^https?:\/\//, "")}</span>
                        )}
                      </TableCell>
                      {isAdmin && <TableCell className="truncate text-sm">{s.owner_email ?? "—"}</TableCell>}
                      <TableCell className="text-sm whitespace-nowrap" title={formatDateTime(s.created_at)}>
                        {formatShortDateTime(s.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {s.status === "failed" && (
                            <Button variant="ghost" size="icon" title="Retry" aria-label={`Retry ${s.name}`} disabled={create.isPending} onClick={() => create.mutate(s.name)}>
                              <RotateCcwIcon />
                            </Button>
                          )}
                          {s.status !== "deleting" && (
                            <Button variant="ghost" size="icon" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => setToDelete(s)}>
                              <Trash2Icon />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setName("");
        }}
      >
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) create.mutate(name);
            }}
          >
            <DialogHeader>
              <DialogTitle>Create store</DialogTitle>
              <DialogDescription>
                A new WordPress + WooCommerce store with a sample product. It runs separately from the other stores and takes a few minutes to set up.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 grid gap-1.5">
              <Label htmlFor="store-name">Name</Label>
              <Input
                id="store-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="e.g. outlet"
                maxLength={24}
                autoFocus
                aria-invalid={name.length > 0 && !nameOk}
              />
              <p className="text-xs text-muted-foreground">
                {name && !nameOk
                  ? "2–24 characters: lowercase letters, digits and dashes, starting with a letter."
                  : name
                    ? `Storefront: ${limits?.url_template.replace("{name}", name) ?? ""} · Tools: store-${name}__list_orders, …`
                    : "Lowercase letters, digits and dashes."}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!nameOk || create.isPending}>
                {create.isPending ? "Creating…" : "Create store"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          {toDelete && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {toDelete.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its tools disappear for everyone right away, then the whole store is removed: products, orders, customers and uploads. This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate(toDelete)}>Delete store</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
