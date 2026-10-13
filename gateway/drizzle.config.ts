import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/db/schema.ts against the committed migrations and writes a
// new SQL migration into ./drizzle. Migrations are applied by the gateway at startup.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
