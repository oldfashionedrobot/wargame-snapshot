/** So many in each window of so long. */
export interface Allowance {
  count: number;
  windowMs: number;
}

/**
 * May this key spend one more of its allowance?
 *
 * ⚠️ **The seam the hardening epic replaces** -- with counts shared between
 * machines, say -- so nothing outside this file knows how they are kept.
 */
export interface Limiter {
  /** Spends one and answers 0, or spends nothing and answers the seconds until it could. */
  take(key: string, allowance: Allowance): number;
}

const SWEEP_MS = 60_000;

/**
 * Fixed windows, held in memory. ⚠️ **Transient state, kept between
 * requests**: counts are not game state, so a restart losing them costs
 * nothing, and held in the database every limited request would spend a write
 * from the quota the limit exists to protect. Windows that have ended are
 * swept, so an address that stops coming stops taking memory.
 */
export function createLimiter(now: () => number): Limiter {
  const windows = new Map<string, { spent: number; endsAt: number }>();
  let sweepAt = 0;

  return {
    take(key, { count, windowMs }) {
      const at = now();
      if (at >= sweepAt) {
        for (const [held, { endsAt }] of windows) if (endsAt <= at) windows.delete(held);
        sweepAt = at + SWEEP_MS;
      }

      let current = windows.get(key);
      if (!current || current.endsAt <= at) {
        current = { spent: 0, endsAt: at + windowMs };
        windows.set(key, current);
      }
      if (current.spent >= count) return Math.ceil((current.endsAt - at) / 1000);
      current.spent++;
      return 0;
    },
  };
}
