import type { GameMap } from './types';

/**
 * Open field with one road straight across it, and a spur down to that road
 * from each player's own ground.
 *
 * ⚠️ **A road across rather than along** helps you redeploy down your own line
 * far more than it helps you advance, which is the whole character of the
 * board: taking the lateral gains you speed *sideways*, and the enemy is not
 * sideways.
 *
 * ⚠️ **The two spurs do not line up**, one west and one east, so neither player
 * has a straight run at the other -- reaching the lateral is a turn of its own
 * whichever side you are, and what you do with it afterwards is the decision.
 *
 * ⚠️ **One wood and one rise, both off the road and on opposite sides of it.**
 * The wood is cover anything can occupy; the rise is stouter cover that no gun
 * can climb. Each sits nearer one player than the other, so the pair are worth
 * taking for different reasons and at different moments.
 */
export const meadow: GameMap = {
  id: 'meadow',
  name: 'Meadow',
  rows: [
    '..-.........',
    '..-.........',
    '..-.........',
    '..-..ff.....',
    '..-..ff.....',
    '------------',
    '.........-..',
    '...^^....-..',
    '...^^....-..',
    '.........-..',
    '.........-..',
    '.........-..',
  ],
};
