// Test fixtures. Kept in src/ so tests can import it, and out of index.ts so it
// is not part of the package's public surface -- server/ and client/ have no
// reason to build game states by hand.
import { TERRAIN } from './data/terrain';
import { getUnitType, MAX_HEALTH } from './data/unitTypes';
import type { UnitTypeId } from './data/unitTypes';
import { parseTerrainGrid } from './terrainGrid';
import type { Coordinate, Facing, GameState, PlayerId, Unit } from './types';

export interface UnitSpec {
  id: string;
  col: number;
  row: number;
  owner?: string;
  /** Defaults to infantry. What it buys -- movement range today -- is read
   *  from the catalog, so a search test wanting a particular budget passes
   *  one to the search rather than picking a type that happens to have it. */
  unitTypeId?: UnitTypeId;
  /** Defaults to full. A wounded unit is what most combat cases are about. */
  health?: number;
  /** ⚠️ Defaults to `south`, which is a *rule* input and not decoration: an
   *  attack from directly behind is never answered, so where a test puts an
   *  attacker relative to this decides whether a counter happens at all.
   *  Anything asserting a counter should say which way the defender looks
   *  rather than inherit it. */
  facing?: Facing;
  /** Defaults to empty; `fullMeter` gives a charging test its type's full one. */
  chargeMeter?: number;
  hasActed?: boolean;
}

// A size becomes a character map of plains rather than a grid built by hand,
// so there is exactly one way a grid is ever constructed -- parsing one --
// and a fixture cannot drift from what production does. The character comes
// from the terrain table, so not even the '.' is written twice.
function mapRows(map: number | { cols: number; rows: number } | string[]): string[] {
  if (Array.isArray(map)) return map;
  const { cols, rows } = typeof map === 'number' ? { cols: map, rows: map } : map;
  return Array.from({ length: rows }, () => TERRAIN.plains.char.repeat(cols));
}

/**
 * A board with the units you name and nothing else.
 *
 * A number gives a square board of plains; `{ cols, rows }` gives anything
 * else -- a one-wide corridor is the shape that makes "can this unit pass
 * through that one" answerable without a wall of surrounding tiles. Pass
 * **map rows** instead when the terrain is the point: `makeState(['..^',
 * '~..'], units)` reads like the board it builds.
 *
 * Two players, 'blue' and 'red', with blue to move. Everything a test cares
 * about is a named argument, so the interesting part of a fixture is visible
 * at the call site rather than buried in defaults.
 */
export function makeState(
  map: number | { cols: number; rows: number } | string[],
  units: UnitSpec[],
  currentTurn = 'blue',
  /** A finished game, for the rules that only apply to one. */
  winner: PlayerId | null = null,
): GameState {
  return {
    grid: parseTerrainGrid(mapRows(map)),
    players: [
      { id: 'blue', name: 'Blue Army', color: 'blue' },
      { id: 'red', name: 'Red Army', color: 'red' },
    ],
    units: units.map((u): Unit => ({
      id: u.id,
      position: { col: u.col, row: u.row },
      facing: u.facing ?? 'south',
      unitTypeId: u.unitTypeId ?? 'infantry',
      owner: u.owner ?? 'blue',
      health: u.health ?? MAX_HEALTH,
      chargeMeter: u.chargeMeter ?? 0,
      hasActed: u.hasActed ?? false,
    })),
    currentTurn,
    winner,
  };
}

/**
 * Expands waypoints into a step-by-step orthogonal route: column first, then
 * row, with no waypoint repeated at a junction.
 *
 * Paths on the wire are routes, not endpoints -- `validatePath` walks every
 * step -- so a fixture that writes `[from, to]` is describing a move no
 * client can make. Tests asserting on an *illegal* path still write the array
 * by hand, which is what keeps the illegality visible where it is asserted.
 */
export function route(...waypoints: Coordinate[]): Coordinate[] {
  const start = waypoints[0];
  if (!start) throw new Error('a route needs at least one waypoint');

  const path: Coordinate[] = [start];
  let { col, row } = start;
  for (const waypoint of waypoints.slice(1)) {
    while (col !== waypoint.col) {
      col += Math.sign(waypoint.col - col);
      path.push({ col, row });
    }
    while (row !== waypoint.row) {
      row += Math.sign(waypoint.row - row);
      path.push({ col, row });
    }
  }
  return path;
}

/**
 * A coordinate, in as few characters as the idea deserves.
 *
 * ⚠️ **Here because it was written ten times.** Every suite that names a tile
 * had its own copy, half of them untyped, and a fixture helper module already
 * existed -- so the duplication was not even buying independence from one.
 * Coordinates are the unit of nearly every assertion in the rulebook, and a
 * two-character name is what keeps a board legible at the call site.
 */
export const at = (col: number, row: number): Coordinate => ({ col, row });

export const unitAt = (state: GameState, id: string): Unit => {
  const unit = state.units.find((u) => u.id === id);
  if (!unit) throw new Error(`no unit ${id} in fixture`);
  return unit;
};

/**
 * A full charge meter for this type -- what a charging test stages, read from
 * the catalog so no test pins a size. Throws for a type that cannot charge:
 * a test giving one a meter means to, and says so with a number of its own.
 */
export function fullMeter(unitTypeId: UnitTypeId): number {
  const size = getUnitType(unitTypeId).attacksToCharge;
  if (size === null) throw new Error(`${unitTypeId} cannot charge`);
  return size;
}
