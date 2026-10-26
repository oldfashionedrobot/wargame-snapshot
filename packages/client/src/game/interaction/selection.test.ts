import { describe, expect, it } from 'vitest';
import { at, fullMeter, makeState, route, unitAt } from '@wargame/shared/testing';
import { chargeChance, getUnitType, LUCK_MAX, tilesInRange, UNIT_TYPE_IDS } from '@wargame/shared';
import type { Coordinate, GameState } from '@wargame/shared';
import {
  attackForecast,
  availableActions,
  canCharge,
  canAttack,
  enterMode,
  chooseTarget,
  clearStep,
  confirmRoute,
  facingForTarget,
  isTargetPinned,
  isAttacking,
  isPlan,
  readAimClick,
  readHoldClick,
  facingChoiceAt,
  destinationOf,
  handleTileClick,
  initialSelectionState,
  moveCommandFor,
  openInPlace,
  unpinDestination,
  holdFacing,
} from './selection';
import type {
  Attacking,
  TargetPinned,
  DestinationChosen,
  RoutePinned,
  SelectionState,
} from './selection';

// The pure half of the client: state and a coordinate in, a new selection out.
// No React, no Babylon, no server. `handleTileClick` never produces a command
// -- it picks a destination -- so committing is `moveCommandFor` and abandoning
// is
// `unpinDestination`, both driven by the menu.
//
// Blue to move. b1 is free, b2 has already acted, r1 belongs to the opponent.
const board = (): GameState =>
  makeState(7, [
    { id: 'b1', col: 1, row: 1 },
    { id: 'b2', col: 5, row: 5, hasActed: true },
    { id: 'r1', col: 6, row: 6, owner: 'red' },
  ]);

/** Select b1 and hand back the resulting selection, since most cases start there. */
const withB1Selected = (state: GameState): SelectionState =>
  handleTileClick(state, initialSelectionState, at(1, 1), true);

/** Select b1, then pin a route to `destination`. Nothing has walked yet. */
function withB1Pinned(state: GameState, destination: Coordinate): RoutePinned {
  const pinned = handleTileClick(state, withB1Selected(state), destination, true);
  if (pinned.phase !== 'routePinned') throw new Error('expected a pinned route');
  return pinned;
}

/** Pin a route and confirm it: the unit has walked and the panel is up. */
const withB1Arrived = (state: GameState, destination: Coordinate): DestinationChosen =>
  confirmRoute(withB1Pinned(state, destination));

/** …and then pick Attack from the panel, which is what lights the band. */
function withB1Attacking(state: GameState, destination: Coordinate): Attacking {
  const attacking = enterMode(state, withB1Arrived(state, destination), 'attacking');
  if (!isAttacking(attacking)) throw new Error('expected attacking mode');
  return attacking;
}

/** …or pick Charge, which lights the neighbours it could actually charge. */
function withB1Charging(state: GameState, destination: Coordinate): Attacking {
  const charging = enterMode(state, withB1Arrived(state, destination), 'charging');
  if (!isAttacking(charging)) throw new Error('expected charging mode');
  return charging;
}

/** …and then pick Hold, which is what lights the four beside it. */
const withB1Holding = (state: GameState, destination: Coordinate): DestinationChosen =>
  enterMode(state, withB1Arrived(state, destination), 'holding');

/** …or pick Attack and pin a target, so the forecast is up. */
function withB1Targeting(
  state: GameState,
  destination: Coordinate,
  targetId: string,
): TargetPinned {
  const aiming = chooseTarget(withB1Attacking(state, destination), unitAt(state, targetId));
  if (!isTargetPinned(aiming)) throw new Error('expected a pinned target');
  return aiming;
}

// ⚠️ In a remote game the player to move is the opponent, and `canSelectUnit`
// would hand this client their units to order, for the server to refuse.
describe('handleTileClick, off your turn', () => {
  it('inspects every unit, a unit that could act included', () => {
    const selection = handleTileClick(board(), initialSelectionState, at(1, 1), false);
    expect(selection).toMatchObject({ phase: 'inspecting', unitId: 'b1' });
  });

  it('lets go of a selection left from the turn before', () => {
    const state = board();
    expect(handleTileClick(state, withB1Selected(state), at(3, 1), false)).toEqual(
      initialSelectionState,
    );
  });
});

describe('handleTileClick, nothing selected', () => {
  it('selects a unit that can act, snapshotting its position and range', () => {
    const state = board();
    const selection = handleTileClick(state, initialSelectionState, at(1, 1), true);
    expect(selection.phase).toBe('unitSelected');
    if (selection.phase !== 'unitSelected') return;
    expect(selection.unitId).toBe('b1');
    expect(selection.position).toEqual(at(1, 1));
    // Open ground, so the range is every tile within the catalog's budget in
    // orthogonal steps, minus the unit's own: a diamond, clipped by the two
    // edges the unit stands near. Counted here rather than searched for.
    const range = getUnitType('infantry').movementRange;
    let diamond = 0;
    state.grid.forEach((cells, row) =>
      cells.forEach((_, col) => {
        const steps = Math.abs(col - 1) + Math.abs(row - 1);
        if (steps > 0 && steps <= range) diamond++;
      }),
    );
    expect(selection.movement.reachable).toHaveLength(diamond);
  });

  // Nothing else in the client pins that movement stats come from the catalog
  // per unit type -- every other fixture is infantry, so one hardcoded budget
  // would pass the whole suite. ⚠️ Every type against its own row, read rather
  // than written: a literal that drifts turns this into a test of some unit
  // that does not exist.
  it("reads each unit type's own movement range from the catalog", () => {
    for (const unitTypeId of UNIT_TYPE_IDS) {
      const range = getUnitType(unitTypeId).movementRange;
      // Road, which every movement type crosses at a tile a point, so the
      // budget is the distance.
      const road = Array.from({ length: range + 2 }, () => '--');
      const state = makeState(road, [{ id: 'u', col: 0, row: 0, unitTypeId }]);
      const selection = handleTileClick(state, initialSelectionState, at(0, 0), true);
      if (selection.phase !== 'unitSelected') throw new Error(`${unitTypeId} did not select`);
      expect(selection.movement.pathTo(at(0, range))).not.toBeNull();
      expect(selection.movement.pathTo(at(0, range + 1))).toBeNull();
    }
  });

  it('ignores an empty tile', () => {
    const selection = handleTileClick(board(), initialSelectionState, at(3, 3), true);
    expect(selection).toEqual(initialSelectionState);
  });

  it('inspects an enemy unit, lighting the band it could fire into from where it stands', () => {
    const state = board();
    const selection = handleTileClick(state, initialSelectionState, at(6, 6), true);
    expect(selection).toMatchObject({
      phase: 'inspecting',
      unitId: 'r1',
      position: at(6, 6),
      view: 'attack',
    });
    if (selection.phase !== 'inspecting') return;
    expect(selection.tiles).toEqual(tilesInRange(unitAt(state, 'r1'), at(6, 6), 7, 7));
  });

  // Selection is a preview of a game rule, not a UI whim -- canSelectUnit is
  // the same predicate the server enforces, so what it refuses is inspected.
  it('inspects an own unit that has already acted rather than selecting it', () => {
    const selection = handleTileClick(board(), initialSelectionState, at(5, 5), true);
    expect(selection).toMatchObject({ phase: 'inspecting', unitId: 'b2', view: 'attack' });
  });
});

describe('inspecting a unit', () => {
  // Blue to move. r1 is an enemy horseman, r2 an enemy footman, b2 a blue unit
  // that has acted.
  const board9 = (): GameState =>
    makeState(9, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'b2', col: 7, row: 1, hasActed: true },
      { id: 'r1', col: 4, row: 6, owner: 'red', unitTypeId: 'cavalry' },
      { id: 'r2', col: 7, row: 7, owner: 'red' },
    ]);
  const inspectR1 = (state: GameState) =>
    handleTileClick(state, initialSelectionState, at(4, 6), true);

  it('shows the movement range on a second click, the one it shows when selected', () => {
    const state = board9();
    const second = handleTileClick(state, inspectR1(state), at(4, 6), true);
    const selected = handleTileClick(
      { ...state, currentTurn: 'red' },
      initialSelectionState,
      at(4, 6),
      true,
    );
    if (second.phase !== 'inspecting' || selected.phase !== 'unitSelected') throw new Error();
    expect(second.view).toBe('movement');
    expect(second.tiles).toEqual(selected.movement.settled);
  });

  it('clears on a third click', () => {
    const state = board9();
    const second = handleTileClick(state, inspectR1(state), at(4, 6), true);
    expect(handleTileClick(state, second, at(4, 6), true)).toEqual(initialSelectionState);
  });

  it('clears on a click elsewhere', () => {
    const state = board9();
    expect(handleTileClick(state, inspectR1(state), at(0, 8), true)).toEqual(initialSelectionState);
  });

  it('inspects another unit that cannot act, or selects one that can', () => {
    const state = board9();
    expect(handleTileClick(state, inspectR1(state), at(7, 7), true)).toMatchObject({
      phase: 'inspecting',
      unitId: 'r2',
      view: 'attack',
    });
    expect(handleTileClick(state, inspectR1(state), at(1, 1), true)).toMatchObject({
      phase: 'unitSelected',
      unitId: 'b1',
    });
  });

  it('inspects an enemy clicked while a unit is selected or a route pinned', () => {
    const state = board9();
    for (const selection of [withB1Selected(state), withB1Pinned(state, at(1, 2))]) {
      expect(handleTileClick(state, selection, at(4, 6), true)).toMatchObject({
        phase: 'inspecting',
        unitId: 'r1',
      });
    }
  });

  // The enemy's search on blue's turn: it passes its own side's units and
  // stops at the other's, whoever is to move.
  it('runs the search for the unit’s owner, not the player to move', () => {
    const state = makeState(7, [
      { id: 'r1', col: 0, row: 0, owner: 'red', unitTypeId: 'cavalry' },
      { id: 'r3', col: 1, row: 0, owner: 'red' },
      { id: 'b1', col: 0, row: 2 },
    ]);
    const first = handleTileClick(state, initialSelectionState, at(0, 0), true);
    const second = handleTileClick(state, first, at(0, 0), true);
    if (second.phase !== 'inspecting') throw new Error();
    expect(second.tiles).toContainEqual(at(2, 0));
    expect(second.tiles).not.toContainEqual(at(0, 2));
  });

  it('lights a gun’s band without the tiles too near it to fire on', () => {
    const state = makeState(9, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 4, row: 4, owner: 'red', unitTypeId: 'artillery' },
    ]);
    const selection = handleTileClick(state, initialSelectionState, at(4, 4), true);
    if (selection.phase !== 'inspecting') throw new Error();
    expect(selection.tiles).not.toContainEqual(at(4, 5));
    expect(selection.tiles).toContainEqual(at(4, 7));
  });

  it('shows a unit in contact walking out of it', () => {
    const state = makeState(9, [
      { id: 'b1', col: 4, row: 3 },
      { id: 'r1', col: 4, row: 4, owner: 'red' },
    ]);
    const first = handleTileClick(state, initialSelectionState, at(4, 4), true);
    const second = handleTileClick(state, first, at(4, 4), true);
    if (second.phase !== 'inspecting') throw new Error();
    expect(second.tiles).toContainEqual(at(4, 6));
  });

  it('falls through to a fresh click once the inspected unit has gone', () => {
    const state = board9();
    const gone = { ...state, units: state.units.filter((unit) => unit.id !== 'r1') };
    expect(handleTileClick(gone, inspectR1(state), at(4, 6), true)).toEqual(initialSelectionState);
  });
});

describe('handleTileClick, a unit selected', () => {
  it('pins a route to a reachable tile rather than walking it', () => {
    const state = board();
    const pinned = withB1Pinned(state, at(1, 3));
    expect(pinned.path).toEqual(route(at(1, 1), at(1, 3)));
    // The unit has not moved and nothing has been sent -- path[0] is still
    // where it stands, which is what Cancel restores it to.
    expect(pinned.path[0]).toEqual(at(1, 1));
  });

  // AW's answer to "how do you act without moving": the unit's own tile is a
  // destination like any other, so no gesture of its own is needed.
  it('pins in place when the selected unit is clicked again', () => {
    const state = board();
    const pinned = withB1Pinned(state, at(1, 1));
    expect(pinned.path).toEqual([at(1, 1)]);
  });

  it('clears the selection on an unreachable empty tile, without a command', () => {
    const state = board();
    const selection = handleTileClick(state, withB1Selected(state), at(6, 1), true);
    expect(selection).toEqual(initialSelectionState);
  });

  // b3 is five tiles away, well outside infantry's range of 3, so this is the
  // out-of-range case: a click that is neither a move nor a deselect still
  // finds a selectable unit. The in-range case -- where the friendly-occupancy
  // rule is what stops it being a move -- is the test below.
  it('selects another of your units even when it is out of range', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'b3', col: 6, row: 1 },
    ]);
    const selection = handleTileClick(state, withB1Selected(state), at(6, 1), true);
    expect(selection).toMatchObject({ phase: 'unitSelected', unitId: 'b3' });
  });

  // A friendly unit is pass-through but not a stopping point, so its tile is
  // never in reachableTiles -- clicking it must reselect, never move.
  it('reselects rather than moving when a friendly unit stands in range', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'b3', col: 1, row: 2 },
    ]);
    const selection = handleTileClick(state, withB1Selected(state), at(1, 2), true);
    expect(selection).toMatchObject({ phase: 'unitSelected', unitId: 'b3' });
  });

  it('does not offer a move onto an enemy, inspecting it instead', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);
    const selection = handleTileClick(state, withB1Selected(state), at(1, 2), true);
    expect(selection).toMatchObject({ phase: 'inspecting', unitId: 'r1' });
  });

  it('recovers if the selected unit has vanished from state', () => {
    const state = board();
    const stale = withB1Selected(state);
    const without: GameState = { ...state, units: state.units.filter((u) => u.id !== 'b1') };
    const selection = handleTileClick(without, stale, at(3, 3), true);
    expect(selection).toEqual(initialSelectionState);
  });
});

// ⚠️ A pinned route is still being chosen, so unlike the phases after the walk
// it keeps answering tile clicks as *tile* clicks. That is what makes the second click a confirm
// rather than a commit: nothing has moved, and every reachable tile is live.
describe('openInPlace', () => {
  const adjacent = (): GameState =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);

  it('opens the panel where a freshly selected unit stands when it could attack', () => {
    const state = adjacent();
    expect(openInPlace(state, withB1Selected(state))).toMatchObject({
      phase: 'destinationChosen',
      unitId: 'b1',
      path: [at(1, 1)],
      step: { kind: 'choosing' },
    });
  });

  it('leaves the movement selection when the panel would offer only Hold', () => {
    const state = board();
    const selected = withB1Selected(state);
    expect(openInPlace(state, selected)).toBe(selected);
  });

  it('passes through anything but a unit just selected', () => {
    const state = adjacent();
    const pinned = withB1Pinned(state, at(2, 1));
    const inspected = handleTileClick(state, initialSelectionState, at(1, 2), true);
    expect(openInPlace(state, initialSelectionState)).toBe(initialSelectionState);
    expect(openInPlace(state, pinned)).toBe(pinned);
    expect(openInPlace(state, inspected)).toBe(inspected);
  });
});

describe('a route pinned', () => {
  it('re-pins to another reachable tile', () => {
    const state = board();
    const repinned = handleTileClick(state, withB1Pinned(state, at(1, 3)), at(3, 1), true);
    expect(repinned).toMatchObject({ phase: 'routePinned', unitId: 'b1' });
    if (repinned.phase !== 'routePinned') return;
    expect(repinned.path.at(-1)).toEqual(at(3, 1));
    expect(repinned.path[0]).toEqual(at(1, 1)); // still where it really stands
  });

  // Re-pinning runs the same code that pinned it, so the snapshot taken at
  // selection is carried rather than a fresh search being run per click.
  it('carries the original search rather than re-exploring', () => {
    const state = board();
    const pinned = withB1Pinned(state, at(1, 3));
    const repinned = handleTileClick(state, pinned, at(3, 1), true);
    if (repinned.phase !== 'routePinned') throw new Error('expected a pinned route');
    expect(repinned.movement).toBe(pinned.movement);
  });

  it('re-pins onto the unit itself, which is standing still', () => {
    const state = board();
    const staying = handleTileClick(state, withB1Pinned(state, at(1, 3)), at(1, 1), true);
    expect(staying).toMatchObject({ phase: 'routePinned' });
    if (staying.phase !== 'routePinned') return;
    expect(staying.path).toEqual([at(1, 1)]);
  });

  it('cancels on a tile outside the range, without a command', () => {
    const state = board();
    expect(handleTileClick(state, withB1Pinned(state, at(1, 3)), at(6, 1), true)).toEqual(
      initialSelectionState,
    );
  });

  it('unpins to the unit selected where it still stands', () => {
    const state = board();
    const pinned = withB1Pinned(state, at(1, 3));
    const back = unpinDestination(pinned);
    expect(back).toMatchObject({ phase: 'unitSelected', unitId: 'b1', position: at(1, 1) });
    if (back.phase !== 'unitSelected') return;
    expect(back.movement).toBe(pinned.movement); // the same snapshot, not a new search
  });
});

describe('a destination arrived at', () => {
  it('ignores tile clicks, returning the very same selection', () => {
    const state = board();
    const arrived = withB1Arrived(state, at(1, 3));
    // Identity, not equality: the menu owns the decision, and a re-render for
    // a click that changes nothing is waste React can see.
    expect(handleTileClick(state, arrived, at(2, 2), true)).toBe(arrived);
    expect(handleTileClick(state, arrived, at(1, 1), true)).toBe(arrived);
  });

  it('lights the four directions around the destination, not the origin', () => {
    expect(destinationOf(withB1Arrived(board(), at(1, 3)))).toEqual(at(1, 3));
  });

  // Confirming carries the plan across untouched -- only the phase moves, so
  // the path the command is built from cannot drift at the handover.
  it('keeps the path and the search when the route is confirmed', () => {
    const state = board();
    const pinned = withB1Pinned(state, at(1, 3));
    const arrived = confirmRoute(pinned);
    expect(arrived.path).toBe(pinned.path);
    expect(arrived.movement).toBe(pinned.movement);
  });

  // Cancel goes back to a selected unit rather than to idle, so the next click
  // picks a different destination instead of re-selecting.
  it('unpins to the unit selected where it still stands', () => {
    const state = board();
    const back = unpinDestination(withB1Arrived(state, at(1, 3)));
    expect(back).toMatchObject({ phase: 'unitSelected', unitId: 'b1', position: at(1, 1) });
  });
});

describe('choosing a facing', () => {
  const choosing = (destination: Coordinate): DestinationChosen =>
    withB1Arrived(board(), destination);

  it('reads a click on an adjacent tile as that direction', () => {
    const facing = choosing(at(1, 3));
    expect(facingChoiceAt(facing, at(1, 4))).toBe('north');
    expect(facingChoiceAt(facing, at(1, 2))).toBe('south');
    expect(facingChoiceAt(facing, at(2, 3))).toBe('east');
    expect(facingChoiceAt(facing, at(0, 3))).toBe('west');
  });

  it('ignores a click that is not one orthogonal step away', () => {
    const facing = choosing(at(1, 3));
    expect(facingChoiceAt(facing, at(2, 4))).toBeNull(); // diagonal
    expect(facingChoiceAt(facing, at(1, 5))).toBeNull(); // two away
  });

  // ⚠️ The destination answers null here rather than a direction, and that is
  // what lets the caller tell "keep travelling" from "face this way" without
  // ordering the two by hand. `holdFacing` is what answers it instead.
  it('answers null for the destination itself, which holdFacing covers', () => {
    const state = board();
    const facing = choosing(at(1, 3));
    expect(facingChoiceAt(facing, at(1, 3))).toBeNull();
    expect(holdFacing(state, facing)).toBe('north'); // b1 walked 1,1 -> 1,3
  });

  // Acting without moving has no last step to read a direction off, so the
  // unit keeps the facing it already had.
  it('keeps the current facing when the path never left the tile', () => {
    const state = board();
    const staying = withB1Arrived(state, at(1, 1));
    expect(staying.path).toEqual([at(1, 1)]);
    expect(holdFacing(state, staying)).toBe(unitAt(state, 'b1').facing);
  });

  it('still ignores tile clicks as far as the selection goes', () => {
    const facing = choosing(at(1, 3));
    // The direction is read by facingChoiceAt; handleTileClick must not also
    // reselect or clear on the same click.
    expect(handleTileClick(board(), facing, at(1, 4), true)).toBe(facing);
    expect(handleTileClick(board(), facing, at(5, 5), true)).toBe(facing);
  });

  it('commits the pinned path with the direction the player chose', () => {
    const facing = choosing(at(1, 3));
    expect(moveCommandFor(facing, 'west')).toEqual({
      type: 'move',
      unitId: 'b1',
      path: route(at(1, 1), at(1, 3)),
      facing: 'west',
    });
  });

  it('cancels back to the unit where it really stands', () => {
    const back = unpinDestination(choosing(at(1, 3)));
    expect(back).toMatchObject({ phase: 'unitSelected', unitId: 'b1', position: at(1, 1) });
  });
});

// ⚠️ **The collision these used to be about cannot happen any more.** One
// reader answered "target or facing?" because an adjacent enemy is both, and
// only its call order separated them. The panel asks for the intent first, so
// each mode has exactly one kind of tile and there is no order left to pin.
// What is worth testing instead is that the *mode* decides -- the same tile,
// read two ways, chosen by the player rather than guessed.
describe('a lit tile means what the mode says', () => {
  // b1 infantry at (1,1), range 1..2. An enemy sits beside it and another two
  // tiles off; a friend sits beside it too.
  const field = () =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'friend', col: 1, row: 2 },
      { id: 'adjacent', col: 2, row: 1, owner: 'red' },
      { id: 'distant', col: 3, row: 1, owner: 'red' },
      { id: 'far', col: 5, row: 5, owner: 'red' },
    ]);

  // ⚠️ The pair that is the whole design. (2,1) holds an adjacent enemy, so it
  // is simultaneously a target and a direction to face. Under one reader that
  // was a bug waiting on call order; here the answer is whichever the player
  // asked for, and neither reading can leak into the other's mode.
  it('reads an adjacent enemy as a target in attacking mode', () => {
    const state = field();
    expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(2, 1))?.id).toBe('adjacent');
  });

  it('reads that same tile as a facing in holding mode', () => {
    const state = field();
    expect(readHoldClick(state, withB1Holding(state, at(1, 1)), at(2, 1))).toBe('east');
  });

  describe('attacking', () => {
    it('reads an enemy further off but still in range as a target', () => {
      const state = field();
      expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(3, 1))?.id).toBe('distant');
    });

    it('reads an enemy out of range as nothing', () => {
      const state = field();
      expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(5, 5))).toBeNull();
    });

    it('reads a friend as nothing, however close', () => {
      const state = field();
      expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(1, 2))).toBeNull();
    });

    it('reads empty ground as nothing', () => {
      const state = field();
      expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(0, 1))).toBeNull();
    });

    // Artillery cannot hit what has reached it: the band, not adjacency, is
    // what decides, and it is the server's own `refuseAttack` that says so.
    it('reads an adjacent enemy as nothing when the unit cannot shoot that close', () => {
      const gunline = makeState(7, [
        { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
        { id: 'adjacent', col: 2, row: 1, owner: 'red' },
      ]);
      expect(readAimClick(gunline, withB1Attacking(gunline, at(1, 1)), at(2, 1))).toBeNull();
    });
  });

  describe('holding', () => {
    it('reads the unit’s own tile as keeping the facing it has', () => {
      const state = field();
      expect(readHoldClick(state, withB1Holding(state, at(1, 1)), at(1, 1))).toBe(
        unitAt(state, 'b1').facing,
      );
    });

    it('reads a tile beside it as facing that way', () => {
      const state = field();
      expect(readHoldClick(state, withB1Holding(state, at(1, 1)), at(0, 1))).toBe('west');
    });

    // Occupancy does not enter into it: a neighbour with someone standing on it
    // is still a direction, which is exactly what attacking mode disagrees about.
    it('does not care what is standing on the tile', () => {
      const state = field();
      expect(readHoldClick(state, withB1Holding(state, at(1, 1)), at(1, 2))).toBe('north');
    });

    it('reads anything further away as nothing', () => {
      const state = field();
      expect(readHoldClick(state, withB1Holding(state, at(1, 1)), at(4, 4))).toBeNull();
    });
  });
});

describe('the panel, and what it is told', () => {
  /** ⚠️ Narrows and asserts in one: a charge forecast reaching these would
      otherwise read as a missing property rather than the wrong kind. */
  const forecastOf = (state: GameState, selection: TargetPinned) => {
    const forecast = attackForecast(state, selection);
    if (forecast?.kind !== 'attack') throw new Error('expected an attack forecast');
    return forecast;
  };

  // b1 infantry at (1,1); an enemy two north, which infantry can reach.
  // ⚠️ The enemy's facing is stated rather than inherited: b1 attacks from the
  // south, and an attack from directly behind is never answered, so leaving it
  // to the fixture default would make "they counter attack" depend on something
  // these tests do not mention.
  const field = () =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 3, owner: 'red', facing: 'south' },
    ]);
  const panel = (state: GameState) => withB1Targeting(state, at(1, 1), 'r1');

  // ⚠️ An exact range, not an estimate: damage only rises with the roll, so the
  // zero-roll result is the floor. A full-strength attacker onto ground with no
  // cover is the one case where nothing scales luck, so there the width is
  // exactly LUCK_MAX -- hence road under the target, where `field()` has plains.
  it('forecasts a range whose width is the luck band', () => {
    const row = '.......';
    const state = makeState(
      [row, row, row, '.-.....', row, row, row],
      [
        { id: 'b1', col: 1, row: 1 },
        { id: 'r1', col: 1, row: 3, owner: 'red', facing: 'south' },
      ],
    );
    const forecast = forecastOf(state, panel(state));
    expect(forecast.high - forecast.low).toBe(LUCK_MAX);
    expect(forecast.low).toBeGreaterThan(0);
  });

  it('says they counter attack when the target can reach back', () => {
    const state = field();
    expect(forecastOf(state, panel(state)).answered).toBe(true);
  });

  // ⚠️ The panel got the rear rule without being edited for it -- it reads
  // `wouldCounter`, which reads facing, so the same shot against a target
  // looking away simply stops promising a counter attack. That is what this asserts:
  // not that the rule is right, which `combat.test.ts` owns, but that the
  // forecast is wired to the rule the server will actually resolve.
  it('says nothing about a counter attack when the target is looking away', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 3, owner: 'red', facing: 'north' },
    ]);
    const chosen = withB1Targeting(state, at(1, 1), 'r1');
    expect(forecastOf(state, chosen).answered).toBe(false);
    // ⚠️ And the damage is untouched: facing changes who may answer, never what
    // the shot does. A flanking bonus would show up right here, and does not --
    // the same shot against the same unit turned around forecasts the same
    // number, which is the assertion that would have to be deleted to add one.
    const head = field();
    expect(forecastOf(state, chosen).low).toBe(forecastOf(head, panel(head)).low);
  });

  // The melee rule arrives by the same wiring: cavalry facing the infantry that
  // shoots it from beside cannot answer, and the panel does not promise it will.
  it('says nothing about a counter attack from cavalry it shot', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red', unitTypeId: 'cavalry', facing: 'south' },
    ]);
    expect(forecastOf(state, withB1Targeting(state, at(1, 1), 'r1')).answered).toBe(false);
  });

  // The whole point of outranging someone: a gun firing from four is never
  // answered, and the panel has to say so before you commit rather than after.
  it('says nothing about a counter attack when the target cannot reach', () => {
    const state = makeState(9, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
      { id: 'r1', col: 1, row: 5, owner: 'red' },
    ]);
    const chosen = withB1Targeting(state, at(1, 1), 'r1');
    expect(forecastOf(state, chosen).answered).toBe(false);
  });

  it('points the unit at its target, however far off it is', () => {
    const state = field();
    expect(facingForTarget(state, panel(state))).toBe('north');

    const diagonal = makeState(9, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
      { id: 'r1', col: 4, row: 2, owner: 'red' },
    ]);
    const chosen = withB1Targeting(diagonal, at(1, 1), 'r1');
    expect(facingForTarget(diagonal, chosen)).toBe('east');
  });

  // ⚠️ Backing out returns to the panel with the unit still standing where it
  // walked -- not to the board. The plan is still a plan, and that is the first
  // of the two back-out rules: dark inside a mode goes up one, dark at the panel
  // un-walks.
  it('backs out to the panel with the walk intact', () => {
    const state = field();
    const back = clearStep(panel(state));
    expect(back.step).toEqual({ kind: 'choosing' });
    expect(back.path).toEqual(panel(state).path);
    expect(isPlan(back)).toBe(true);
  });

  // ⚠️ A different lit enemy re-pins rather than backing out, exactly as a
  // route does -- the gesture is the same one the walk already taught.
  it('re-pins onto another target without leaving attacking mode', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 3, owner: 'red', facing: 'south' },
      { id: 'r2', col: 3, row: 1, owner: 'red', facing: 'south' },
    ]);
    const first = withB1Targeting(state, at(1, 1), 'r1');
    const second = chooseTarget(first, unitAt(state, 'r2'));
    expect(second.step.target.id).toBe('r2');
    expect(second.step.tiles).toEqual(first.step.tiles);
  });

  // ⚠️ **Behaviour, now that the compiler owns the bookkeeping.** `Pinned` is
  // `Extract`ed on carrying a path and the runtime list is asserted complete
  // against it in both directions, so a forgotten phase fails the build rather
  // than this test. What is left for a test is the thing types cannot say: that
  // "carries a path" is the *right* property to mean "uncommitted plan" -- so
  // this walks every phase and says which side it falls on.
  it('counts as an uncommitted plan, like every other phase carrying a path', () => {
    const state = field();
    expect(isPlan(panel(state))).toBe(true);
    expect(isPlan(withB1Pinned(state, at(1, 1)))).toBe(true);
    expect(isPlan(withB1Arrived(state, at(1, 1)))).toBe(true);
    expect(isPlan(initialSelectionState)).toBe(false);
    expect(isPlan(withB1Selected(state))).toBe(false);
    expect(isPlan(handleTileClick(state, initialSelectionState, at(1, 3), true))).toBe(false);
  });
});

describe('the tiles holding mode lights', () => {
  const tilesFor = (state: GameState, at_: Coordinate) => {
    const holding = withB1Holding(state, at_);
    return holding.step.kind === 'holding' ? holding.step.tiles : [];
  };

  it('offers the four tiles around where the unit stopped', () => {
    const state = makeState(7, [{ id: 'b1', col: 1, row: 1 }]);
    expect(tilesFor(state, at(1, 3))).toEqual(
      expect.arrayContaining([at(1, 4), at(1, 2), at(2, 3), at(0, 3)]),
    );
    expect(tilesFor(state, at(1, 3))).toHaveLength(4);
  });

  // ⚠️ Never asserted before, because this lived in the renderer and the
  // renderer has no unit tests at all -- it is WebGL. A facing that points off
  // the board is strictly worse than one that does not, so it is not offered.
  it('clips at the edge, so a unit on the rim has three choices', () => {
    const state = makeState(7, [{ id: 'b1', col: 1, row: 1 }]);
    const edge = tilesFor(state, at(1, 0));
    expect(edge).toHaveLength(3);
    expect(edge).toEqual(expect.arrayContaining([at(1, 1), at(2, 0), at(0, 0)]));
  });

  it('leaves a unit in the corner two', () => {
    const state = makeState(7, [{ id: 'b1', col: 1, row: 1 }]);
    expect(tilesFor(state, at(0, 0))).toHaveLength(2);
  });

  // The set is about the board's shape, not about what is standing on it: an
  // occupied neighbour is still a direction you may face.
  it('does not care what is standing on them', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 4, owner: 'red' },
    ]);
    expect(tilesFor(state, at(1, 3))).toHaveLength(4);
  });
});

describe('charging, which shares every gesture with attacking', () => {
  // b1 cavalry, its meter full, with a worn-down enemy beside it and another two
  // tiles off.
  const field = () =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'adjacent', col: 1, row: 2, owner: 'red', health: 5 },
      { id: 'distant', col: 1, row: 3, owner: 'red', health: 5 },
    ]);

  // ⚠️ **Targets, not reach — the opposite of the attack band, deliberately.**
  // Red means *in range* for a shot because reach is what a shot is planned
  // against. A charge is contact-only, so there is no reach to show and a lit
  // tile that could not be charged would promise nothing.
  it('lights only the neighbours it could actually charge', () => {
    const state = field();
    const tiles = withB1Charging(state, at(1, 1)).step.tiles;
    expect(tiles).toEqual([at(1, 2)]);
  });

  // How strong a neighbour is decides the odds, not whether it lights.
  it('lights a neighbour however strong, not only one it would finish', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'worn', col: 1, row: 2, owner: 'red', health: 5 },
      { id: 'fresh', col: 2, row: 1, owner: 'red' },
    ]);
    expect(withB1Charging(state, at(1, 1)).step.tiles).toEqual([at(1, 2), at(2, 1)]);
  });

  it('lights nothing when no enemy is in contact', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'distant', col: 1, row: 3, owner: 'red', health: 5 },
    ]);
    expect(withB1Charging(state, at(1, 1)).step.tiles).toEqual([]);
  });

  it('reads a lit neighbour as a target', () => {
    const state = field();
    expect(readAimClick(state, withB1Charging(state, at(1, 1)), at(1, 2))?.id).toBe('adjacent');
  });

  // ⚠️ **The same tile, read by two rules.** An enemy two off is a legal shot and
  // an illegal charge, and which answer you get depends on the mode chosen —
  // not on anything the click itself carries.
  //
  // ⚠️ Infantry, not cavalry, and that is the whole reason this fixture differs:
  // **cavalry's range is `{1,1}`**, so for a horseman Attack and Charge light the
  // identical tile and the distinction cannot be seen at all. Infantry reaches
  // two and charges at one.
  it('refuses an enemy the attack band would have accepted', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, chargeMeter: fullMeter('infantry') },
      { id: 'distant', col: 1, row: 3, owner: 'red', health: 5 },
    ]);
    expect(readAimClick(state, withB1Charging(state, at(1, 1)), at(1, 3))).toBeNull();
    expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(1, 3))?.id).toBe('distant');
  });

  it('pins and re-pins exactly as attacking does', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 5 },
      { id: 'r2', col: 2, row: 1, owner: 'red', health: 5 },
    ]);
    const first = chooseTarget(withB1Charging(state, at(1, 1)), unitAt(state, 'r1'));
    expect(isTargetPinned(first)).toBe(true);
    const second = chooseTarget(first, unitAt(state, 'r2'));
    expect(second.step.target.id).toBe('r2');
    expect(second.step.kind).toBe('charging');
  });

  // ⚠️ **The bug a browser found once and the tests had not**: aiming a charge
  // showed an attack's damage, because the forecast never asked which mode it
  // was in. And exact where an attack's is a range: no roll enters the chance,
  // so this is the rule that will resolve it rather than an estimate of it.
  it('forecasts the exact chance once a target is pinned', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);
    const aim = chooseTarget(withB1Charging(state, at(1, 1)), unitAt(state, 'r1'));
    expect(attackForecast(state, aim)).toEqual({
      kind: 'charge',
      chance: chargeChance(state, unitAt(state, 'b1'), unitAt(state, 'r1')),
    });
  });
});

// ⚠️ **The panel has to know the turn rule too**, or it offers Attack to a gun
// that has just repositioned and the click is refused. `canAttack` asks
// `refuseAttack` with the selection's whole *path*, which is what carries
// "did this unit move" — the destination alone cannot say.
describe('canAttack, for a slow unit', () => {
  const gunline = () =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
      { id: 'r1', col: 1, row: 4, owner: 'red' },
    ]);

  it('offers Attack when the gun has not moved', () => {
    const state = gunline();
    expect(canAttack(state, withB1Arrived(state, at(1, 1)))).toBe(true);
  });

  it('withholds it once the gun has moved, even into range', () => {
    const state = gunline();
    const moved = withB1Arrived(state, at(1, 2));
    expect(canAttack(state, moved)).toBe(false);
    // ⚠️ And not because the range failed: the target is two tiles off, which is
    // inside a gun's band — it is the moving that did it.
    expect(availableActions(state, moved)).toEqual(['holding']);
  });
});

describe('canCharge, which decides whether the panel offers it', () => {
  const arrived = (state: GameState) => withB1Arrived(state, at(1, 1));
  // A charger beside a target, its meter full and the target worn down unless a
  // test says otherwise. ⚠️ Artillery has no full meter, so it takes one of its
  // own and is refused for what it is rather than for an empty meter.
  const contact = (
    unitTypeId: 'infantry' | 'cavalry' | 'artillery' = 'cavalry',
    { meter = unitTypeId === 'artillery' ? 1 : fullMeter(unitTypeId), health = 5 } = {},
  ) =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId, chargeMeter: meter },
      { id: 'r1', col: 1, row: 2, owner: 'red', health },
    ]);

  it('is true with an enemy in contact that a charge would break', () => {
    const state = contact();
    expect(canCharge(state, arrived(state))).toBe(true);
  });

  it('is false until the meter is full', () => {
    const state = contact('cavalry', { meter: fullMeter('cavalry') - 1 });
    expect(canCharge(state, arrived(state))).toBe(false);
  });

  it('is true however strong the enemy in contact, since that sets only the odds', () => {
    const state = contact('cavalry', { health: 100 });
    expect(canCharge(state, arrived(state))).toBe(true);
  });

  // ⚠️ The distinction the two rows exist for: the same board offers Attack and
  // not Charge, because infantry shoots two tiles and charges at one. ⚠️ It has
  // to be infantry — **cavalry's range is `{1,1}`**, so a horseman's two rows
  // always appear and disappear together.
  it('is false when the only enemy is a tile too far, where Attack is true', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, chargeMeter: fullMeter('infantry') },
      { id: 'r1', col: 1, row: 3, owner: 'red', health: 5 },
    ]);
    expect(canCharge(state, arrived(state))).toBe(false);
    expect(canAttack(state, arrived(state))).toBe(true);
  });

  // The other half of that, stated so the coincidence is not mistaken for a bug:
  // at contact a horseman may do either, and both rows show.
  it('offers both to cavalry at contact, whose ranges coincide', () => {
    const state = contact();
    expect(canCharge(state, arrived(state))).toBe(true);
    expect(canAttack(state, arrived(state))).toBe(true);
  });

  // ⚠️ Capability comes through the same rule rather than a separate check:
  // artillery does not charge, so `refuseCharge` says no for every target
  // and the row never appears.
  it('is false for artillery, which cannot charge at all', () => {
    const state = contact('artillery');
    expect(canCharge(state, arrived(state))).toBe(false);
  });

  it('is false when the neighbour is a friend', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'b2', col: 1, row: 2, health: 5 },
    ]);
    expect(canCharge(state, arrived(state))).toBe(false);
  });
});

describe('canAttack, which decides whether the panel offers it', () => {
  const arrived = (state: GameState) => withB1Arrived(state, at(1, 1));

  it('is false with nobody on the board but the unit', () => {
    const state = makeState(7, [{ id: 'b1', col: 1, row: 1 }]);
    expect(canAttack(state, arrived(state))).toBe(false);
  });

  it('is true with an enemy in the band', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 3, owner: 'red' },
    ]);
    expect(canAttack(state, arrived(state))).toBe(true);
  });

  // ⚠️ **The reason this asks `refuseAttack` rather than counting what stands in
  // `tilesInRange`.** The band is *reach* and knows nothing about ownership, so
  // a panel built on it would offer Attack here and the click would be refused.
  it('is false when the only thing in range is a friend', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'b2', col: 1, row: 2 },
    ]);
    expect(canAttack(state, arrived(state))).toBe(false);
  });

  // The same rule's other half: a gun cannot shoot what has closed with it, so
  // an adjacent enemy is no reason to offer Attack.
  it('is false when the only enemy is inside a minimum range', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);
    expect(canAttack(state, arrived(state))).toBe(false);
  });

  // ⚠️ Asked from where the unit *will* stand, not where it stands now -- the
  // walk is a preview, and a panel answering for the origin would offer Attack
  // for a shot the destination cannot take, or hide one it can.
  it('answers for the destination, not the origin', () => {
    const state = makeState(9, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 6, owner: 'red' },
    ]);
    expect(canAttack(state, withB1Arrived(state, at(1, 1)))).toBe(false);
    expect(canAttack(state, withB1Arrived(state, at(1, 4)))).toBe(true);
  });
});

describe('the tiles attacking mode lights', () => {
  const has = (tiles: Coordinate[], col: number, row: number) =>
    tiles.some((tile) => tile.col === col && tile.row === row);
  const tilesFor = (state: GameState) => withB1Attacking(state, at(1, 1)).step.tiles;

  // ⚠️ **The whole band, with no holes punched in it.** These tiles used to be
  // filtered -- an adjacent tile with nothing hostile on it was left to the
  // facing overlay, because both sets were lit at once and the colours had to
  // be split somehow. Facing is its own mode now, so reach is simply reach.
  it('lights an empty tile beside the unit, like any other in range', () => {
    const tiles = tilesFor(makeState(7, [{ id: 'b1', col: 1, row: 1 }]));
    expect(has(tiles, 1, 2)).toBe(true);
    expect(has(tiles, 1, 3)).toBe(true);
  });

  it('lights a tile a friend is standing on, too', () => {
    const tiles = tilesFor(
      makeState(7, [
        { id: 'b1', col: 1, row: 1 },
        { id: 'b2', col: 1, row: 2 },
      ]),
    );
    expect(has(tiles, 1, 2)).toBe(true);
  });

  // ⚠️ Lit is not the same as clickable, and that is deliberate -- the same
  // line `settled` and `reachable` already draw for movement. `readAimClick`
  // is what refuses; this only says what the band is.
  it('lights ground it cannot legally shoot at, because reach is the point', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'b2', col: 1, row: 2 },
    ]);
    expect(has(tilesFor(state), 1, 2)).toBe(true);
    expect(readAimClick(state, withB1Attacking(state, at(1, 1)), at(1, 2))).toBeNull();
  });

  // Artillery cannot shoot anything that has closed with it, so its band starts
  // some way out -- the one exclusion that survives, because it is the *range*,
  // not a colour. How far out is the catalog's to say.
  it('never includes what a minimum range forbids', () => {
    const { min, max } = getUnitType('artillery').range;
    const tiles = tilesFor(
      makeState(max + 3, [
        { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery' },
        { id: 'r1', col: 1, row: 2, owner: 'red' },
      ]),
    );
    for (let d = 1; d < min; d++) expect(has(tiles, 1, 1 + d)).toBe(false);
    expect(has(tiles, 1, 1 + min)).toBe(true);
  });
});
