import { describe, expect, it } from 'bun:test';
import { makeState } from './testing';
import { isOver, victor } from './victory';
import type { GameState } from './types';

// Elimination reads only the board after the action, so most cases hand the
// same state in as both halves.
const settled = (state: GameState) => victor(state, state);

describe('victor, by elimination', () => {
  it('is nobody while both sides have units', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 3, owner: 'red' },
    ]);
    expect(settled(state)).toBeNull();
  });

  it('is the side still holding units when the other has none', () => {
    const state = makeState(8, [{ id: 'b1', col: 0, row: 0 }]);
    expect(settled(state)).toBe('blue');
  });

  // ⚠️ The half that would be missing from "whoever isn't the loser". That
  // spelling answers with a player id here, because there *is* someone who is
  // not the loser -- both of them. This is the case that makes sole-survivor
  // the N-player predicate rather than a wordier two-player one.
  it('is nobody on an empty board rather than crowning players[0]', () => {
    expect(settled(makeState(8, []))).toBeNull();
  });

  // The winner is whoever is left, not whoever moved -- asserted from the other
  // side so a hardcoded 'blue' cannot pass.
  it('names red just as readily as blue', () => {
    const state = makeState(8, [{ id: 'r1', col: 0, row: 0, owner: 'red' }]);
    expect(settled(state)).toBe('red');
  });

  // ⚠️ It reads the roster, not the marker: a state can satisfy the condition
  // before the event that records it exists, which is exactly the moment
  // `resolveAction` asks.
  it('does not consult the winner already recorded on the state', () => {
    const state = makeState(8, [{ id: 'b1', col: 0, row: 0 }], 'blue', 'red');
    expect(settled(state)).toBe('blue');
  });
});

describe('victor, by the general or the army', () => {
  // Two soldiers a side, so losing one still leaves an army.
  const before = makeState(8, [
    { id: 'bg', col: 0, row: 0, unitTypeId: 'general' },
    { id: 'b1', col: 1, row: 0 },
    { id: 'b2', col: 2, row: 0 },
    { id: 'rg', col: 0, row: 7, owner: 'red', unitTypeId: 'general' },
    { id: 'r1', col: 1, row: 7, owner: 'red' },
    { id: 'r2', col: 2, row: 7, owner: 'red' },
  ]);
  const without = (id: string): GameState => ({
    ...before,
    units: before.units.filter((unit) => unit.id !== id),
  });

  it('hands the match over when a general falls, with its army still standing', () => {
    expect(victor(before, without('bg'))).toBe('red');
    expect(victor(before, without('rg'))).toBe('blue');
  });

  it('is nobody while both generals and both armies stand', () => {
    expect(victor(before, without('b1'))).toBeNull();
  });

  it('hands the match over when an army falls, with its general still standing', () => {
    const armyGone: GameState = {
      ...before,
      units: before.units.filter((unit) => unit.id !== 'b1' && unit.id !== 'b2'),
    };
    expect(victor(before, armyGone)).toBe('red');
  });

  // ⚠️ A board with no general says nothing about one: every stored match and
  // test board is that kind, and has to play by elimination alone.
  it('plays by elimination alone where no general was fielded', () => {
    const noGenerals = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 7, owner: 'red' },
    ]);
    expect(victor(noGenerals, noGenerals)).toBeNull();
  });
});

describe('isOver', () => {
  it('follows the marker and nothing else', () => {
    const playing = makeState(8, [{ id: 'b1', col: 0, row: 0 }]);
    // ⚠️ One unit left and the game is *not* over: the condition has been met
    // but no resolution has recorded it. The marker is the fact; the roster is
    // what produces it, once.
    expect(isOver(playing)).toBe(false);
    expect(isOver(makeState(8, [{ id: 'b1', col: 0, row: 0 }], 'blue', 'blue'))).toBe(true);
  });
});
