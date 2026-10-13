import { AlertTriangleIcon, InboxIcon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Loading / empty / error placeholders used by every list, so no list is ever just blank. */

export function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground", className)}>
      <Loader2Icon className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 py-12 text-center", className)}>
      <InboxIcon className="size-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Shows the gateway's own error message; never a stack trace. */
export function ErrorState({ error, className }: { error: unknown; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-center justify-center gap-2 py-12 text-sm text-red-700", className)}>
      <AlertTriangleIcon className="size-4" /> {errorMessage(error)}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {errorMessage(error)}
    </p>
  );
}
