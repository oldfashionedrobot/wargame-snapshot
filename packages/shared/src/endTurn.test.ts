import { describe, expect, it } from 'bun:test';
import { resolveEndTurn, validateEndTurn } from './endTurn';
import { GENERAL_HEALING, MAX_HEALTH } from './data/unitTypes';
import { makeState } from './testing';
import type { GameState, Player } from './types';

const withPlayers = (ids: string[], currentTurn: string): GameState => ({
  ...makeState(3, []),
  players: ids.map((id): Player => ({ id, name: id, color: 'blue' })),
  currentTurn,
});

describe('validateEndTurn', () => {
  it('refuses nothing -- ending your own turn is always legal', () => {
    expect(validateEndTurn()).toBeNull();
  });
});

describe('resolveEndTurn', () => {
  it('names the next player in the list', () => {
    expect(resolveEndTurn(withPlayers(['blue', 'red'], 'blue'))).toEqual([
      { type: 'turnEnded', nextPlayer: 'red' },
    ]);
  });

  // Rotation is modulo over the player list, so it works for any count rather
  // than being written for two.
  it('wraps from the last player back to the first', () => {
    expect(resolveEndTurn(withPlayers(['blue', 'red'], 'red'))).toEqual([
      { type: 'turnEnded', nextPlayer: 'blue' },
    ]);
  });

  it('rotates through more than two players', () => {
    const four = ['a', 'b', 'c', 'd'];
    const next = (from: string) =>
      (resolveEndTurn(withPlayers(four, from))[0] as { nextPlayer: string }).nextPlayer;
    expect(four.map(next)).toEqual(['b', 'c', 'd', 'a']);
  });

  // The behaviour endTurn.ts flags in its own comment as the wrong default:
  // a currentTurn absent from players gives findIndex -1, and -1 + 1 is 0, so
  // the turn silently passes to the first player instead of failing. Pinned
  // here so that whoever makes it throw does so deliberately and sees this
  // test go red, rather than discovering the disagreement with
  // getCurrentPlayer -- which treats the same corruption as fatal.
  it('silently hands the turn to the first player when currentTurn is not in the list', () => {
    expect(resolveEndTurn(withPlayers(['blue', 'red'], 'ghost'))).toEqual([
      { type: 'turnEnded', nextPlayer: 'blue' },
    ]);
  });
});

describe('resolveEndTurn, healing beside a general', () => {
  // Blue ends its turn; red's turn begins with red's general at (2,2).
  const board = (units: Parameters<typeof makeState>[1]) =>
    makeState(
      6,
      [{ id: 'rg', col: 2, row: 2, owner: 'red', unitTypeId: 'general' }, ...units],
      'blue',
    );
  const healed = (state: GameState) => resolveEndTurn(state).find((e) => e.type === 'unitsHealed');

  it("heals the incoming player's units on the four tiles beside their general", () => {
    const state = board([
      { id: 'north', col: 2, row: 3, owner: 'red', health: 50 },
      { id: 'west', col: 1, row: 2, owner: 'red', health: 30 },
    ]);
    expect(healed(state)).toEqual({
      type: 'unitsHealed',
      units: [
        { unitId: 'north', health: 50 + GENERAL_HEALING },
        { unitId: 'west', health: 30 + GENERAL_HEALING },
      ],
    });
  });

  it('never heals past full health', () => {
    const state = board([{ id: 'r1', col: 2, row: 3, owner: 'red', health: MAX_HEALTH - 5 }]);
    expect(healed(state)).toEqual({
      type: 'unitsHealed',
      units: [{ unitId: 'r1', health: MAX_HEALTH }],
    });
  });

  // Diagonals are two steps away, like every other distance in the game.
  it('reaches only the four tiles beside it, not the diagonals', () => {
    expect(healed(board([{ id: 'r1', col: 3, row: 3, owner: 'red', health: 50 }]))).toBeUndefined();
  });

  it("heals neither the general itself nor the outgoing player's units", () => {
    const state = makeState(
      6,
      [
        { id: 'rg', col: 2, row: 2, owner: 'red', unitTypeId: 'general', health: 40 },
        { id: 'b1', col: 2, row: 3, health: 40 },
      ],
      'blue',
    );
    expect(healed(state)).toBeUndefined();
  });

  it('emits nothing when nobody beside the general is hurt', () => {
    expect(resolveEndTurn(board([{ id: 'r1', col: 2, row: 3, owner: 'red' }]))).toEqual([
      { type: 'turnEnded', nextPlayer: 'red' },
    ]);
  });

  it('emits nothing for a player who fielded no general', () => {
    const state = makeState(6, [{ id: 'r1', col: 2, row: 3, owner: 'red', health: 40 }], 'blue');
    expect(healed(state)).toBeUndefined();
  });
});
