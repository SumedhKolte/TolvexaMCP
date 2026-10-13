import { Toaster as Sonner } from "sonner";

/** Toast notifications for action results (saved, revoked, API errors). */
export function Toaster() {
  return <Sonner position="top-right" richColors closeButton />;
}
