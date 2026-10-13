import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

/**
 * Row expander that works with keyboard and screen readers (a real <button> with
 * aria-expanded). The whole row stays clickable for mouse users; this button is the
 * accessible way to do the same thing.
 */
export function ExpandButton({ expanded, label, onToggle }: { expanded: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Hide" : "Show"} ${label}`}
      className="rounded-sm p-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
    </button>
  );
}
