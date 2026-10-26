export const DEFAULT_DB_URL = process.env.DATABASE_URL ?? 'file:./packages/server/wargame.db';
// Unset for a local file, which needs none.
export const DB_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN;
export const DEFAULT_PORT = Number(process.env.PORT ?? 3001);
export const DEFAULT_BUILD = Number(process.env.BUILD ?? 0);
export const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * ⚠️ **In production, nothing starts without these** -- not the server, not the
 * migration step -- rather than fall back to a local file on a disk replaced on
 * every deploy, or sign tokens with the development key anyone can read here.
 * Outside production, a no-op.
 */
const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'DATABASE_AUTH_TOKEN', 'GUEST_KEY'];

export function checkProductionConfig(): void {
  if (!IS_PROD) return;
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]);
  if (missing.length > 0) throw new Error(`production needs ${missing.join(', ')}`);
}
