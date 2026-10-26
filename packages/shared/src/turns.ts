import type { GameState, PlayerId } from './types';

/**
 * A cap on how many of their units a player may command before the turn
 * passes, or `null` for none.
 *
 * **`null` is the default because Advance Wars is the model**: every unit acts
 * once, the player decides the order, and the turn ends when the last of them
 * has gone. The number is the dial -- at 1 the game is chess, one unit and one
 * command -- and everything between is reachable by editing this line.
 *
 * ⚠️ **`null` rather than `Infinity`, and the reason is JSON.**
 * `Math.min(Infinity, roster)` would pick the roster for free and need no
 * branch at all, which is what makes it tempting. But `Infinity` does not
 * survive `JSON.stringify` -- it comes back as `null` -- and ruleset versioning
 * is already on the roadmap, so the day a match records the rules it was played
 * under this becomes match data and the value changes meaning in transit. One
 * branch now, and there is no migration later.
 *
 * ⚠️ It is not a per-unit budget. A unit still acts at most once a turn, which
 * `hasActed` records; this caps how many of them may do so.
 *
 * ⚠️ Taken as a **default argument** below rather than read straight out of the
 * module, so the rules around it stay reachable from a test at any value. Baked
 * in, the only budget anything could exercise would be whichever one this line
 * happened to hold -- and the case that matters most, a roster shorter than the
 * cap, is invisible without one.
 */
export const ACTIONS_PER_TURN: number | null = null;

function ownUnits(state: GameState) {
  return state.units.filter((unit) => unit.owner === state.currentTurn);
}

/** How many of this turn's actions have been spent. */
export function actionsTaken(state: GameState): number {
  return ownUnits(state).filter((unit) => unit.hasActed).length;
}

/**
 * How many this player gets, which is the budget or their roster, whichever
 * runs out first.
 *
 * ⚠️ The `min` is the half that is easy to leave out and fatal to. A player
 * with fewer units than the budget could never reach it, so their turn would
 * never end on its own -- "everyone has acted" has to finish a turn as surely
 * as "the budget is gone", and both are this one line.
 */
export function actionsAllowed(state: GameState, budget: number | null = ACTIONS_PER_TURN): number {
  const roster = ownUnits(state).length;
  // ⚠️ `=== null`, not `== null`. The loose form would also swallow an
  // explicitly passed `undefined`, which has to keep falling through to the
  // default -- the two readings diverge the moment a caller forwards an
  // optional argument of its own.
  return budget === null ? roster : Math.min(budget, roster);
}

/**
 * Whether one more action finishes the current player's turn.
 *
 * ⚠️ **No fold is needed to answer this.** An action sets `hasActed` on exactly
 * one unit that did not have it, so the count afterwards is the count now plus
 * one -- resolution can decide without applying its own events to a copy of the
 * state first.
 */
export function actionEndsTurn(
  state: GameState,
  budget: number | null = ACTIONS_PER_TURN,
): boolean {
  return actionsTaken(state) + 1 >= actionsAllowed(state, budget);
}

/**
 * Array rotation over `GameState.players`, wrapping via modulo -- works for two
 * players or four, and is where a "skip eliminated players" rule would go.
 *
 * If `currentTurn` is somehow absent from `players`, `findIndex` gives -1 and
 * this returns `players[0]` rather than throwing -- unlike `getCurrentPlayer`,
 * which treats the same corruption as fatal. Unreachable today; noted because
 * the two disagree and the silent one is the wrong default.
 */
export function nextPlayer(state: GameState): PlayerId {
  const current = state.players.findIndex((player) => player.id === state.currentTurn);
  return state.players[(current + 1) % state.players.length].id;
}
