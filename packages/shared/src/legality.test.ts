import { describe, expect, it } from 'bun:test';
import { canSelectUnit } from './legality';
import { makeState, unitAt } from './testing';

// The predicate the client previews selection with and the server enforces, so
// the two cannot offer and refuse different units. It answers "may this unit
// act at all" and deliberately not "may it move there" -- that is
// validatePath's question.

const board = makeState(5, [
  { id: 'mine', col: 0, row: 0 },
  { id: 'spent', col: 1, row: 0, hasActed: true },
  { id: 'theirs', col: 4, row: 4, owner: 'red' },
]);

describe('canSelectUnit', () => {
  it('accepts your own unit that has not acted', () => {
    expect(canSelectUnit(board, unitAt(board, 'mine'))).toBe(true);
  });

  it('refuses a unit that has already acted', () => {
    expect(canSelectUnit(board, unitAt(board, 'spent'))).toBe(false);
  });

  it("refuses the opponent's unit, even though it has not acted", () => {
    expect(canSelectUnit(board, unitAt(board, 'theirs'))).toBe(false);
  });

  // Ownership is compared against whose turn it is, not against a fixed
  // player -- the same unit flips as the turn passes.
  it('follows the turn rather than the unit', () => {
    const redsTurn = { ...board, currentTurn: 'red' };
    expect(canSelectUnit(redsTurn, unitAt(board, 'theirs'))).toBe(true);
    expect(canSelectUnit(redsTurn, unitAt(board, 'mine'))).toBe(false);
  });
});
