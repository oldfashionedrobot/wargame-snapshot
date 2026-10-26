import { describe, expect, it } from 'bun:test';
import {
  getTileAt,
  getUnitAt,
  inContact,
  getUnit,
  holdsTheTurn,
  playerInSeat,
  seatOf,
} from './queries';
import { at, makeState } from './testing';

describe('getTileAt', () => {
  it('reads the terrain under a coordinate', () => {
    const state = makeState(3, []);
    expect(getTileAt(state, at(1, 2))).toBe('plains');
  });

  // The search asks about neighbours before it knows they are on the board,
  // so off-grid has to answer rather than throw -- and it answers the same
  // way getUnitAt does about an empty tile.
  it('is undefined off the board, in both axes and both directions', () => {
    const state = makeState(3, []);
    expect(getTileAt(state, at(3, 0))).toBeUndefined();
    expect(getTileAt(state, at(0, 3))).toBeUndefined();
    expect(getTileAt(state, at(-1, 0))).toBeUndefined();
    expect(getTileAt(state, at(0, -1))).toBeUndefined();
  });

  // The grid is indexed [row][col], and a square board hides a transposition.
  it('indexes rows before columns', () => {
    const state = makeState({ cols: 4, rows: 2 }, []);
    expect(getTileAt(state, at(3, 1))).toBe('plains'); // the far corner
    expect(getTileAt(state, at(1, 3))).toBeUndefined(); // transposed: off the board
  });
});

describe('getUnitAt', () => {
  it('finds a unit by its position, and nothing on an empty tile', () => {
    const state = makeState(3, [{ id: 'b1', col: 1, row: 1 }]);
    expect(getUnitAt(state, at(1, 1))?.id).toBe('b1');
    expect(getUnitAt(state, at(0, 0))).toBeUndefined();
  });
});

describe('inContact', () => {
  // A blue unit at (2,2) and whatever red stands where each case puts it.
  const beside = (col: number, row: number, unitTypeId?: 'infantry' | 'cavalry' | 'artillery') => {
    const state = makeState(5, [
      { id: 'b1', col: 2, row: 2 },
      { id: 'r1', col, row, owner: 'red', unitTypeId },
    ]);
    return inContact(state, getUnit(state, 'b1')!, at(2, 2));
  };

  it('is true with an enemy on any of the four tiles beside it', () => {
    expect(beside(2, 3)).toBe(true);
    expect(beside(3, 2)).toBe(true);
    expect(beside(2, 1)).toBe(true);
    expect(beside(1, 2)).toBe(true);
  });

  // ⚠️ Four tiles, not eight: the one notion of adjacency the game has.
  it('is false with an enemy only on a diagonal', () => {
    expect(beside(3, 3)).toBe(false);
  });

  // ⚠️ Every unit makes contact -- there is no catalog flag to exempt a gun.
  it('counts a gun as an enemy like any other', () => {
    expect(beside(2, 3, 'artillery')).toBe(true);
  });

  it('is false beside a friend', () => {
    const state = makeState(5, [
      { id: 'b1', col: 2, row: 2 },
      { id: 'b2', col: 2, row: 3 },
    ]);
    expect(inContact(state, getUnit(state, 'b1')!, at(2, 2))).toBe(false);
  });

  // Asked of a coordinate rather than of where the unit stands, because the
  // search asks it of tiles a unit is only considering.
  it('answers for a tile the unit is not standing on', () => {
    const state = makeState(5, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 4, row: 4, owner: 'red' },
    ]);
    expect(inContact(state, getUnit(state, 'b1')!, at(4, 3))).toBe(true);
  });
});

// ⚠️ Seats are positions, numbered from 1 -- the only tie between a match's
// seats and its players, read by the server's actor rule and the client alike.
describe('seats', () => {
  const state = makeState(4, []);
  const [first, second] = state.players;

  it('puts the nth player in seat n', () => {
    expect(playerInSeat(state, 1)).toEqual(first);
    expect(playerInSeat(state, 2)).toEqual(second);
    expect(seatOf(state, first.id)).toBe(1);
    expect(seatOf(state, second.id)).toBe(2);
  });

  it('knows no seat that is not there, and no player who is not playing', () => {
    expect(playerInSeat(state, 0)).toBeNull();
    expect(playerInSeat(state, 3)).toBeNull();
    expect(seatOf(state, 'nobody')).toBeNull();
  });

  it('gives the turn to whoever holds the seat of the player to move', () => {
    const secondToMove = { ...state, currentTurn: second.id };
    expect(holdsTheTurn(state, [1])).toBe(true);
    expect(holdsTheTurn(secondToMove, [1])).toBe(false);
    expect(holdsTheTurn(secondToMove, [1, 2])).toBe(true);
    expect(holdsTheTurn({ ...state, currentTurn: 'nobody' }, [1, 2])).toBe(false);
  });
});
