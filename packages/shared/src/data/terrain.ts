import type { MovementType } from './unitTypes';

// Static content, like unitTypes beside it: what a forest costs a horse never
// changes mid-match. `TileType` lives here rather than in types.ts because it
// is content vocabulary -- the set of things a map can be made of -- and this
// table is what gives each of them meaning.

export type TileType =
  'plains' | 'road' | 'bridge' | 'forest' | 'hills' | 'river' | 'sea' | 'structure';

export interface Terrain {
  /**
   * How this terrain is written in a map source file. The legend lives here
   * and nowhere else -- `parseTerrainGrid` inverts this column rather than
   * keeping a second copy that could drift.
   */
  char: string;
  /**
   * Stars of cover, read through `defenseAt`: each takes a point off a hit per
   * band of the defender's health, Advance Wars' scale -- see `computeDamage`.
   *
   * ⚠️ How many the stoutest ground may carry is the *no living attacker is
   * harmless* sweep in `combat.test.ts`, which fails before cover could reach a
   * whole hit. No limit is written here: it follows from the damage table.
   */
  defense: number;
  /**
   * Movement points to *enter* this tile, per movement type. `null` is
   * impassable -- not "expensive", genuinely no route through.
   */
  cost: Record<MovementType, number | null>;
}

// A Record over TileType, so adding a terrain type is a compile error until it
// has a row here, rather than a tile that silently costs undefined. The
// renderer's `baseCell` refuses to compile the same way until it is drawn.
export const TERRAIN: Record<TileType, Terrain> = {
  // Roads and bridges are mechanically identical; the split exists so the
  // renderer can draw a crossing over water. `wheels` paying 1.5 on plains
  // against 1 on road is the whole of "artillery prefers roads" -- a ratio
  // rather than a tile count, because how many tiles that buys is a property of
  // `movementRange` and moves when the gun is tuned.
  road: { char: '-', defense: 0, cost: { foot: 1, horse: 1, wheels: 1 } },
  bridge: { char: '=', defense: 0, cost: { foot: 1, horse: 1, wheels: 1 } },
  plains: { char: '.', defense: 1, cost: { foot: 1, horse: 1, wheels: 1.5 } },
  forest: { char: 'f', defense: 2, cost: { foot: 1.5, horse: 2, wheels: 3 } },
  // Rough ground, and stout cover. A man climbs it at a price and a horse can
  // be led up it -- but 3 against cavalry's range of 4 means the climb is
  // three quarters of a turn. A cavalry reaches a peak only from close by, at
  // most one step of approach, and never takes one in passing. That is the
  // shape of the decision: cavalry is fast *in the open*, not fast everywhere.
  // A gun carriage does not go up a rock face at any price.
  hills: { char: '^', defense: 3, cost: { foot: 2, horse: 3, wheels: null } },
  river: { char: '~', defense: 0, cost: { foot: 2, horse: 3, wheels: null } },
  // Water nobody enters yet, though fire crosses it, as in Advance Wars. Its
  // defense is never read, since nothing stands there.
  sea: { char: 'w', defense: 0, cost: { foot: null, horse: null, wheels: null } },
  // A building, and the stoutest cover there is -- yet as cheap to enter as a
  // road, as Advance Wars prices a city, so a gun can hold one.
  structure: { char: '#', defense: 4, cost: { foot: 1, horse: 1, wheels: 1 } },
};

/**
 * Throws on a tile the table does not hold, for the same reason `getUnitType`
 * does: the types make it unreachable in-process and guarantee nothing about
 * a `GameState` parsed back out of the database, where a board written before
 * a terrain existed is exactly the case. An undefined here would surface as
 * NaN movement somewhere else entirely.
 */
export function getTerrain(tile: TileType): Terrain {
  const terrain = TERRAIN[tile];
  if (!terrain) throw new Error(`unknown terrain: ${String(tile)}`);
  return terrain;
}
