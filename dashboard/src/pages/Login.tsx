import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { HistoryIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { InlineError } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type User } from "@/lib/api";
import { useMe } from "@/lib/session";

export function LoginPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api<{ user: User }>("/api/auth/login", "POST", { email, password }),
    onSuccess: ({ user }) => {
      setPassword("");
      qc.setQueryData(["me"], user);
      navigate(from && from !== "/login" ? from : "/overview", { replace: true });
    },
  });

  useEffect(() => {
    document.title = "Sign in · Team MCP Gateway";
  }, []);

  if (me.data) return <Navigate to="/overview" replace />;

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden="true" className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-primary-foreground/10 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-primary-foreground/10 blur-3xl" />
        <div className="relative flex items-center gap-3 text-lg font-semibold">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary-foreground/15">
            <BrandMark className="size-7" />
          </span>
          Team MCP Gateway
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance">One endpoint for every tool your team uses.</h1>
          <ul className="mt-8 grid gap-4 text-[15px] opacity-90">
            <li className="flex gap-3">
              <KeyRoundIcon className="mt-0.5 size-5 shrink-0" /> Your own API key. Upstream credentials never leave the gateway.
            </li>
            <li className="flex gap-3">
              <ShieldCheckIcon className="mt-0.5 size-5 shrink-0" /> Roles decide which tools each person can see and call.
            </li>
            <li className="flex gap-3">
              <HistoryIcon className="mt-0.5 size-5 shrink-0" /> Every call is audited, from any client or the chat assistant.
            </li>
          </ul>
        </div>
        <p className="relative text-xs opacity-70">Kubernetes-native · Streamable HTTP MCP</p>
      </aside>

      <main className="flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark />
            <span className="text-lg font-semibold">Team MCP Gateway</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to manage servers, keys, and the audit log.</p>
          <form
            className="mt-8 grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <InlineError error={login.error} />
            <Button type="submit" size="lg" disabled={login.isPending}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-muted-foreground">No account yet? Ask your gateway admin to invite you.</p>
        </div>
      </main>
    </div>
  );
}
