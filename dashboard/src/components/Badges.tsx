import type { Outcome, ServerStatus } from "@/lib/api";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Connected = green, Unreachable = red (last_error in a tooltip), Disabled = grey. */
export function StatusBadge({ status, lastError }: { status: ServerStatus; lastError: string | null }) {
  if (status === "connected") return <Badge variant="success">Connected</Badge>;
  if (status === "disabled") return <Badge variant="muted">Disabled</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          <Badge variant="danger" className="cursor-help">
            Unreachable
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{lastError ?? "No details"}</TooltipContent>
    </Tooltip>
  );
}

const OUTCOME_VARIANT: Record<Outcome, "success" | "danger" | "warning" | "muted" | "info"> = {
  ok: "success",
  error: "danger",
  denied: "warning",
  timeout: "info",
  unreachable: "danger",
  disabled: "muted",
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return <Badge variant={OUTCOME_VARIANT[outcome]}>{outcome}</Badge>;
}
