import type { GameMap } from './types';

/**
 * One river bent through a right angle, with a crossing on each arm.
 *
 * ⚠️ **The only board carrying both deck orientations**, which is why it is the
 * only one that exercises all of `bridgeTurns`: the west crossing is a
 * north-south road over an east-west river, and the south one is an east-west
 * road over a north-south river.
 *
 * The west road runs the full height of the board and is the fast lane; the
 * south road runs across it. Between them the river cuts the field into
 * quarters, and `wheels` can only change quarter at a bridge.
 *
 * ⚠️ **Broken ground is all on the east side.** A wood on the near quarter and a
 * rise on the far one, with the west left open for the road -- so one flank is
 * a corridor and the other is a fight.
 *
 * ⚠️ The north-south arm stops a row short of the far edge: a river may not be
 * drawn inside a deployment zone, because `wheels` would be stranded wherever a
 * player put a gun on it.
 */
export const twoBridges: GameMap = {
  id: 'two-bridges',
  name: 'Two Bridges',
  rows: [
    '..-.........',
    '..-.........',
    '..-......ff.',
    '..-......ff.',
    '~~=~~~~.....',
    '..-...~.....',
    '..-...~.....',
    '..----=-----',
    '..-...~.^^..',
    '..-...~.^^..',
    '..-.........',
    '..-.........',
  ],
};
