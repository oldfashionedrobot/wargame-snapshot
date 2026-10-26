import { describe, expect, it } from 'bun:test';
import { makeState } from './testing';
import { actionEndsTurn, actionsAllowed, actionsTaken, nextPlayer } from './turns';

// A turn is a budget of actions, and `hasActed` is what spends it. These pin
// the arithmetic; `action.test.ts` pins that resolution acts on the answer.

describe('actionsAllowed', () => {
  it('is the budget while the roster is longer', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0 },
      { id: 'b3', col: 2, row: 0 },
    ]);
    expect(actionsAllowed(state, 2)).toBe(2);
  });

  // ⚠️ The half that is easy to leave out and fatal to. A player who cannot
  // reach the budget would never end their turn on its own, so "everyone has
  // acted" has to finish a turn as surely as "the budget is gone".
  it('is the roster while it is shorter than the budget', () => {
    const state = makeState(8, [{ id: 'b1', col: 0, row: 0 }]);
    expect(actionsAllowed(state, 5)).toBe(1);
  });

  // The default, and the only genuinely new behaviour: no cap at all, so the
  // roster is the budget. ⚠️ `null` rather than `Infinity` so it survives JSON
  // the day a match records the rules it was played under.
  // ⚠️ **Both regimes, each named.** Nothing here reads `ACTIONS_PER_TURN`:
  // asserting what the default happens to be today is the one thing guaranteed
  // to go red the next time the game is tuned, and it proves nothing about the
  // rule either way.
  it('is the whole roster when there is no cap', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0 },
      { id: 'b3', col: 2, row: 0 },
    ]);
    expect(actionsAllowed(state, null)).toBe(3);
  });

  it('is one when the budget is one, however many units there are', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0 },
      { id: 'b3', col: 2, row: 0 },
    ]);
    expect(actionsAllowed(state, 1)).toBe(1);
  });

  it('is nothing at all for a player with no units left', () => {
    const state = makeState(8, [{ id: 'r1', col: 5, row: 5, owner: 'red' }]);
    expect(actionsAllowed(state, 5)).toBe(0);
  });
});

describe('actionsTaken', () => {
  it('counts the current player only, spent or not', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, hasActed: true },
      { id: 'b2', col: 1, row: 0 },
      // Red's spent units are none of blue's business, and stay spent across
      // the boundary until their own turn refreshes them.
      { id: 'r1', col: 5, row: 5, owner: 'red', hasActed: true },
      { id: 'r2', col: 6, row: 5, owner: 'red', hasActed: true },
    ]);
    expect(actionsTaken(state)).toBe(1);
  });
});

describe('actionEndsTurn', () => {
  const three = () =>
    makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0 },
      { id: 'b3', col: 2, row: 0 },
    ]);

  it('is false while the budget has room after this one', () => {
    expect(actionEndsTurn(three(), 3)).toBe(false);
  });

  it('is true on the action that spends the last of it', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, hasActed: true },
      { id: 'b2', col: 1, row: 0, hasActed: true },
      { id: 'b3', col: 2, row: 0 },
    ]);
    expect(actionEndsTurn(state, 3)).toBe(true);
  });

  it('is true on the first action when the budget is one', () => {
    expect(actionEndsTurn(three(), 1)).toBe(true);
  });

  // The `min` again, from the other side: a lone unit ends the turn by acting
  // however much budget is nominally left.
  it('is true for a lone unit under a budget it cannot reach', () => {
    expect(actionEndsTurn(makeState(8, [{ id: 'b1', col: 0, row: 0 }]), 5)).toBe(true);
  });

  it('waits for the last of them when there is no cap', () => {
    const spent = (n: number) =>
      makeState(
        8,
        [0, 1, 2].map((i) => ({ id: `b${i}`, col: i, row: 0, hasActed: i < n })),
      );
    expect(actionEndsTurn(spent(0), null)).toBe(false);
    expect(actionEndsTurn(spent(1), null)).toBe(false);
    expect(actionEndsTurn(spent(2), null)).toBe(true); // the third is the last
  });
});

describe('nextPlayer', () => {
  it('rotates, and wraps at the end of the list', () => {
    const blue = makeState(8, [{ id: 'b1', col: 0, row: 0 }], 'blue');
    const red = makeState(8, [{ id: 'b1', col: 0, row: 0 }], 'red');
    expect(nextPlayer(blue)).toBe('red');
    expect(nextPlayer(red)).toBe('blue');
  });
});

// ⚠️ **The budget under a mid-turn death, which holds by arithmetic rather than
// by design.** A counter can kill the attacker, and the attacker has just been
// marked `hasActed` -- so its death takes **one from each side** of
// `actionsTaken + 1 >= actionsAllowed`, and the inequality is invariant under
// that. Nothing in `actionsAllowed` says it must stay whole, which is exactly
// why this is pinned here: the next person to touch that `min` will not know.
describe('the budget when a unit dies on its own turn', () => {
  const roster = (acted: number, alive: number) =>
    makeState(
      12,
      Array.from({ length: alive }, (_, i) => ({
        id: `b${i}`,
        col: i,
        row: 0,
        hasActed: i < acted,
      })),
    );

  it('reaches the same verdict whether or not the actor survived', () => {
    // Eight units, three spent. The fourth acts and dies: seven remain, three
    // still marked spent -- and the turn must not end early because of it.
    // ⚠️ Uncapped explicitly: the point is the *roster* moving under the `min`,
    // which a budget of one would hide by ending the turn on any action at all.
    const survived = roster(4, 8);
    const died = roster(3, 7);
    expect(actionEndsTurn(survived, null)).toBe(actionEndsTurn(died, null));
    expect(actionEndsTurn(died, null)).toBe(false);
  });

  // The same board under the other regime: at a budget of one, the first
  // action ends the turn no matter how much roster is left behind it.
  it('ends the turn on any action at all when the budget is one', () => {
    expect(actionEndsTurn(roster(0, 8), 1)).toBe(true);
    expect(actionEndsTurn(roster(3, 8), 1)).toBe(true);
  });

  it('still ends the turn on the last unit, having lost one on the way', () => {
    // Started with eight; one died acting, so six of the seven left are spent
    // and the seventh is about to go.
    expect(actionEndsTurn(roster(6, 7))).toBe(true);
  });

  it('ends the turn when the dying unit was the last that could act', () => {
    // Seven spent of eight, the eighth acts: the turn ends on that action, and
    // whether it survives the reply changes nothing about that.
    expect(actionEndsTurn(roster(7, 8))).toBe(true);
  });
});
