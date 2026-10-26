import { Navigate, Outlet, useLocation } from "react-router";
import { useMe } from "@/lib/session";
import { ErrorState, LoadingState } from "./States";

/**
 * Route guard. Hiding admin pages is only a convenience: every admin action is also
 * enforced by the gateway (403), so a member who navigates here directly sees nothing
 * they couldn't fetch anyway.
 */
export function RequireAuth({ adminOnly = false }: { adminOnly?: boolean }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <LoadingState label="Loading…" className="h-screen" />;
  if (me.isError) return <ErrorState error={me.error} className="h-screen" />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (adminOnly && me.data.role !== "admin") return <Navigate to="/overview" replace />;
  return <Outlet />;
}
