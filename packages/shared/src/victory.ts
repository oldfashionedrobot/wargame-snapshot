import { generalOf, isGeneral } from './queries';
import type { GameState, PlayerId } from './types';

/**
 * Who has won with this action, or `null` while more than one player is still
 * standing -- read from the state before the action and the state after it.
 *
 * Two ways to lose: **a player with no army** -- no unit besides its general --
 * and **a player whose general fell**. On a board with no general the first is
 * plain elimination, since every unit then counts. The second needs both
 * states, because a board without a general says nothing on its own: the
 * general may have fallen, or the army may never have fielded one. A general
 * that fell in an earlier action ended the match then, so only this action's
 * can matter.
 *
 * ⚠️ **Sole survivor, never "the one who isn't the loser".** With two players
 * those are the same answer and `players.find(p => p.id !== loser)` is the
 * shorter way to write it -- and it is two-player-only, so it would need
 * rewriting the day a third arrives. This predicate is already the N-player one,
 * which is what lets a future `playerEliminated` event be a *companion* to
 * `gameEnded` rather than a rework of it.
 *
 * ⚠️ **An empty board is unreachable, so it answers `null` rather than
 * guessing.** At most one player can lose per resolution, and that falls out of
 * code elsewhere: `wouldCounter` is false at zero health, so a defender that
 * dies never ripostes, so a single battle kills exactly one unit -- an army's
 * last soldier, or a general, never both. If that ever stops being true this returns "nobody has
 * won yet", which is the safe wrong answer -- the game continues and the next
 * resolution asks again -- rather than crowning whoever `players[0]` happens to
 * be.
 */
export function victor(before: GameState, after: GameState): PlayerId | null {
  const standing = after.players.filter(
    (player) =>
      after.units.some((unit) => unit.owner === player.id && !isGeneral(unit)) &&
      !(generalOf(before, player.id) && !generalOf(after, player.id)),
  );
  return standing.length === 1 ? standing[0].id : null;
}

/**
 * ⚠️ **The one question every command asks, so it is asked once.** Both the
 * refusal in `validateCommand` and the client's "can I still play" need it, and
 * two inlined `winner !== null` checks is two spellings of one rule -- the shape
 * this codebase has corrected repeatedly.
 */
export function isOver(state: GameState): boolean {
  return state.winner !== null;
}
