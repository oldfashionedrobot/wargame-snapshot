import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Converts the period figures and buildings into the GLBs the game loads -- `bun
// run models`, naming figures (`british/infantry`) or buildings (`house_dutch`) to
// convert only those. Blender does the work, in convert.py; this finds it and the
// packs. Run by hand, never by a build: the packs are licensed and live outside
// the repo, and what it writes is committed.
//
// BLENDER overrides where Blender is; AWI_MODELS where the packs were unzipped.
const BLENDER = process.env.BLENDER ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const SOURCES = process.env.AWI_MODELS ?? join(homedir(), 'Development', 'awi-models');
const SCRIPT = fileURLToPath(new URL('./convert.py', import.meta.url));
const OUT = fileURLToPath(new URL('../../public/models', import.meta.url));

const { status, error } = spawnSync(
  BLENDER,
  [
    '-b',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '--python',
    SCRIPT,
    '--',
    SOURCES,
    OUT,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
if (error) throw error;
process.exit(status ?? 1);
