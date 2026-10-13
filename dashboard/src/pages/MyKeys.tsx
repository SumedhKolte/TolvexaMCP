import { KeyManager } from "@/components/KeyManager";
import { PageHeader } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";

export function MyKeysPage() {
  return (
    <div>
      <PageHeader title="My Keys" description="Personal API keys for MCP clients (Cursor, Claude Code, MCP Inspector). Revoke a key the moment you stop using it." />
      <Card>
        <CardContent className="pt-6">
          <KeyManager />
        </CardContent>
      </Card>
    </div>
  );
}
