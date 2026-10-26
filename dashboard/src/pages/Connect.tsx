import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/Layout";
import { EmptyState, ErrorState, LoadingState } from "@/components/States";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type Tool } from "@/lib/api";

const KEY_PLACEHOLDER = "<YOUR_API_KEY>";

function Snippet({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-zinc-950 p-4 pr-24 text-xs leading-relaxed text-zinc-100">{code}</pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

/**
 * How to connect an MCP client. Only two things are needed: the gateway's MCP URL and the
 * user's own API key. Upstream URLs and credentials never appear here: the gateway adds
 * them on its side. The URL is taken from the page's own origin (same host as the API).
 */
export function ConnectPage() {
  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const tools = useQuery({ queryKey: ["tools"], queryFn: () => api<{ tools: Tool[] }>("/api/tools").then((r) => r.tools) });

  const cursor = JSON.stringify({ mcpServers: { "team-gateway": { url: mcpUrl, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } }, null, 2);
  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        "team-gateway": {
          command: "node",
          args: [
            "<PATH_TO_REPO>/scripts/claude-desktop-bridge.mjs",
            mcpUrl,
            KEY_PLACEHOLDER,
          ],
        },
      },
    },
    null,
    2
  );
  const claudeCode = `claude mcp add --transport http team-gateway ${mcpUrl} \\\n  --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`;
  const inspector = `npx @modelcontextprotocol/inspector`;
  const curl = `curl -s ${mcpUrl} \\\n  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`;

  const byServer = new Map<string, Tool[]>();
  for (const t of tools.data ?? []) byServer.set(t.server, [...(byServer.get(t.server) ?? []), t]);

  return (
    <div className="space-y-6">
      <PageHeader title="Connect" description="Use every tool you're allowed to use, from any MCP client, through one endpoint." />

      <Card>
        <CardHeader>
          <CardTitle>1. Endpoint and key</CardTitle>
          <CardDescription>
            Transport: Streamable HTTP. Authentication: <code>Authorization: Bearer</code> with your personal key. Create one on{" "}
            <Link to="/keys" className="underline">
              My Keys
            </Link>{" "}
            (it's shown once) and paste it where the snippets say <code>{KEY_PLACEHOLDER}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-sm">
            <span className="text-muted-foreground">Gateway URL</span>
            <code className="truncate">{origin}</code>
            <CopyButton value={origin} />
            <span className="text-muted-foreground">MCP endpoint</span>
            <code className="truncate">{mcpUrl}</code>
            <CopyButton value={mcpUrl} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Add it to your client</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="cursor">
            <TabsList>
              <TabsTrigger value="cursor">Cursor</TabsTrigger>
              <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="inspector">MCP Inspector</TabsTrigger>
              <TabsTrigger value="curl">curl</TabsTrigger>
            </TabsList>
            <TabsContent value="cursor" className="space-y-3 text-sm">
              <p>
                Add this to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project), then enable <b>team-gateway</b> under Settings → MCP.
              </p>
              <Snippet code={cursor} />
            </TabsContent>
            <TabsContent value="claude-desktop" className="space-y-3 text-sm">
              <p>
                The Claude Mac/Windows desktop app communicates via <code>stdio</code> subprocesses. Use the included bridge script at <code>scripts/claude-desktop-bridge.mjs</code> to connect:
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Open Claude Desktop → <b>Settings</b> (<code>Cmd + ,</code>) → <b>Developer</b> → <b>Edit Config</b> (or edit <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>).
                </li>
                <li>Add this snippet to <code>mcpServers</code>:</li>
              </ol>
              <Snippet code={claudeDesktop} />
              <p className="text-xs text-muted-foreground">
                Replace <code>&lt;PATH_TO_REPO&gt;</code> with your absolute repository path (or download the script via <code>curl -s {origin}/claude-bridge.mjs -o ~/claude-bridge.mjs</code>). Completely quit and restart Claude Desktop (<code>Cmd + Q</code>) after saving.
              </p>
            </TabsContent>
            <TabsContent value="claude" className="space-y-3 text-sm">
              <p>Run once in a terminal; then <code>/mcp</code> inside Claude Code shows the server and its tools.</p>
              <Snippet code={claudeCode} />
            </TabsContent>
            <TabsContent value="inspector" className="space-y-3 text-sm">
              <ol className="list-decimal space-y-1 pl-5">
                <li>Start the Inspector (it opens in your browser):</li>
              </ol>
              <Snippet code={inspector} />
              <ol start={2} className="list-decimal space-y-1 pl-5">
                <li>
                  Transport type: <b>Streamable HTTP</b>; URL: <code>{mcpUrl}</code>
                </li>
                <li>
                  Under Authentication / Headers add <code>Authorization</code> = <code>Bearer {KEY_PLACEHOLDER}</code>
                </li>
                <li>Connect, then List Tools.</li>
              </ol>
            </TabsContent>
            <TabsContent value="curl" className="space-y-3 text-sm">
              <p>Quick check from a terminal: lists the tools your key can use.</p>
              <Snippet code={curl} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Tools you'll see</CardTitle>
          <CardDescription>Exactly what your MCP client gets: every enabled server's tools that your role may call, named &lt;server&gt;__&lt;tool&gt;.</CardDescription>
        </CardHeader>
        <CardContent>
          {tools.isPending ? (
            <LoadingState label="Loading tools…" />
          ) : tools.isError ? (
            <ErrorState error={tools.error} />
          ) : byServer.size === 0 ? (
            <EmptyState title="No tools available right now">Servers may be disabled or unreachable; check the Servers page.</EmptyState>
          ) : (
            <div className="grid gap-4">
              {[...byServer].map(([server, list]) => (
                <div key={server}>
                  <div className="mb-1 text-sm font-medium">
                    {server} <Badge variant="secondary">{list.length}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((t) => (
                      <code key={t.name} title={t.description} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {t.name}
                      </code>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
