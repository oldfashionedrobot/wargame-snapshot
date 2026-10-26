import { applyEvents } from './applyEvents';
import { resolveEndTurn, validateEndTurn } from './endTurn';
import { ACTIONS_PER_TURN, actionEndsTurn } from './turns';
import { resolveMove, validateMove } from './move';
import { resolveSurrender } from './surrender';
import { isOver, victor } from './victory';
import type { Rolls } from './combat';
import type {
  Command,
  EndTurnCommand,
  GameEvent,
  GameState,
  MoveCommand,
  PlayerId,
  SurrenderCommand,
} from './types';

declare const validated: unique symbol;

/**
 * The mark of a command that has been authenticated *and* checked.
 *
 * `validated` is a `unique symbol` that is never exported, so this property is
 * unwritable outside this module. An Action can therefore only come from
 * `validateCommand` -- forging one, or reviving one from JSON, does not compile.
 */
interface Validated {
  actor: PlayerId;
  readonly [validated]: true;
}

export type MoveAction = MoveCommand & Validated;
export type EndTurnAction = EndTurnCommand & Validated;
export type SurrenderAction = SurrenderCommand & Validated;

/**
 * A command the authority has accepted: authenticated, legal, and ready to
 * resolve. Not "a command with an actor attached" -- if it can still be
 * refused, it is not an Action yet.
 */
export type Action = MoveAction | EndTurnAction | SurrenderAction;

export type ValidationResult = { ok: true; action: Action } | { ok: false; reason: string };

/**
 * The only constructor of an Action, and the only place legality is decided.
 *
 * This is what invariant 5 became: rather than each reducer remembering to
 * check its own input, an unchecked action is unrepresentable, so resolution
 * cannot happen without validation having happened first. The compiler
 * enforces the ordering that a convention used to.
 */
export function validateCommand(
  state: GameState,
  command: Command,
  actor: PlayerId,
): ValidationResult {
  // Sender identity first: everything below assumes the actor is allowed to be
  // giving orders at all. ⚠️ **A surrender is the exception** -- a player may
  // give up on anyone's turn, so it asks only that the actor plays here.
  if (command.type === 'surrender') {
    if (!state.players.some((player) => player.id === actor)) {
      return { ok: false, reason: 'not a player in this game' };
    }
  } else if (actor !== state.currentTurn) {
    return { ok: false, reason: 'not your turn' };
  }

  // ⚠️ **Every command, in one line, because this is the only place legality is
  // decided.** Put in the individual validators it would be a rule to remember
  // for each new command type; here a command that does not exist yet is
  // already refused.
  if (isOver(state)) return { ok: false, reason: 'the game is over' };

  const reason = refuse(state, command);
  if (reason) return { ok: false, reason };

  // The single cast in the codebase that mints the brand.
  return { ok: true, action: { ...command, actor } as Action };
}

function refuse(state: GameState, command: Command): string | null {
  switch (command.type) {
    case 'move':
      return validateMove(state, command);
    case 'endTurn':
      return validateEndTurn();
    case 'surrender':
      return null;
    default:
      // Unreachable given the types, but commands arrive as JSON over a wire
      // where types guarantee nothing. parseCommand should have caught this;
      // refusing again costs a line and removes the assumption.
      return `unknown command type: ${String((command as Command).type)}`;
  }
}

/**
 * What actually happened. Callable only with a validated Action, so it does no
 * legality checking of its own -- that already happened, provably.
 *
 * Returns events rather than state: `applyEvents` is the only mutator.
 *
 * ⚠️ **`roll` is an argument, never a field on `Action`.** `validateCommand` is
 * the only constructor of an Action and has no business generating or receiving
 * dice; and `shared/` may not produce randomness at all (invariant 2), so the
 * server rolls and passes it in. That is also what lets the tuning harness drive
 * the whole matchup grid with no server and no browser.
 *
 * ⚠️ **`endTurn` ignores it**, deliberately. The alternative -- only the attack
 * resolver taking a roll, with the dispatcher pulling the argument apart --
 * spreads the decision over two places to spare one branch an unused parameter.
 * A wart either way, and this is the smaller one.
 */
/**
 * ⚠️ **`budget` is a default argument for the same reason `turns.ts` makes it
 * one**: the rules around it have to stay reachable from a test at any value.
 * `ACTIONS_PER_TURN` is a dial -- it has already been moved once -- and a suite
 * that inherits it is a suite that goes red when the game is tuned rather than
 * when it breaks. The server passes nothing and gets the configured rules.
 */
export function resolveAction(
  state: GameState,
  action: Action,
  rolls: Rolls,
  budget: number | null = ACTIONS_PER_TURN,
): GameEvent[] {
  switch (action.type) {
    case 'move': {
      const events = resolveMove(state, action, rolls);
      // ⚠️ **Appended, never folded into `unitMoved`.** Two independently
      // applicable events carrying absolute values, which is invariant 9 and
      // the same shape a charge takes -- a `battleResolved` and then a
      // `unitMoved`, not one event carrying both effects. `resolveEndTurn` is
      // reused rather than constructing a second `turnEnded` beside it, so
      // there stays exactly one place that decides who plays next.
      // ⚠️ Read against the **pre-action** state, which is right today and is
      // the thing 9g has to look at again. `actionsAllowed` counts the *current
      // player's* roster, so a defender dying here cannot move it. A counter
      // killing the **attacker** would -- shrinking the roster and moving both
      // terms of that `min` at once, mid-resolution.
      // ⚠️ **The only fold in resolution, and it has to be one.** Losing is "no
      // army left" or "the general fell", and units leave the board in
      // `applyEvents` -- `resolveBattle` only says what each side *has*. So the
      // question cannot be answered from `state`, which predates the death, nor
      // from the events, which would mean re-deriving what the reducer already
      // does. The same board is what the turn hands over on.
      //
      // ⚠️ **It folds on every move, including ones with no target**, which
      // cannot kill anyone -- so the obvious saving is to ask only when
      // `targetUnitId` is set. Not taken: that puts "only attacks kill" in a
      // second place, where it is a rule this function has no business
      // restating, and the cost it saves is a copy of the units.
      const after = applyEvents(state, events);
      const winner = victor(state, after);
      if (winner !== null) {
        // ⚠️ **`gameEnded` alone, and this early return is what guarantees it.**
        // There is nothing to hand to a player who has already lost, and a
        // `turnEnded` beside it would refresh the loser's `hasActed` flags for a
        // turn that will never come.
        events.push({ type: 'gameEnded', winner });
        return events;
      }
      // The budget is read against the state the action began in; the turn's
      // hand-over against the one it ends in.
      if (actionEndsTurn(state, budget)) events.push(...resolveEndTurn(after));
      return events;
    }
    case 'endTurn':
      // ⚠️ Cannot end the game, and so does not ask: ending a turn removes no
      // unit and fells no general -- its heal only adds health. A condition that
      // could trigger on an empty action -- a turn limit, say -- would move the
      // check out here to cover both branches.
      return resolveEndTurn(state);
    case 'surrender':
      return resolveSurrender(state, action.actor);
    default:
      throw new Error(`unknown action type: ${String((action as Action).type)}`);
  }
}
