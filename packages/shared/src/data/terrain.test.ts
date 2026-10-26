import { describe, expect, it } from 'bun:test';
import { getTerrain, TERRAIN } from './terrain';
import type { TileType } from './terrain';
import { UNIT_TYPES } from './unitTypes';

// The contract, not the tuning. Asserting that forest costs a horse 2 would
// fail every time the game is balanced, which says nothing about whether the
// table is well-formed -- and these are the properties the search and the
// parser actually rely on.

const tiles = Object.keys(TERRAIN) as TileType[];
const movementTypes = Object.values(UNIT_TYPES).map((unitType) => unitType.movementType);

describe('the terrain table', () => {
  it('gives every terrain a cost for every movement type', () => {
    for (const tile of tiles) {
      for (const movementType of movementTypes) {
        const cost = TERRAIN[tile].cost[movementType];
        expect(cost === null || cost > 0).toBe(true);
      }
    }
  });

  // Zero would make a tile free to enter, and the search's budget check would
  // stop bounding anything -- an infinite reachable set on a large enough map.
  it('never charges zero to enter a tile', () => {
    for (const tile of tiles) {
      for (const cost of Object.values(TERRAIN[tile].cost)) {
        if (cost !== null) expect(cost).toBeGreaterThan(0);
      }
    }
  });

  it('gives every terrain a non-negative defence value', () => {
    for (const tile of tiles) {
      expect(TERRAIN[tile].defense).toBeGreaterThanOrEqual(0);
    }
  });

  // The parser inverts this column, so a duplicate would make one of the two
  // terrains unreachable from a map file -- silently, and only for whichever
  // lost the race.
  it('gives every terrain a distinct single-character map symbol', () => {
    const chars = tiles.map((tile) => TERRAIN[tile].char);
    for (const char of chars) expect(char).toHaveLength(1);
    expect(new Set(chars).size).toBe(chars.length);
  });

  // Somewhere has to be crossable by everything, or a map cannot connect.
  it('leaves at least one terrain passable to every movement type', () => {
    for (const movementType of movementTypes) {
      expect(tiles.some((tile) => TERRAIN[tile].cost[movementType] !== null)).toBe(true);
    }
  });

  // ⚠️ `null` and a large number are meant to be different answers -- shut
  // outright versus expensive -- and a cost above every relevant unit's range
  // collapses them without saying so. Hills are the live case: tuning a horse's
  // range under their cost would make them impassable to cavalry while the table
  // still claimed otherwise.
  //
  // A range check rather than a value check, so this survives balancing.
  it('never charges more to enter a tile than any unit that could enter it can pay', () => {
    for (const tile of tiles) {
      for (const [movementType, cost] of Object.entries(TERRAIN[tile].cost)) {
        if (cost === null) continue;
        const budgets = Object.values(UNIT_TYPES)
          .filter((unitType) => unitType.movementType === movementType)
          .map((unitType) => unitType.movementRange);
        expect(Math.max(...budgets)).toBeGreaterThanOrEqual(cost);
      }
    }
  });
});

describe('getTerrain', () => {
  it('returns the entry for every tile type', () => {
    for (const tile of tiles) {
      expect(getTerrain(tile)).toBe(TERRAIN[tile]);
    }
  });

  // A board written before a terrain existed is exactly this case; the types
  // cannot see it because the state came back out of SQLite as JSON.
  it('throws on a tile the table does not hold', () => {
    expect(() => getTerrain('land' as TileType)).toThrow(/unknown terrain/);
  });
});
