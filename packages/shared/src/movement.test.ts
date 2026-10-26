import { describe, expect, it } from 'bun:test';
import { getTerrain, TERRAIN } from './data/terrain';
import { getUnitType } from './data/unitTypes';
import { exploreMovement, validatePath } from './movement';
import { at, makeState, route, unitAt } from './testing';
import type { UnitSpec } from './testing';
import type { Coordinate, GameState } from './types';
import type { MovementType } from './data/unitTypes';

const has = (tiles: Coordinate[], col: number, row: number) =>
  tiles.some((t) => t.col === col && t.row === row);

// The budget and movement type are arguments to the search, not properties of
// the fixture -- so these tests state the numbers they are about and stay
// unaffected by tuning any unit type in the catalog.
// ⚠️ Typed `MovementType`, not `'foot' as const` -- the assertion narrowed the
// *parameter* to a single literal, so every call passing 'wheels' or 'horse' was
// a type error nobody saw while these files were outside every program.
const explore = (
  state: GameState,
  id: string,
  movementRange = 3,
  movementType: MovementType = 'foot',
) => exploreMovement(state, unitAt(state, id), movementRange, movementType);

const reachable = (state: GameState, id: string, movementRange = 3) =>
  explore(state, id, movementRange).reachable;

describe('exploreMovement: settled, which is what the overlay draws', () => {
  // ⚠️ The invariant that makes `settled` meaningful rather than just a second
  // array: it is *exactly* the set `pathTo` answers for. If they ever diverge,
  // the overlay is lighting tiles no route can reach or hiding ones it can.
  it('is exactly the set pathTo answers for', () => {
    const state = makeState(['...', '.f.', '...'], [{ id: 'b1', col: 0, row: 0 }]);
    const movement = explore(state, 'b1');
    const key = (c: Coordinate) => `${c.col},${c.row}`;
    const inSettled = new Set(movement.settled.map(key));

    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        const tile = { col, row };
        expect(movement.pathTo(tile) !== null).toBe(inSettled.has(key(tile)));
      }
    }
  });

  // The whole reason for the split: a friend's tile is in reach and cannot be
  // stopped on, and the overlay should say the first rather than imply neither.
  it('includes a friendly tile that reachable excludes', () => {
    const state = makeState(6, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'friend', col: 1, row: 0 },
    ]);
    const { reachable, settled } = explore(state, 'b1');
    const has = (list: Coordinate[], col: number, row: number) =>
      list.some((c) => c.col === col && c.row === row);

    expect(has(settled, 1, 0)).toBe(true);
    expect(has(reachable, 1, 0)).toBe(false);
  });

  it('includes the unit’s own tile, which reachable also excludes', () => {
    const state = makeState(6, [{ id: 'b1', col: 2, row: 2 }]);
    const { reachable, settled } = explore(state, 'b1');
    const has = (list: Coordinate[], col: number, row: number) =>
      list.some((c) => c.col === col && c.row === row);

    expect(has(settled, 2, 2)).toBe(true);
    expect(has(reachable, 2, 2)).toBe(false);
  });

  // An enemy blocks the tile *and* the route, so it is never settled at all --
  // which is why the overlay showing everything settled cannot leak a tile the
  // unit has no business reaching.
  it('never includes an enemy’s tile', () => {
    const state = makeState(6, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 1, row: 0, owner: 'red' },
    ]);
    const { settled } = explore(state, 'b1');
    expect(settled.some((c) => c.col === 1 && c.row === 0)).toBe(false);
  });

  it('is a superset of reachable, always', () => {
    const state = makeState(
      ['....', '.ff.', '....'],
      [
        { id: 'b1', col: 0, row: 0 },
        { id: 'friend', col: 1, row: 0 },
      ],
    );
    const { reachable, settled } = explore(state, 'b1');
    const inSettled = new Set(settled.map((c) => `${c.col},${c.row}`));
    for (const tile of reachable) expect(inSettled.has(`${tile.col},${tile.row}`)).toBe(true);
  });
});

describe('exploreMovement: where a unit may stop', () => {
  it('excludes the unit its own tile -- which is what makes clicking it a deselect', () => {
    const state = makeState(7, [{ id: 'b1', col: 3, row: 3 }]);
    expect(has(reachable(state, 'b1'), 3, 3)).toBe(false);
  });

  it('reaches exactly the tiles within the movement budget', () => {
    const state = makeState(9, [{ id: 'b1', col: 4, row: 4 }]);
    const tiles = reachable(state, 'b1', 2);
    // The count is what makes "exactly" mean something: 4 tiles one step out,
    // 8 two steps out. Spot checks alone would pass an implementation that
    // also admitted an extra ring.
    expect(tiles).toHaveLength(12);
    expect(has(tiles, 4, 2)).toBe(true); // 2 away
    expect(has(tiles, 5, 5)).toBe(true); // 2 away, diagonal by two orthogonal steps
    expect(has(tiles, 4, 1)).toBe(false); // 3 away
  });

  it('does not leave the grid', () => {
    const SIZE = 3;
    const state = makeState(SIZE, [{ id: 'b1', col: 0, row: 0 }]);
    const tiles = reachable(state, 'b1', SIZE * SIZE); // more budget than board
    expect(tiles).toHaveLength(SIZE * SIZE - 1); // everything except its own tile
    const inside = (t: Coordinate) => t.col >= 0 && t.col < SIZE && t.row >= 0 && t.row < SIZE;
    expect(tiles.every(inside)).toBe(true);
  });

  it('is pure -- the state it was given is untouched', () => {
    const state = makeState(5, [{ id: 'b1', col: 2, row: 2 }]);
    const before = JSON.stringify(state);
    explore(state, 'b1');
    expect(JSON.stringify(state)).toBe(before);
  });
});

// Advance Wars' collision model, and the half people get wrong: an enemy
// blocks the tile *and* the route; a friend blocks only the tile.
describe('exploreMovement: unit collision', () => {
  it('cannot enter an enemy-occupied tile', () => {
    const state = makeState(7, [
      { id: 'b1', col: 3, row: 3 },
      { id: 'r1', col: 3, row: 4, owner: 'red' },
    ]);
    expect(has(reachable(state, 'b1'), 3, 4)).toBe(false);
  });

  // A one-wide corridor, so the only route to (0,2) runs through (0,1).
  const corridor = (blocker: UnitSpec) =>
    makeState({ cols: 1, rows: 3 }, [{ id: 'b1', col: 0, row: 0 }, blocker]);

  it('cannot pass through an enemy either -- it blocks the route', () => {
    const tiles = reachable(corridor({ id: 'r1', col: 0, row: 1, owner: 'red' }), 'b1');
    expect(has(tiles, 0, 1)).toBe(false);
    expect(has(tiles, 0, 2)).toBe(false); // unreachable: the enemy blocks the way
  });

  it('can pass through a friendly unit', () => {
    const tiles = reachable(corridor({ id: 'b2', col: 0, row: 1 }), 'b1');
    expect(has(tiles, 0, 2)).toBe(true);
  });

  it('but cannot stop on a friendly unit -- pass-through, not a destination', () => {
    const state = makeState(7, [
      { id: 'b1', col: 3, row: 3 },
      { id: 'b2', col: 3, row: 4 },
    ]);
    expect(has(reachable(state, 'b1'), 3, 4)).toBe(false);
  });
});

// ⚠️ **Contact ends a move.** A tile beside an enemy may be entered but not
// passed through, so getting past or round the enemy takes a berth wide enough
// to stay out of contact. A blue foot on an open 7x5, a red unit at (3,2).
describe('exploreMovement: contact', () => {
  const field = (redType: 'infantry' | 'cavalry' | 'artillery' = 'infantry', blueAt = at(0, 2)) =>
    makeState({ cols: 7, rows: 5 }, [
      { id: 'b1', ...blueAt },
      { id: 'r1', col: 3, row: 2, owner: 'red', unitTypeId: redType },
    ]);

  it('lets a unit stop beside the enemy', () => {
    expect(has(reachable(field(), 'b1', 6), 2, 2)).toBe(true);
  });

  // The far side of the enemy is a contact tile itself, and every short way to
  // it runs through another; only a berth round the diagonals gets there.
  it('makes the long way round the only way round', () => {
    const state = field();
    expect(explore(state, 'b1', 6).pathTo(at(4, 2))).toBeNull();
    const wide = explore(state, 'b1', 8).pathTo(at(4, 2));
    expect(wide).not.toBeNull();
    // ...and that route never sets foot in contact before its last step.
    const touching = (c: Coordinate) => Math.abs(c.col - 3) + Math.abs(c.row - 2) === 1;
    expect(wide!.slice(0, -1).some(touching)).toBe(false);
  });

  it('is made by every unit, guns included', () => {
    expect(has(reachable(field('cavalry'), 'b1', 6), 4, 2)).toBe(false);
    expect(has(reachable(field('artillery'), 'b1', 6), 4, 2)).toBe(false);
  });

  // ⚠️ The origin is exempt: a unit that starts in contact may walk out of it.
  it('lets a unit that starts in contact walk away', () => {
    expect(has(reachable(field('infantry', at(2, 2)), 'b1', 1), 1, 2)).toBe(true);
  });

  // A friend standing in contact is a dead end: entering it ends the move, and
  // a move cannot end on a friend.
  it('will not let a unit pass through a friend who is in contact', () => {
    const state = makeState({ cols: 7, rows: 5 }, [
      { id: 'b1', col: 2, row: 1 },
      { id: 'f1', col: 2, row: 2 },
      { id: 'r1', col: 3, row: 2, owner: 'red' },
    ]);
    const route = explore(state, 'b1', 6).pathTo(at(2, 3));
    expect(route).not.toBeNull();
    expect(route!.some((c) => c.col === 2 && c.row === 2)).toBe(false);
  });

  it('offers no route that validatePath refuses', () => {
    const state = field();
    const movement = explore(state, 'b1', 8);
    for (const tile of movement.reachable) {
      expect(
        validatePath(state, unitAt(state, 'b1'), movement.pathTo(tile)!, 8, 'foot'),
      ).toBeNull();
    }
  });
});

describe('exploreMovement: terrain costs', () => {
  // Row 0 is all road, row 1 all forest. Foot pays 1 either way, wheels pay 1
  // on road and 3 in forest -- so the same budget buys very different ground.
  const stripes = ['-----', 'fffff'];

  it('spends the terrain table, not one point per tile', () => {
    const state = makeState(stripes, [{ id: 'b1', col: 0, row: 0 }]);
    const onRoad = explore(state, 'b1', 3, 'wheels').reachable;
    expect(has(onRoad, 3, 0)).toBe(true); // three road tiles, 1 each
    expect(has(onRoad, 4, 0)).toBe(false); // a fourth would be 4

    // The same three points buy one tile of forest and no more.
    expect(has(onRoad, 0, 1)).toBe(true); // one forest tile costs 3
    // Cheapest to (1,1) is road to (1,0) then down into forest: 1 + 3 = 4.
    expect(has(onRoad, 1, 1)).toBe(false);
  });

  it('refuses terrain its movement type cannot enter at all', () => {
    // A wall of hills across the middle: foot may cross it, wheels may not.
    const state = makeState(['...', '^^^', '...'], [{ id: 'b1', col: 1, row: 0 }]);
    expect(has(explore(state, 'b1', 4, 'foot').reachable, 1, 2)).toBe(true);
    expect(has(explore(state, 'b1', 4, 'wheels').reachable, 1, 2)).toBe(false);
    expect(has(explore(state, 'b1', 4, 'wheels').reachable, 1, 1)).toBe(false);
  });

  // Expensive and impassable are different answers, and hills are where that
  // difference is tuned. Written against cavalry's real range, because what
  // decides anything is the ratio of the climb to the budget.
  it('lets a horse onto hills, but only from close by', () => {
    // ⚠️ Cavalry's real budget and the climb's real price, read rather than
    // written: a literal here once drifted from the catalog and was being read
    // as the thing under test. Both are dials; what this holds is that the
    // search spends them exactly.
    const HORSE_RANGE = getUnitType('cavalry').movementRange;
    const CLIMB = TERRAIN.hills.cost.horse;
    if (CLIMB === null) throw new Error('hills have become impassable to horse');
    // One peak on an open row, approached from the west end. Only its distance
    // changes between the cases.
    const climbs = (approach: number) => {
      const row = `${'.'.repeat(approach + 1)}^.`;
      const state = makeState([row], [{ id: 'b1', col: 0, row: 0 }]);
      return has(explore(state, 'b1', HORSE_RANGE, 'horse').reachable, approach + 1, 0);
    };

    for (let approach = 0; approach <= HORSE_RANGE; approach++) {
      expect(climbs(approach)).toBe(approach + CLIMB <= HORSE_RANGE);
    }

    // Wheels are still refused outright, at any distance and any budget --
    // costly and impassable did not collapse into the same thing.
    const beside = makeState(['.^..'], [{ id: 'b1', col: 0, row: 0 }]);
    expect(has(explore(beside, 'b1', 99, 'wheels').reachable, 1, 0)).toBe(false);
  });

  // ⚠️ **A river is a toll for horse and a wall only for wheels**, which is a
  // change from when it was a wall for both. Written against cavalry's real
  // budget and the ford's real price, because what decides anything is the
  // ratio of the one to the other.
  it('lets a horse ford a river, at most of a turn', () => {
    const HORSE_RANGE = getUnitType('cavalry').movementRange;
    const FORD = TERRAIN.river.cost.horse;
    if (FORD === null) throw new Error('rivers have become impassable to horse');
    const crosses = (approach: number) => {
      const row = `${'.'.repeat(approach + 1)}~.`;
      const state = makeState([row], [{ id: 'b1', col: 0, row: 0 }]);
      return has(explore(state, 'b1', HORSE_RANGE, 'horse').reachable, approach + 1, 0);
    };

    for (let approach = 0; approach <= HORSE_RANGE; approach++) {
      expect(crosses(approach)).toBe(approach + FORD <= HORSE_RANGE);
    }

    // ⚠️ And a second tile of water is out of reach from dry land, which is what
    // makes a wide river take two turns and leave a unit standing in it.
    const wide = makeState(['.~~.'], [{ id: 'b1', col: 0, row: 0 }]);
    const reach = explore(wide, 'b1', HORSE_RANGE, 'horse').reachable;
    expect(has(reach, 1, 0)).toBe(FORD <= HORSE_RANGE); // the near bank of the ford
    expect(has(reach, 2, 0)).toBe(2 * FORD <= HORSE_RANGE); // two fords in one turn

    // Wheels stay refused outright -- costly and impassable did not collapse.
    expect(has(explore(wide, 'b1', 99, 'wheels').reachable, 1, 0)).toBe(false);
  });

  // ⚠️ **Sea is a wall for everyone**, where a river is a toll for some -- so
  // a strait one tile wide parts a board that the same river would not.
  it('lets nothing onto the sea, however narrow the strait', () => {
    const strait = makeState(['.w.'], [{ id: 'b1', col: 0, row: 0 }]);
    for (const movementType of Object.keys(getTerrain('sea').cost) as MovementType[]) {
      const reach = explore(strait, 'b1', 99, movementType).reachable;
      expect(`${movementType}: ${has(reach, 1, 0) || has(reach, 2, 0)}`).toBe(
        `${movementType}: false`,
      );
    }
  });

  it('takes the cheap way round rather than the short way through', () => {
    // Two forests sit between the unit and its target on the top row. For
    // wheels the direct line costs 3+3+1 = 7 across three steps; the road
    // below costs 1 five times.
    //
    // The budget is 7 on purpose, so *both* routes are affordable and the
    // search has to actually prefer the cheaper one. An earlier version used
    // 5, which put the direct line out of reach -- the test could only fail
    // by finding no route at all, never by picking the expensive one, which
    // is the thing its name claims to check.
    const state = makeState(['-ff-', '----'], [{ id: 'b1', col: 0, row: 0 }]);
    const path = explore(state, 'b1', 7, 'wheels').pathTo(at(3, 0));
    expect(path).toEqual([at(0, 0), at(0, 1), at(1, 1), at(2, 1), at(3, 1), at(3, 0)]);
  });
});

describe('exploreMovement: pathTo', () => {
  it('returns a step-by-step route to a reachable tile', () => {
    const state = makeState(5, [{ id: 'b1', col: 0, row: 0 }]);
    const path = explore(state, 'b1', 3).pathTo(at(2, 0));
    expect(path).toEqual([at(0, 0), at(1, 0), at(2, 0)]);
  });

  it('starts where the unit is and ends where it was asked', () => {
    const state = makeState(5, [{ id: 'b1', col: 1, row: 1 }]);
    const path = explore(state, 'b1', 3).pathTo(at(2, 2));
    expect(path?.[0]).toEqual(at(1, 1));
    expect(path?.[path.length - 1]).toEqual(at(2, 2));
  });

  it('is a single tile for the unit its own position -- the wait-in-place shape', () => {
    const state = makeState(5, [{ id: 'b1', col: 2, row: 2 }]);
    expect(explore(state, 'b1', 3).pathTo(at(2, 2))).toEqual([at(2, 2)]);
  });

  it('is null for a tile the search never settled', () => {
    const state = makeState(9, [{ id: 'b1', col: 0, row: 0 }]);
    expect(explore(state, 'b1', 2).pathTo(at(8, 8))).toBeNull();
  });

  // The distinction the search is easiest to get wrong: a friendly unit's
  // tile is settled but not reachable, and a route to the tile *beyond* it
  // has to run through it. Filtering the map rather than the output would
  // make this unfindable.
  it('routes through a friendly unit to reach the tile behind it', () => {
    const state = makeState({ cols: 1, rows: 3 }, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 0, row: 1 },
    ]);
    const movement = explore(state, 'b1', 3);
    expect(has(movement.reachable, 0, 1)).toBe(false); // cannot stop on b2
    expect(movement.pathTo(at(0, 2))).toEqual([at(0, 0), at(0, 1), at(0, 2)]);
  });

  it('never returns a route longer than the budget allows', () => {
    const state = makeState(9, [{ id: 'b1', col: 4, row: 4 }]);
    const movement = explore(state, 'b1', 2);
    // Without this the loop body is skipped entirely if `reachable` ever
    // regresses to empty, and the test passes by having asserted nothing.
    expect(movement.reachable).toHaveLength(12);
    for (const tile of movement.reachable) {
      // On plains, foot pays 1 a tile, so steps and cost coincide here.
      expect(movement.pathTo(tile)!.length - 1).toBeLessThanOrEqual(2);
    }
  });
});

// The server checks the route it was told rather than deriving one, so this
// is the enforcement half of movement. Its reasons are diagnostics -- a
// client picking destinations from `reachable` and paths from `pathTo`
// cannot trip them.
describe('validatePath', () => {
  // ⚠️ Contact is checked on the walk as it is in the search: a route may end in
  // contact, and may not pass through it.
  it('refuses a route through a tile in contact with the enemy', () => {
    const state = makeState({ cols: 7, rows: 5 }, [
      { id: 'b1', col: 0, row: 2 },
      { id: 'r1', col: 3, row: 2, owner: 'red' },
    ]);
    const through = [at(0, 2), at(1, 2), at(2, 2), at(2, 3)];
    expect(validatePath(state, unitAt(state, 'b1'), through, 6, 'foot')).toMatch(/contact/);
    expect(validatePath(state, unitAt(state, 'b1'), through.slice(0, 3), 6, 'foot')).toBeNull();
  });

  const board = (map: Parameters<typeof makeState>[0], units: UnitSpec[]) => {
    const state = makeState(map, units);
    return (path: Coordinate[], range = 3, type: MovementType = 'foot') =>
      validatePath(state, unitAt(state, 'b1'), path, range, type);
  };

  it('accepts a walkable route within budget', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk(route(at(0, 0), at(2, 0)))).toBeNull();
  });

  it('accepts standing still -- one tile, no cost', () => {
    const walk = board(5, [{ id: 'b1', col: 2, row: 2 }]);
    expect(walk([at(2, 2)])).toBeNull();
  });

  it('refuses an empty path', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk([])).toBe('path is empty');
  });

  it('refuses a path that starts somewhere else', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk(route(at(1, 1), at(1, 2)))).toBe('path does not start at the unit');
  });

  it('refuses a jump between non-adjacent tiles', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk([at(0, 0), at(0, 2)])).toMatch(/jumps from \(0,0\) to \(0,2\)/);
  });

  it('refuses a diagonal step, which is a jump by another name', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk([at(0, 0), at(1, 1)])).toMatch(/jumps/);
  });

  it('refuses a path that doubles back over itself', () => {
    const walk = board(5, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk([at(0, 0), at(1, 0), at(0, 0)])).toMatch(/revisits \(0,0\)/);
  });

  it('refuses a route that costs more than the budget', () => {
    const walk = board(9, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk(route(at(0, 0), at(4, 0)))).toBe('move exceeds movement range');
  });

  // The same terrain table the search spends -- entryCost decides both.
  it('refuses terrain this movement type cannot cross', () => {
    const walk = board(['.^.', '...'], [{ id: 'b1', col: 1, row: 1 }]);
    expect(walk([at(1, 1), at(1, 0)], 4, 'wheels')).toBe('wheels cannot cross hills');
    expect(walk([at(1, 1), at(1, 0)], 4, 'foot')).toBeNull();
  });

  it('charges terrain rather than one point per tile', () => {
    // Three forest tiles cost a horse 6, well over a budget of 4.
    const walk = board(['ffff'], [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk(route(at(0, 0), at(3, 0)), 4, 'horse')).toBe('move exceeds movement range');
    expect(walk(route(at(0, 0), at(2, 0)), 4, 'horse')).toBeNull();
  });

  it('refuses walking into an enemy', () => {
    const walk = board(5, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 1, row: 0, owner: 'red' },
    ]);
    expect(walk(route(at(0, 0), at(1, 0)))).toMatch(/\(1,0\) is held by an enemy/);
  });

  it('walks through a friend but refuses to stop on one', () => {
    const walk = board({ cols: 1, rows: 3 }, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 0, row: 1 },
    ]);
    expect(walk(route(at(0, 0), at(0, 2)))).toBeNull(); // through
    expect(walk(route(at(0, 0), at(0, 1)))).toMatch(/\(0,1\) is occupied/); // onto
  });

  it('refuses a path that leaves the board', () => {
    const walk = board(3, [{ id: 'b1', col: 0, row: 0 }]);
    expect(walk([at(0, 0), at(-1, 0)])).toMatch(/\(-1,0\) is off the board/);
  });

  // The two halves have to agree, or the overlay offers moves the server
  // refuses. They share entryCost precisely so this cannot drift.
  it('accepts every route pathTo builds to a reachable tile', () => {
    const state = makeState(['..f.', '.^..', '....'], [{ id: 'b1', col: 0, row: 0 }]);
    const unit = unitAt(state, 'b1');
    const movement = exploreMovement(state, unit, 4, 'foot');
    expect(movement.reachable.length).toBeGreaterThan(0);
    for (const tile of movement.reachable) {
      expect(validatePath(state, unit, movement.pathTo(tile)!, 4, 'foot')).toBeNull();
    }
  });
});
