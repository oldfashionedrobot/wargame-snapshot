import type { GuestId } from './guest';

/**
 * How long a player goes unheard before showing as away. ⚠️ **Longer than a
 * hidden tab's poll**, which backs off to every thirty seconds, so away means
 * gone rather than looking at another tab.
 */
export const AWAY_AFTER_MS = 75_000;

/**
 * Who has asked about a match lately. ⚠️ **Shown, never acted on**: a timed
 * game ends on its clock and an untimed one waits, whoever is here.
 */
export interface Presence {
  /** This guest asked about this match just now. */
  heard(matchId: string, guest: GuestId): void;
  /** Whether anybody else in this match has asked lately. */
  othersHere(matchId: string, guest: GuestId): boolean;
}

/**
 * Held in memory, beside the limiter's counts, and for the same reasons: not
 * game state, nothing lost in a restart that matters, and a write per poll if
 * it were in the database. Matches nobody has asked about for a while are
 * swept, so a finished game stops taking memory.
 */
export function createPresence(now: () => number): Presence {
  const lastHeard = new Map<string, Map<GuestId, number>>();
  let sweepAt = 0;

  return {
    heard(matchId, guest) {
      const at = now();
      if (at >= sweepAt) {
        for (const [match, guests] of lastHeard) {
          for (const [someone, heardAt] of guests) {
            if (at - heardAt >= AWAY_AFTER_MS) guests.delete(someone);
          }
          if (guests.size === 0) lastHeard.delete(match);
        }
        sweepAt = at + AWAY_AFTER_MS;
      }
      let guests = lastHeard.get(matchId);
      if (!guests) lastHeard.set(matchId, (guests = new Map()));
      guests.set(guest, at);
    },

    othersHere(matchId, guest) {
      const at = now();
      for (const [someone, heardAt] of lastHeard.get(matchId) ?? []) {
        if (someone !== guest && at - heardAt < AWAY_AFTER_MS) return true;
      }
      return false;
    },
  };
}
