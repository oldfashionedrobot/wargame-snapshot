import { defineConfig } from 'drizzle-kit';

// Paths are relative to the REPO ROOT, because drizzle-kit resolves them
// against cwd and `db:generate` always runs from there; through
// `bun run --filter` they would name folders that do not exist. No database
// credentials: generating compares the schema with the last snapshot and never
// connects, and migrating is `migrate.ts`.
export default defineConfig({
  dialect: 'turso',
  schema: './packages/server/src/schema.ts',
  out: './packages/server/drizzle',
});
