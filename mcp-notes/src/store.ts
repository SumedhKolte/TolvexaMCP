import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

/**
 * Notes kept in memory, optionally mirrored to a JSON file (an emptyDir in Kubernetes, so
 * notes survive a container restart but not pod deletion; persistence isn't required).
 * Capped at `maxNotes` (oldest dropped) so a loop can't exhaust memory.
 */
export class NotesStore {
  private notes: Note[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file?: string,
    private readonly maxNotes = 1000,
  ) {
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Note[];
        if (Array.isArray(parsed)) this.notes = parsed.slice(-maxNotes);
      } catch {
        // No file yet (first start) or unreadable: start empty.
      }
    }
  }

  async create(title: string, body: string): Promise<Note> {
    const note: Note = { id: randomUUID(), title, body, createdAt: new Date().toISOString() };
    this.notes.push(note);
    if (this.notes.length > this.maxNotes) this.notes.splice(0, this.notes.length - this.maxNotes);
    await this.persist();
    return note;
  }

  /** Newest first. */
  list(limit: number): Note[] {
    return this.notes.slice(-limit).reverse();
  }

  /** Case-insensitive substring match on title and body, newest first. */
  search(query: string, limit: number): Note[] {
    const q = query.toLowerCase();
    return this.notes
      .filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      .slice(-limit)
      .reverse();
  }

  get size(): number {
    return this.notes.length;
  }

  /** Write-then-rename so a crash mid-write never leaves a truncated file; writes are serialized. */
  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const snapshot = JSON.stringify(this.notes);
    this.writing = this.writing.then(async () => {
      await writeFile(`${file}.tmp`, snapshot, "utf8");
      await rename(`${file}.tmp`, file);
    });
    return this.writing;
  }
}
