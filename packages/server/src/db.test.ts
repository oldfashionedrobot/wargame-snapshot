import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, migrate } from './db';

// The one trap the plan says has already bitten: a relative `file:` URL means
// two different files depending on who resolves it, and the losing side
// silently creates a second empty database beside the real one. Every other
// server test uses `:memory:`, so nothing exercised the path arithmetic at
// all -- these do, on a temp directory that is cleaned up after.

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const scratch: string[] = [];
// Files created inside the repo by a resolution probe, removed with their
// journal siblings so nothing is left beside the real database.
const probes: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const file of probes.splice(0)) {
    for (const suffix of ['', '-shm', '-wal']) rmSync(file + suffix, { force: true });
  }
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wargame-db-'));
  scratch.push(dir);
  return dir;
};

describe('database url resolution', () => {
  it('resolves a relative file: path against the repo root, not the cwd', async () => {
    // The whole point: the server runs with its cwd set to its own package
    // while drizzle-kit runs from the root, and they must agree. Deliberately
    // *not* the real DATABASE_URL path -- opening a connection creates the
    // file, and no test may reach the development database.
    const relative = 'file:./packages/server/.resolve-probe.db';
    const { url } = await createDb(relative);
    expect(url).toBe(`file:${join(REPO_ROOT, 'packages/server/.resolve-probe.db')}`);
    probes.push(join(REPO_ROOT, 'packages/server/.resolve-probe.db'));
  });

  it('leaves an absolute file: path alone', async () => {
    const path = join(tempDir(), 'absolute.db');
    const { url } = await createDb(`file:${path}`);
    expect(url).toBe(`file:${path}`);
  });

  // A hosted database is a connection string, not a path -- rewriting one
  // against the repo root would produce nonsense.
  it('leaves a non-file url alone', async () => {
    expect((await createDb(':memory:')).url).toBe(':memory:');
  });
});

describe('migrate', () => {
  it('creates the schema in a real file, and is safe to run twice', async () => {
    const path = join(tempDir(), 'fresh.db');
    const database = await createDb(`file:${path}`);

    await migrate(database);
    await migrate(database); // pending migrations only; the second is a no-op

    expect(existsSync(path)).toBe(true);
    const { rows } = await database.db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(rows.map((row) => row.name)).toContain('matches');
    expect(rows.map((row) => row.name)).toContain('resolutions');
  });

  // WAL is a property of the file and survives restarts, which is why it is
  // set here rather than per connection -- and why it must not be attempted
  // against a database that has no file.
  it('puts a file-backed database into WAL mode', async () => {
    const database = await createDb(`file:${join(tempDir(), 'wal.db')}`);
    await migrate(database);
    const { rows } = await database.db.$client.execute('PRAGMA journal_mode');
    expect(String(rows[0].journal_mode).toLowerCase()).toBe('wal');
  });
});
