import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { InlineError } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
      navigate(from && from !== "/login" ? from : "/servers", { replace: true });
    },
  });

  useEffect(() => {
    document.title = "Sign in · Team MCP Gateway";
  }, []);

  if (me.data) return <Navigate to="/servers" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Team MCP Gateway</CardTitle>
          <CardDescription>Sign in to manage servers, keys, and the audit log.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
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
            <Button type="submit" disabled={login.isPending}>
              {login.isPending ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">No account yet? Ask your gateway admin to invite you.</p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
