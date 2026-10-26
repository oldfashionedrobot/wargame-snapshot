import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Writes .br and .gz siblings for every compressible asset in dist/, so the
// server can hand pre-compressed bytes to any client that accepts them
// instead of shipping megabytes of JavaScript raw (5c-2 reads these). Runs
// from the `bundle` script; Vite empties dist/ per build, so a stale variant
// cannot survive a rebuild.

// Resolved from this file, not cwd -- the script runs both from the package
// (bun run --filter) and from wherever a human happens to be.
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
// The models too: the figures are megabytes, and brotli halves them.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.glb']);

const files = readdirSync(DIST, { recursive: true })
  .map(String)
  .filter((name) => COMPRESSIBLE.has(extname(name)))
  .map((name) => join(DIST, name));

for (const file of files) {
  const content = readFileSync(file);
  writeFileSync(
    `${file}.br`,
    brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
    }),
  );
  writeFileSync(`${file}.gz`, gzipSync(content, { level: constants.Z_BEST_COMPRESSION }));
}

console.log(`compressed ${files.length} assets to .br and .gz`);
