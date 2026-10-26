import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from './db';

// The script as the release step and `db:migrate` run it: a process of its own,
// in a directory with no .env for bun to load on its own.
const dir = mkdtempSync(join(tmpdir(), 'wargame-migrate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = async (env: Record<string, string>) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'migrate.ts')], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
    stdout: 'ignore',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

describe('migrate.ts', () => {
  it('brings a database to the current schema, and changes nothing the second time', async () => {
    const url = `file:${join(dir, 'fresh.db')}`;
    expect((await run({ DATABASE_URL: url })).code).toBe(0);
    expect((await run({ DATABASE_URL: url })).code).toBe(0);

    const { db } = await createDb(url);
    const { rows } = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(['matches', 'resolutions']));
    db.$client.close();
  });

  // The release step's last chance to stop a deploy with the old machine
  // still serving -- and before it touches any database.
  it('refuses in production without the configuration, naming what is missing', async () => {
    const url = `file:${join(dir, 'untouched.db')}`;
    const { code, stderr } = await run({ NODE_ENV: 'production', DATABASE_URL: url });
    expect(code).toBe(1);
    expect(/error: production needs (.+)/.exec(stderr)?.[1].split(', ')).toEqual([
      'DATABASE_AUTH_TOKEN',
      'GUEST_KEY',
    ]);
    expect(await Bun.file(join(dir, 'untouched.db')).exists()).toBe(false);
  });
});
