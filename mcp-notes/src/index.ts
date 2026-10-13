import { z } from "zod";
import { tokenReader } from "./auth.js";
import { createMcpApp } from "./http.js";
import { log } from "./log.js";
import { NotesStore } from "./store.js";
import { registerNotesTools } from "./tools.js";

const parsed = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Mounted Secret directory with MCP_BEARER_TOKEN. Unset: read the token from env. */
    SECRETS_DIR: z.string().min(1).optional(),
    /** Optional JSON file for notes (an emptyDir in Kubernetes). Unset: memory only. */
    NOTES_FILE: z.string().min(1).optional(),
    MAX_NOTES: z.coerce.number().int().positive().default(1000),
  })
  .safeParse(process.env);
if (!parsed.success) {
  log({ msg: "startup failed", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
  process.exit(1);
}
const env = parsed.data;

const store = new NotesStore(env.NOTES_FILE, env.MAX_NOTES);
const app = createMcpApp({
  serverInfo: { name: "mcp-notes", version: "0.1.0" },
  registerTools: (server, ctx) => registerNotesTools(server, store, ctx),
  getBearerToken: tokenReader(env.SECRETS_DIR),
  log,
});

const server = app.listen(env.PORT, () => log({ msg: "listening", port: env.PORT, notes: store.size, persisted: Boolean(env.NOTES_FILE) }));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log({ msg: "shutting down", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
