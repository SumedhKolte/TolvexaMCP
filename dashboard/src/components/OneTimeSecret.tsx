import { TriangleAlertIcon } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Shows a secret (a new API key or a new user's initial password) exactly once.
 * The parent owns the value and must drop it in `onDone` (and reset the mutation that
 * produced it), so after this dialog closes the value exists nowhere in the UI.
 */
export function OneTimeSecret({
  title,
  description,
  secret,
  onDone,
}: {
  title: string;
  description: string;
  secret: string | null;
  onDone: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onDone()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={secret ?? ""} className="font-mono text-xs" aria-label="Secret value" onFocus={(e) => e.currentTarget.select()} />
          {secret && <CopyButton value={secret} />}
        </div>
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          Copy it now. It won't be shown again; only its prefix is kept.
        </p>
        <DialogFooter>
          <Button onClick={onDone}>I've copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
