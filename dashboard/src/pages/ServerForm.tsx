import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { InlineError } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type CredType, type Server } from "@/lib/api";
import { slugify, SLUG_RE } from "@/lib/utils";

/**
 * Add / edit an upstream server (admin only).
 * The credential is WRITE-ONLY: it's never loaded back from the API (the API doesn't
 * return it). In edit mode an empty field means "keep the stored credential".
 */
export function ServerForm({ open, onOpenChange, server }: { open: boolean; onOpenChange: (o: boolean) => void; server?: Server }) {
  const qc = useQueryClient();
  const editing = Boolean(server);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [credType, setCredType] = useState<CredType>("none");
  const [headerName, setHeaderName] = useState("");
  const [credential, setCredential] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("10");

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? "");
    setSlug(server?.slug ?? "");
    setSlugTouched(editing);
    setUrl(server?.url ?? "");
    setCredType(server?.cred_type ?? "none");
    setHeaderName(server?.cred_header_name ?? "");
    setCredential("");
    setTimeoutSec(String((server?.timeout_ms ?? 10_000) / 1000));
  }, [open, server, editing]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        url: url.trim(),
        cred_type: credType,
        cred_header_name: credType === "header" ? headerName.trim() : null,
        // Blank = keep (edit) / none (create). Never sent back if untouched.
        ...(credential ? { credential } : {}),
        timeout_ms: Math.round(Number(timeoutSec) * 1000),
      };
      if (editing && server) {
        const patch = server.builtin ? { name: body.name, timeout_ms: body.timeout_ms } : body;
        return api<{ server: Server }>(`/api/servers/${server.id}`, "PATCH", patch);
      }
      return api<{ server: Server }>("/api/servers", "POST", { ...body, slug });
    },
    onSuccess: ({ server: s }) => {
      setCredential("");
      void qc.invalidateQueries({ queryKey: ["servers"] });
      void qc.invalidateQueries({ queryKey: ["tools"] });
      const cred = s.credential_set ? "credential set" : "no credential";
      if (s.status === "connected") toast.success(`${s.name} saved: connected, ${s.tool_count} tools, ${cred}.`);
      else toast.warning(`${s.name} saved (${cred}), but it's ${s.status}: ${s.last_error ?? "no details"}`);
      onOpenChange(false);
    },
  });

  const slugError = !editing && slug && !SLUG_RE.test(slug) ? "2-30 characters: lowercase letters, digits, dashes" : null;
  const lockedConnection = Boolean(server?.builtin);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${server?.name}` : "Add server"}</DialogTitle>
            <DialogDescription>
              {editing ? "Changes apply to every user at once." : "The gateway test-connects once; the server is saved even if it's down right now."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="srv-name">Name</Label>
              <Input
                id="srv-name"
                value={name}
                required
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="srv-slug">Slug (tool prefix)</Label>
              <Input
                id="srv-slug"
                value={slug}
                disabled={editing}
                required
                aria-invalid={Boolean(slugError)}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
              <p className="text-xs text-muted-foreground">{slugError ?? `Tools appear as ${slug || "slug"}__<tool>`}</p>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="srv-url">MCP URL</Label>
            <Input
              id="srv-url"
              value={url}
              required={!lockedConnection}
              disabled={lockedConnection}
              placeholder="http://my-server.upstreams.svc.cluster.local:8080/mcp"
              onChange={(e) => setUrl(e.target.value)}
            />
            {lockedConnection && <p className="text-xs text-muted-foreground">The built-in server's URL and credential are managed by the deployment.</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Credential type</Label>
              <Select value={credType} onValueChange={(v) => setCredType(v as CredType)} disabled={lockedConnection}>
                <SelectTrigger aria-label="Credential type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                  <SelectItem value="header">Custom header</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="srv-timeout">Tool timeout (seconds)</Label>
              <Input id="srv-timeout" type="number" min={0.1} max={300} step={0.1} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
            </div>
          </div>

          {credType === "header" && (
            <div className="grid gap-2">
              <Label htmlFor="srv-header">Header name</Label>
              <Input id="srv-header" value={headerName} placeholder="X-Api-Key" required onChange={(e) => setHeaderName(e.target.value)} />
            </div>
          )}

          {credType !== "none" && !lockedConnection && (
            <div className="grid gap-2">
              <Label htmlFor="srv-cred">Credential</Label>
              <Input
                id="srv-cred"
                type="password"
                autoComplete="off"
                value={credential}
                required={!editing || !server?.credential_set}
                placeholder={editing && server?.credential_set ? "•••••••• (leave blank to keep)" : "Paste the token"}
                onChange={(e) => setCredential(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Write-only. Stored encrypted; members and MCP clients never see it.
                {editing && ` Currently ${server?.credential_set ? "set" : "not set"}.`}
              </p>
            </div>
          )}

          <InlineError error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || Boolean(slugError)}>
              {save.isPending ? "Saving and testing…" : editing ? "Save" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
