import { useQueryClient } from "@tanstack/react-query";
import {
  HistoryIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  ServerIcon,
  ShieldCheckIcon,
  StoreIcon,
  SunIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BrandMark } from "./BrandMark";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

/** Grouped by what the person is doing, not by how the system is built. */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboardIcon },
      { to: "/chat", label: "Chat", icon: MessageSquareIcon },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/servers", label: "Servers", icon: ServerIcon },
      { to: "/stores", label: "Stores", icon: StoreIcon },
      { to: "/permissions", label: "Permissions", icon: ShieldCheckIcon },
      { to: "/team", label: "Team", icon: UsersIcon, adminOnly: true },
    ],
  },
  {
    label: "Access",
    items: [
      { to: "/keys", label: "My Keys", icon: KeyRoundIcon },
      { to: "/connect", label: "Connect", icon: PlugIcon },
    ],
  },
  { label: "Observe", items: [{ to: "/audit", label: "Audit Log", icon: HistoryIcon }] },
];

const DESKTOP = "(min-width: 768px)"; // Tailwind's md breakpoint
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isDesktop = () => window.matchMedia(DESKTOP).matches;

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "system", label: "Match system", icon: MonitorIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return (
    <div role="radiogroup" aria-label="Colour theme" className="inline-flex rounded-md border bg-background p-0.5">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          onClick={() => setPreference(value)}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            preference === value && "bg-accent text-accent-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

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
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-sidebar px-4 md:hidden">
        <span className="flex items-center gap-2.5 font-semibold">
          <BrandMark className="size-7" /> Team MCP Gateway
        </span>
        <Button variant="ghost" size="sm" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <MenuIcon />
        </Button>
      </header>
      {menuOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <aside
        {...(drawerHidden ? { inert: "" } : {})}
        aria-label="Main navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh w-64 shrink-0 flex-col border-r bg-sidebar transition-transform md:sticky md:top-0 md:h-screen md:w-60 md:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
          <span className="flex items-center gap-2.5">
            <BrandMark />
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight">Team MCP</span>
              <span className="block text-xs text-muted-foreground">Gateway</span>
            </span>
          </span>
          <Button variant="ghost" size="sm" className="md:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <XIcon />
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-3">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((n) => !n.adminOnly || me?.role === "admin");
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="mt-4 first:mt-0">
                <div className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground/80 uppercase">{group.label}</div>
                <div className="flex flex-col gap-0.5">
                  {items.map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      className={({ isActive }) =>
                        cn(
                          "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                          isActive && "bg-accent font-medium text-accent-foreground hover:bg-accent",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <span aria-hidden="true" className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />}
                          <n.icon className={cn("size-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} /> {n.label}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="border-t p-4 text-sm">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary uppercase">
              {me?.email?.[0] ?? "?"}
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium" title={me?.email}>
                {me?.email}
              </div>
              <Badge variant={me?.role === "admin" ? "default" : "secondary"} className="mt-0.5">
                {me?.role}
              </Badge>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <ThemeSwitch />
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
