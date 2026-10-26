// Nothing that reads as something else: no 0 or O, no 1 or I. Thirty-two
// characters, so a random byte picks one evenly.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 6;

/**
 * A code to join a waiting game by. Short, because it is read aloud and typed,
 * and unique only among waiting games -- a collision is the store's to draw
 * again for.
 */
export function drawJoinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** What a player typed, read as a code: case, spaces and dashes forgiven. */
export function readJoinCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
