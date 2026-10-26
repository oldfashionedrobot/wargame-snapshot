import { TERRAIN } from './data/terrain';
import type { TileType } from './data/terrain';

// Maps are written as character grids, because then the source file looks
// like the board -- readable in an editor, in a diff, and in review. This is
// the only way a grid is ever built: `createMatchState` parses one, and so
// does the test fixture, so the shape production plays on is the shape tests
// exercise.
//
// It lives in shared/ rather than beside the map *definitions* in server/,
// because it is a pure function over shared vocabulary and shared/'s own
// tests need terrain grids -- and shared/ cannot import from server/.

// The legend, inverted from the table's `char` column once at load. Keeping a
// second hand-written legend here is exactly how one of the two drifts.
const TILE_BY_CHAR = new Map<string, TileType>(
  (Object.keys(TERRAIN) as TileType[]).map((tile) => [TERRAIN[tile].char, tile]),
);

/**
 * Turns map rows into a grid, indexed `[row][col]` to match `GameState.grid`.
 *
 * Throws on an unknown character or a ragged row rather than salvaging what
 * it can -- the same reasoning as `applyEvents` refusing an unknown event. A
 * mistyped tile is a map that plays wrong, and a map that plays wrong is far
 * cheaper to find here than three turns into a match.
 */
export function parseTerrainGrid(rows: string[]): TileType[][] {
  const width = rows[0]?.length ?? 0;
  if (rows.length === 0 || width === 0) throw new Error('a map needs at least one tile');

  return rows.map((row, rowIndex) => {
    if (row.length !== width) {
      throw new Error(`map row ${rowIndex} is ${row.length} wide, expected ${width}`);
    }
    return [...row].map((char, colIndex) => {
      const tile = TILE_BY_CHAR.get(char);
      if (!tile) {
        throw new Error(`unknown map character '${char}' at row ${rowIndex}, column ${colIndex}`);
      }
      return tile;
    });
  });
}
