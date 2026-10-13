import { useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, LogOutIcon, MenuIcon, MessageSquareIcon, NetworkIcon, PlugIcon, ScrollTextIcon, ServerIcon, ShieldCheckIcon, StoreIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const NAV = [
  { to: "/servers", label: "Servers", icon: ServerIcon },
  { to: "/stores", label: "Stores", icon: StoreIcon },
  { to: "/chat", label: "Chat", icon: MessageSquareIcon },
  { to: "/team", label: "Team", icon: UsersIcon, adminOnly: true },
  { to: "/permissions", label: "Permissions", icon: ShieldCheckIcon },
  { to: "/keys", label: "My Keys", icon: KeyRoundIcon },
  { to: "/connect", label: "Connect", icon: PlugIcon },
  { to: "/audit", label: "Audit Log", icon: ScrollTextIcon },
];

const DESKTOP = "(min-width: 768px)"; // Tailwind's md breakpoint
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isDesktop = () => window.matchMedia(DESKTOP).matches;

export function Layout() {
  const me = useMe().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Below the md breakpoint the sidebar is a drawer opened from the top bar.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop);
  // A closed drawer is off screen: make it inert so Tab can't move focus into it.
  const drawerHidden = !desktop && !menuOpen;

  async function logout() {
    await api("/api/auth/logout", "POST").catch(() => undefined);
    qc.clear();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen md:flex">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-zinc-50 px-4 md:hidden">
        <span className="flex items-center gap-2 font-semibold">
          <NetworkIcon className="size-5" /> Team MCP Gateway
        </span>
        <Button variant="ghost" size="sm" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <MenuIcon />
        </Button>
      </header>
      {menuOpen && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <aside
        {...(drawerHidden ? { inert: "" } : {})}
        aria-label="Main navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-64 shrink-0 flex-col border-r bg-zinc-50 transition-transform md:sticky md:top-0 md:h-screen md:w-56 md:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-5 py-5 font-semibold">
          <span className="flex items-center gap-2">
            <NetworkIcon className="size-5" /> Team MCP Gateway
          </span>
          <Button variant="ghost" size="sm" className="md:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <XIcon />
          </Button>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.filter((n) => !n.adminOnly || me?.role === "admin").map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-200/60",
                  isActive && "bg-zinc-200 font-medium text-zinc-950",
                )
              }
            >
              <n.icon className="size-4" /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t p-4 text-sm">
          <div className="truncate font-medium" title={me?.email}>
            {me?.email}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <Badge variant={me?.role === "admin" ? "default" : "secondary"}>{me?.role}</Badge>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOutIcon /> Log out
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-4 md:px-8 md:py-6">
        <Outlet />
      </main>
    </div>
  );
}

/** Page title row with optional actions on the right. */
export function PageHeader({ title, description, children }: { title: string; description?: React.ReactNode; children?: React.ReactNode }) {
  // Distinct tab titles, so browser tabs and history say which page is which.
  useEffect(() => {
    document.title = `${title} · Team MCP Gateway`;
  }, [title]);
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}
