import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * A person, not a seat. `PlayerId` names a seat in one match -- blue, red --
 * and a guest owns matches and plays both seats of each from one browser, so
 * the two must not be passable for each other. Server-side only: the client
 * holds a token and never sees the id inside it.
 */
export type GuestId = string & { readonly guest: unique symbol };

export const GUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How old a token gets before an answer carries its replacement. ⚠️ **A guest
 * lasts while it plays**: each renewal is a whole new lifetime, so a guest ends
 * only when nobody has used it for that long. The age is what keeps a client
 * that polls from being handed a new token on every answer.
 */
export const GUEST_RENEWAL_AGE_MS = 24 * 60 * 60 * 1000;

export interface Verified {
  guest: GuestId;
  /** A token for the same guest with a whole lifetime, once this one is old enough to renew. */
  renewal: string | null;
}

export interface Guests {
  mint(): string;
  /** The guest a token names, or null when it is forged, malformed or expired. */
  verify(token: string): Verified | null;
}

/**
 * Guest tokens that need no storage: a random id and an expiry, signed with
 * the server's key. Minting writes nothing and checking reads nothing -- on a
 * database that bills every row, a row per guest and a read per request would
 * both be charged for. Revoking means rotating the key, which signs every
 * guest out; real accounts bring a sessions table with them.
 */
export function createGuests(key: string, now: () => number): Guests {
  const sign = (payload: string): string =>
    createHmac('sha256', key).update(payload).digest('base64url');

  const tokenFor = (guest: string): string => {
    const claims = { guest, expires: now() + GUEST_LIFETIME_MS };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };

  return {
    mint: () => tokenFor(randomUUID()),

    verify(token) {
      const [payload, signature, ...rest] = token.split('.');
      if (!payload || !signature || rest.length > 0) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

      try {
        const { guest, expires } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
          guest?: unknown;
          expires?: unknown;
        };
        if (typeof guest !== 'string' || typeof expires !== 'number' || expires <= now()) {
          return null;
        }
        const age = GUEST_LIFETIME_MS - (expires - now());
        return {
          guest: guest as GuestId,
          renewal: age >= GUEST_RENEWAL_AGE_MS ? tokenFor(guest) : null,
        };
      } catch {
        return null;
      }
    },
  };
}
