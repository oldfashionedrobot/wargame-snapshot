import { coordinatesEqual, coordinateKey, orthogonalNeighbours, tileDistance } from './coordinate';
import { getTerrain } from './data/terrain';
import type { MovementType } from './data/unitTypes';
import type { TileType } from './data/terrain';
import { getTileAt, getUnitAt, inContact } from './queries';
import type { Coordinate, GameState, Unit } from './types';

type Entry = { ok: true; cost: number; stops: boolean } | { ok: false; reason: string };

const nameOf = (coordinate: Coordinate) => `(${coordinate.col},${coordinate.row})`;

/**
 * May this movement type be on this terrain at all, at any price?
 *
 * ⚠️ **Split out of `entryCost` because charge needs this half and not the
 * other.** A charge displaces onto the *target's* tile, so it has to ask
 * whether that ground admits the attacker -- and `entryCost` answers "held by
 * an enemy" for exactly that tile, which is the one thing a charge is not
 * troubled by. Duplicating the terrain lookup instead would be a second
 * spelling of one rule, which is the shape this codebase keeps correcting.
 */
export function terrainAdmits(tile: TileType, movementType: MovementType): boolean {
  return getTerrain(tile).cost[movementType] !== null;
}

/**
 * May this unit step onto this tile, what does it cost, and does stepping onto
 * it end the move?
 *
 * **The one place those questions are answered**, called by both consumers: the
 * search below explores with it, and `validatePath` walks with it. That is
 * what makes "client and server share a cost model" structural rather than a
 * rule two implementations have to keep. See the invariant in Terrain.
 *
 * ⚠️ **`stops` is contact.** A tile beside an enemy may be entered but not
 * passed through: the move ends there. That is a different question from
 * whether the unit may *stop* here at all -- a friendly unit's tile is
 * enterable and not stoppable -- which is the same line `settled` and
 * `reachable` draw, so the destination check belongs to `validatePath`. A
 * friend standing in contact is therefore a dead end: entering it ends the
 * move, and the move cannot end on a friend.
 *
 * Off the board is a refusal rather than a separate bounds check: `getTileAt`
 * already answers `undefined` there, so asking for the terrain and asking
 * whether the tile exists are one question.
 */
function entryCost(
  state: GameState,
  unit: Unit,
  coordinate: Coordinate,
  movementType: MovementType,
): Entry {
  const tile = getTileAt(state, coordinate);
  if (!tile) return { ok: false, reason: `${nameOf(coordinate)} is off the board` };

  const occupant = getUnitAt(state, coordinate);
  if (occupant && occupant.owner !== unit.owner) {
    return { ok: false, reason: `${nameOf(coordinate)} is held by an enemy` };
  }

  // ⚠️ Asked through `terrainAdmits` so charge and movement cannot disagree
  // about what ground a unit may be on; the cost is read here because only
  // movement spends it.
  if (!terrainAdmits(tile, movementType)) {
    return { ok: false, reason: `${movementType} cannot cross ${tile}` };
  }

  return {
    ok: true,
    cost: getTerrain(tile).cost[movementType]!,
    stops: inContact(state, unit, coordinate),
  };
}

export interface Movement {
  /**
   * Where this unit may legally **stop**. Excludes its own tile and any tile
   * another unit is standing on.
   *
   * ⚠️ This is the *legality* set, not the overlay -- it used to be both, and
   * the two questions are different. `settled` is what gets drawn.
   */
  reachable: Coordinate[];
  /**
   * Every tile the search touched: `reachable`, plus the friendly-occupied
   * tiles a route may pass *through*, plus the unit's own.
   *
   * ⚠️ **This is what the range overlay draws**, because reach is the
   * information a player is reading and a hole punched in it where a friend
   * happens to stand reads as *out of range* rather than as *occupied*.
   * Not everything drawn is clickable, which is the point: the overlay answers
   * "how far can I go", and `reachable` answers "may I stop here".
   *
   * Exactly the set `pathTo` answers for, and there is a test saying so.
   */
  settled: Coordinate[];
  /**
   * The cheapest route to a destination, walked back through predecessors --
   * not a second search. `null` for a tile the search never settled.
   *
   * Answers for any *settled* tile, which is a larger set than `reachable`:
   * a friendly unit's tile can be routed through even though nobody may stop
   * on it. "May I stop here" is `reachable`'s question, not this one.
   *
   * The route to the unit's own tile is `[position]` -- the single-element
   * path that costs 0.
   */
  pathTo(destination: Coordinate): Coordinate[] | null;
}

interface Settled {
  coordinate: Coordinate;
  cost: number;
  /** Key of the tile this was reached from; `null` only for the origin. */
  from: string | null;
  /** Entered in contact, so the search goes no further from here. */
  stops: boolean;
}

/**
 * One search, two outputs: where a unit may stop, and how it gets anywhere it
 * settled.
 *
 * **The budget and movement type are arguments, not lookups.** Resolving them
 * from `getUnitType` is the caller's job -- there are two. A search that did
 * it would make every test here name a real unit type to get a budget,
 * coupling tests about the search to catalog values, so tuning cavalry's
 * range would break tests that have nothing to do with cavalry.
 *
 * **It relaxes rather than settling once.** A neighbour already recorded more
 * expensively is lowered and re-queued, which is Bellman-Ford relaxation over
 * a FIFO queue -- correct for any non-negative costs, not only uniform ones.
 * A priority queue would make each node final the first time it is popped,
 * which is easier to reason about but no more correct, and buys no speed
 * worth having: the explored region is bounded by the *budget*, not the
 * board, so a range-6 unit touches a few dozen tiles on a map of any size.
 * If settles-once is ever wanted, the shape is a bucket queue indexed
 * `0..budget` rather than a heap -- the costs are small bounded integers.
 *
 * Collision follows Advance Wars: an enemy blocks the tile *and* the route; a
 * friend blocks only the tile, and can be walked through.
 *
 * ⚠️ **And contact ends a move.** A tile beside an enemy is reached and never
 * left in the same move, so getting past or round the enemy takes a berth wide
 * enough to stay out of contact. The origin is exempt -- a unit that starts in
 * contact may walk out of it -- which is why `stops` is recorded per tile
 * entered rather than asked of wherever the search happens to be.
 */
export function exploreMovement(
  state: GameState,
  unit: Unit,
  movementRange: number,
  movementType: MovementType,
): Movement {
  // Everything the search touched, keyed by coordinate -- Coordinate has no
  // value equality in JS. This is the map `pathTo` walks; `reachable` is
  // derived from it once, at the end. Filtering the map itself instead would
  // make a route *through* a friendly unit unfindable.
  const settled = new Map<string, Settled>();
  settled.set(coordinateKey(unit.position), {
    coordinate: unit.position,
    cost: 0,
    from: null,
    stops: false,
  });
  const queue: Coordinate[] = [unit.position];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const currentKey = coordinateKey(current);
    const currentCost = settled.get(currentKey)?.cost ?? 0;
    if (currentCost >= movementRange) continue; // nothing left to spend
    if (settled.get(currentKey)?.stops) continue; // entered in contact: the move ends here

    for (const next of orthogonalNeighbours(current)) {
      // Off the board, impassable, or held by an enemy -- one question, and
      // the same answer validatePath walks with.
      const entry = entryCost(state, unit, next, movementType);
      if (!entry.ok) continue;

      // Checked per step, not once at the top: with costs above 1, having
      // budget left over does not mean the next tile fits inside it.
      const nextCost = currentCost + entry.cost;
      if (nextCost > movementRange) continue;

      const key = coordinateKey(next);
      const known = settled.get(key);
      if (known !== undefined && known.cost <= nextCost) continue;

      settled.set(key, { coordinate: next, cost: nextCost, from: currentKey, stops: entry.stops });
      queue.push(next);
    }
  }

  const touched = [...settled.values()].map((entry) => entry.coordinate);

  return {
    // Everything settled except what is stood on. That excludes the origin
    // without a separate check, because a unit occupies its own tile -- an
    // explicit `from !== null` filter used to sit here and no test could tell
    // whether it was there, which is what redundant means.
    reachable: touched.filter((coordinate) => !getUnitAt(state, coordinate)),
    settled: touched,

    pathTo(destination) {
      let cursor: string | null = coordinateKey(destination);
      if (!settled.has(cursor)) return null;

      // Terminates because every terrain costs at least 1 to enter, so a
      // predecessor is always strictly cheaper than what points at it and a
      // cycle cannot form. The terrain table has a test for that.
      const path: Coordinate[] = [];
      while (cursor !== null) {
        const entry: Settled | undefined = settled.get(cursor);
        if (!entry) return null;
        path.unshift(entry.coordinate);
        cursor = entry.from;
      }
      return path;
    },
  };
}

/**
 * Is this path one this unit could actually walk, right now?
 *
 * Returns the reason it is refused, or `null` if it is legal -- the same
 * shape the other reducers answer with.
 *
 * **The server checks the route it was given; it never derives one.** That is
 * an O(path) walk rather than an O(board) search per command, it leaves the
 * client free to change how it picks routes (manual routing becomes a pure UI
 * feature later, with no protocol change), and it costs only that both sides
 * agree on the *cost model* -- which `entryCost` now guarantees by being the
 * one place that decides.
 *
 * The reasons are **diagnostics**. A client that picks destinations from
 * `movement.reachable` and paths from `pathTo` cannot trip them; anything
 * that does is broken, hostile, or acting on a stale snapshot.
 */
export function validatePath(
  state: GameState,
  unit: Unit,
  path: Coordinate[],
  movementRange: number,
  movementType: MovementType,
): string | null {
  const start = path[0];
  if (!start) return 'path is empty';
  if (!coordinatesEqual(start, unit.position)) return 'path does not start at the unit';

  // A path that visits a tile twice is nonsense no client produces, and
  // refusing it is cheap. It is not what bounds the path's length, though --
  // every terrain costs at least 1 to enter, so the budget below already
  // caps the number of steps.
  const seen = new Set([coordinateKey(start)]);
  let spent = 0;

  for (let i = 1; i < path.length; i++) {
    const step = path[i];
    const previous = path[i - 1];
    if (tileDistance(previous, step) !== 1)
      return `path jumps from ${nameOf(previous)} to ${nameOf(step)}`;

    const key = coordinateKey(step);
    if (seen.has(key)) return `path revisits ${nameOf(step)}`;
    seen.add(key);

    const entry = entryCost(state, unit, step, movementType);
    if (!entry.ok) return entry.reason;
    if (entry.stops && i < path.length - 1) {
      return `${nameOf(step)} is in contact with the enemy, and a move ends there`;
    }

    spent += entry.cost;
    if (spent > movementRange) return 'move exceeds movement range';
  }

  // Entering and stopping are different questions. A friendly unit is walked
  // through above and refused here; the moving unit is excluded, so a
  // single-element path -- standing still -- does not fail its own test.
  const destination = path[path.length - 1];
  const occupant = getUnitAt(state, destination);
  if (occupant && occupant.id !== unit.id) return `${nameOf(destination)} is occupied`;

  return null;
}
