import type { GameMap } from './types';

/**
 * Open field with the road up the middle -- the fast way *at* the enemy -- and a
 * rise on one flank of each approach.
 *
 * ⚠️ **The two rises are diagonally opposed**, west on the near approach and
 * east on the far one, so the board is not a mirror and the same plan does not
 * work from both ends. Stout cover and shut to `wheels`: a strong position no
 * gun can ever hold, which is what stops either being simply the best place to
 * be.
 *
 * ⚠️ **A wood sits beside the road at the centre**, which is the tile both
 * players actually want. It is the only real cover on the board anything can
 * occupy, it overlooks the one fast route, and it is equally far from both -- so it is
 * the first argument of the game rather than a position either side inherits.
 */
export const common: GameMap = {
  id: 'common',
  name: 'Common',
  rows: [
    '.....-......',
    '.....-......',
    '.....-......',
    '^^...-......',
    '^^...-......',
    '.....-.ff...',
    '.....-.ff...',
    '.....-...^^.',
    '.....-...^^.',
    '.....-......',
    '.....-......',
    '.....-......',
  ],
};
