/**
 * This browser's guest token, kept so a closed tab can come back to its
 * matches.
 *
 * ⚠️ **Readable by every itch game.** itch serves them all from one origin, so
 * any of them can read `localStorage` and play this guest's matches -- for as
 * long as it keeps using the token, since use renews it. Accepted: that is all a token buys -- a
 * guest's games and its name, no person -- and matches that outlive a tab are worth more.
 *
 * ⚠️ **Storage that throws is caught.** Chrome refuses storage to a cross-site
 * iframe when third-party cookies are blocked -- Incognito's default -- so the
 * token is held in memory instead, and the game still starts. A refresh there
 * starts a new guest: an accepted edge case.
 */
export const GUEST_TOKEN_KEY = 'wargame.guest';

let inMemory: string | null = null;
let minting: Promise<string> | null = null;

function read(): string | null {
  try {
    return localStorage.getItem(GUEST_TOKEN_KEY) ?? inMemory;
  } catch {
    return inMemory;
  }
}

function write(token: string | null): void {
  inMemory = token;
  try {
    if (token === null) localStorage.removeItem(GUEST_TOKEN_KEY);
    else localStorage.setItem(GUEST_TOKEN_KEY, token);
  } catch {
    // Held in memory above; nothing more to do.
  }
}

/** The browser's token, minting one if it has none. Calls made together share one mint. */
export async function guestToken(mint: () => Promise<string>): Promise<string> {
  const held = read();
  if (held) return held;
  minting ??= mint()
    .then((token) => {
      write(token);
      return token;
    })
    .finally(() => {
      minting = null;
    });
  return minting;
}

/**
 * Keeps the token the server renewed this one with. ⚠️ Only over the token the
 * request was sent with, as with forgetting one: when two answers renew
 * together, the first is kept, and either is the same guest.
 */
export function renewGuestToken(sent: string, renewed: string): void {
  if (read() === sent) write(renewed);
}

/**
 * Forgets a token the server refused. ⚠️ Only that one: a call refused with a
 * token that has since been replaced leaves the replacement alone, so two
 * calls refused together do not mint twice.
 */
export function forgetGuestToken(token: string): void {
  if (read() === token) write(null);
}
