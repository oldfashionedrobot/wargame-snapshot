import { LUCK_MAX } from '@wargame/shared';
import type { Rolls } from '@wargame/shared';

/**
 * The only randomness in the codebase, and it is here because `shared/` is not
 * allowed any (invariant 2).
 *
 * ⚠️ **No seed, and that is invariant 9 paying off.** Events carry *resulting*
 * values rather than inputs, so a replay reads what happened and never re-rolls
 * -- there is nothing to reproduce. Most games need a seeded generator, a stored
 * seed and a determinism story; this design bought its way out of all three.
 *
 * ⚠️ **But the rolls are recorded**, on the resolution row beside its events.
 * Luck joins the base before the attacker's band and the defender's cover scale
 * it, so two floors sit between a roll and the damage it produced, and most rolls
 * cannot be read back out of the log. Replay never needs them -- it reads
 * outcomes -- so they are kept as a record, written and not read, like `action`.
 *
 * ⚠️ **`random` is a parameter so the simulator can pass its seeded source** and
 * draw exactly as a match does. The server never passes one.
 */
export function rollLuck(random: () => number = Math.random): Rolls {
  const luck = () => Math.floor(random() * (LUCK_MAX + 1));
  // ⚠️ **All three drawn for every command, whether or not any is used** -- an
  // end of turn uses none, an attack leaves the charge roll unread, and a
  // counter that never happens leaves its own. Deciding first and rolling
  // second would make the *number of draws* depend on the rules, which is the
  // coupling that keeping randomness out of `shared/` exists to avoid.
  //
  // ⚠️ The charge roll is 0..99, not 0..LUCK_MAX: it is read against a
  // *percentage*, and on the luck band every charge above 9% would be certain.
  return { attack: luck(), counter: luck(), charge: Math.floor(random() * 100) };
}
