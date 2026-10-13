import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CallContext } from "./http.js";
import type { Note, NotesStore } from "./store.js";

const json = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

const preview = (n: Note) => ({
  id: n.id,
  title: n.title,
  body: n.body.length > 200 ? `${n.body.slice(0, 199)}…` : n.body,
  created_at: n.createdAt,
});

/**
 * Tools as the upstream names them. Through the gateway (slug "notes") they appear as
 * notes__create_note, notes__list_notes, and notes__search_notes.
 */
export function registerNotesTools(server: McpServer, store: NotesStore, ctx: CallContext): void {
  const run = (name: string, fn: () => Promise<CallToolResult> | CallToolResult) => async () => {
    ctx.tool = name;
    try {
      const r = await fn();
      ctx.outcome = "ok";
      return r;
    } catch {
      ctx.outcome = "error";
      return { isError: true, content: [{ type: "text" as const, text: "Internal error in the notes server" }] };
    }
  };

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Save a note for the team with a title and a body. Returns the new note's id.",
      inputSchema: {
        title: z.string().trim().min(1).max(200).describe("Short title."),
        body: z.string().max(10_000).describe("Note text (plain text or Markdown)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run("create_note", async () => {
      const n = await store.create(a.title, a.body);
      return json({ id: n.id, title: n.title, created_at: n.createdAt });
    })(),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List the most recent notes, newest first (bodies cut to 200 characters).",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("How many notes (1-100, default 20).") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => run("list_notes", () => json({ total: store.size, notes: store.list(a.limit).map(preview) }))(),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Find notes whose title or body contains the query (case-insensitive), newest first.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Text to look for."),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => run("search_notes", () => {
      const hits = store.search(a.query, a.limit);
      return json({ count: hits.length, notes: hits.map(preview) });
    })(),
  );
}
