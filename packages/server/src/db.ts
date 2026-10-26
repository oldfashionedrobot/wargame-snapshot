import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate as runMigrations } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema';
import { DB_AUTH_TOKEN, DEFAULT_DB_URL } from './const';

// `file:` paths in DATABASE_URL are relative to the REPO ROOT, not to whoever
// is running. That has to be pinned down because two processes read the same
// variable from different directories: the server runs with cwd set to its own
// package, while drizzle-kit runs from the root. Left to cwd, one string would
// mean two different files and migrations would quietly build a second, empty
// database next to the real one.
// fileURLToPath, not .pathname -- the latter percent-encodes, so a checkout
// under a path with a space would resolve to a literal "my%20name" directory.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Generated SQL lives beside this file's package, not beside whoever is
// running -- the same reason DATABASE_URL is resolved against the repo root.
const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface Database {
  /**
   * Typed queries, and `db.$client` for the two things Drizzle cannot express:
   * pragmas, and the `'write'` transaction mode on submit's batch. Carrying the
   * raw client separately would be a second reference to the same object.
   */
  db: LibSQLDatabase<typeof schema> & { $client: Client };
  url: string;
}

/**
 * Opens a connection and applies the pragmas that belong to it.
 *
 * `busy_timeout` is per *connection* and resets to 0 on every new one, so it
 * has to be set here rather than anywhere that runs once (verified). Without it
 * contention throws SQLITE_BUSY instead of waiting. `journal_mode = WAL` is by
 * contrast a property of the file that survives restarts -- see setUpDatabase.
 *
 * Both are no-ops against a remote libSQL server, which manages its own
 * concurrency, hence the `file:` guard.
 *
 * The url travels with the client so migrate() can't be pointed at a different
 * database than the one it's configuring.
 */
export async function createDb(url: string = DEFAULT_DB_URL): Promise<Database> {
  const resolved = resolveUrl(url);
  const client = createClient({ url: resolved, authToken: DB_AUTH_TOKEN });
  if (resolved.startsWith('file:')) await client.execute('PRAGMA busy_timeout = 5000');
  return { db: drizzle(client, { schema }), url: resolved };
}

/**
 * Brings the database up to the schema in `schema.ts`.
 *
 * The DDL is generated -- `bun run db:generate` after changing the schema, and
 * the migration files it writes are the record of what has been applied. Run
 * as a step of its own, by `migrate.ts`, and never by the server.
 *
 * Deliberately does not touch connection settings: pairing them here is how
 * moving this to a deploy step would silently take busy_timeout with it.
 */
export async function migrate({ db, url }: Database): Promise<void> {
  // A property of the database file, not the connection -- set once, survives
  // every restart. Lets readers run alongside the single writer.
  if (url.startsWith('file:')) await db.$client.execute('PRAGMA journal_mode = WAL');

  await runMigrations(db, { migrationsFolder: MIGRATIONS });
}

function resolveUrl(url: string): string {
  if (!url.startsWith('file:')) return url; // libsql://, http:// -- not a path
  const path = url.slice('file:'.length);
  if (path.startsWith('/')) return url; // already absolute
  return `file:${resolve(REPO_ROOT, path)}`;
}
