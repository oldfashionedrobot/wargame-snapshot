import { tileDistance } from './coordinate';
import { clampHealth, GENERAL_HEALING } from './data/unitTypes';
import { generalOf } from './queries';
import { nextPlayer } from './turns';
import type { GameEvent, GameState } from './types';

/**
 * Nothing beyond the actor check every command gets, which is why this takes
 * no arguments -- ending your own turn is always legal.
 *
 * ⚠️ It survives the action budget rather than being replaced by it. A turn
 * ends itself once its actions are spent, so this is the **early exit**: the
 * one thing Advance Wars' own End command does that an auto-end cannot, which
 * is letting a player stop before committing every unit they are allowed to.
 *
 * ⚠️ It stayed empty. This once predicted that refusing commands after a game
 * ends would land here and in `validateMove` alike; it landed in
 * `validateCommand` instead, once, above the dispatch that reaches both -- so
 * the rule covers commands that do not exist yet, and there is no second site to
 * forget.
 */
export function validateEndTurn(): string | null {
  return null;
}

/**
 * The turn passes: hand over, then whatever happens as the next turn begins --
 * today, the incoming player's units on the four tiles beside their general
 * heal `GENERAL_HEALING`. The general does not heal itself.
 *
 * ⚠️ **`state` is the board the turn ends on**, after whatever action ended it,
 * so a unit killed by the turn's last move is not healed. No move changes whose
 * turn it is, so the hand-over reads the same from it.
 */
export function resolveEndTurn(state: GameState): GameEvent[] {
  const next = nextPlayer(state);
  const events: GameEvent[] = [{ type: 'turnEnded', nextPlayer: next }];

  const general = generalOf(state, next);
  const healed = !general
    ? []
    : state.units
        .filter(
          (unit) =>
            unit.owner === next &&
            tileDistance(unit.position, general.position) === 1 &&
            unit.health < clampHealth(unit.health + GENERAL_HEALING),
        )
        .map((unit) => ({ unitId: unit.id, health: clampHealth(unit.health + GENERAL_HEALING) }));
  if (healed.length > 0) events.push({ type: 'unitsHealed', units: healed });
  return events;
}
