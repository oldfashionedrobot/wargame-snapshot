import { describe, expect, it } from 'bun:test';
import { TERRAIN } from './data/terrain';
import type { TileType } from './data/terrain';
import { parseTerrainGrid } from './terrainGrid';

describe('parseTerrainGrid', () => {
  it('reads a map into a grid indexed [row][col]', () => {
    // Deliberately not square, so a transposition cannot pass.
    const grid = parseTerrainGrid(['..^', '~-=']);
    expect(grid).toEqual([
      ['plains', 'plains', 'hills'],
      ['river', 'road', 'bridge'],
    ]);
    expect(grid[1][0]).toBe('river'); // row 1, col 0 -- not col 1, row 0
  });

  it('round-trips every character the terrain table defines', () => {
    const tiles = Object.keys(TERRAIN) as TileType[];
    const row = tiles.map((tile) => TERRAIN[tile].char).join('');
    expect(parseTerrainGrid([row])[0]).toEqual(tiles);
  });

  // A mistyped tile is a map that plays wrong, and it is far cheaper to find
  // here than three turns into a match -- so refuse rather than salvage.
  it('throws on an unknown character, naming where it is', () => {
    expect(() => parseTerrainGrid(['...', '.x.'])).toThrow(/unknown map character 'x'.*row 1/);
  });

  it('throws on a ragged map', () => {
    expect(() => parseTerrainGrid(['...', '..'])).toThrow(/row 1 is 2 wide, expected 3/);
  });

  it('throws on a map with no tiles', () => {
    expect(() => parseTerrainGrid([])).toThrow(/at least one tile/);
    expect(() => parseTerrainGrid([''])).toThrow(/at least one tile/);
  });
});
