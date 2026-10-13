import { cn } from "@/lib/utils";

/** Button look for elements that aren't <Button> (e.g. Radix AlertDialog actions). */
export function buttonClass(variant: "default" | "destructive" | "outline") {
  const base =
    "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";
  const v = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive: "bg-destructive text-white hover:bg-destructive/90",
    outline: "border bg-background hover:bg-accent",
  }[variant];
  return cn(base, v);
}
