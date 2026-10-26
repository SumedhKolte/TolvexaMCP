import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/client.js";

describe("database pool", () => {
  it("survives an idle-client error (a Postgres restart) instead of crashing the process", async () => {
    const seen: string[] = [];
    const pool = createPool("postgres://u:secret@127.0.0.1:1/db", (e) => seen.push(e.message));
    // What node-postgres does when the server goes away: emit "error" on the pool.
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(seen).toEqual(["terminating connection due to administrator command"]);
    await pool.end();
  });

  it("without a callback it still has a listener, so an error is swallowed rather than thrown", async () => {
    const pool = createPool("postgres://u:secret@127.0.0.1:1/db");
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
    await pool.end();
  });
});
