import type { GameEvent, GameState, PlayerId } from './types';

/**
 * Giving up: the game ends, and whoever did not give up wins. ⚠️ **The one way a
 * game ends that the board did not decide** -- a clock running out is the
 * server giving this for the player who ran out, so the rulebook knows nothing
 * of time.
 *
 * ⚠️ **Two players**, so the other one wins. A third would make a surrender an
 * elimination, which nothing has; the throw is where that would show first.
 */
export function resolveSurrender(state: GameState, actor: PlayerId): GameEvent[] {
  const others = state.players.filter((player) => player.id !== actor);
  if (others.length !== 1) throw new Error(`a surrender needs one opponent, not ${others.length}`);
  return [{ type: 'gameEnded', winner: others[0].id }];
}
