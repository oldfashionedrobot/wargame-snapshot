import type { GameState, Unit } from './types';

/**
 * May this unit act at all right now -- ownership and whether it is spent.
 *
 * Deliberately *not* "may it move there": that is `validatePath`'s question,
 * and keeping the two apart is what lets the client preview selection with
 * this same predicate while the server walks the route with the other.
 */
export function canSelectUnit(state: GameState, unit: Unit): boolean {
  return unit.owner === state.currentTurn && !unit.hasActed;
}
