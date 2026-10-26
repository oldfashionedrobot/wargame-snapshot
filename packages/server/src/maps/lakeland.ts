import type { GameMap } from './types';

/**
 * A lake with a wooded island in the middle of it, and a road down the west
 * shore.
 *
 * The island is the point, and what water costs is what makes it one. Infantry
 * wades in and crosses in a single turn; cavalry pays most of its budget to
 * enter, so it arrives in two turns and spends the night between them standing
 * in open water at zero defence. Artillery cannot enter water at any price and
 * never reaches the island at all.
 *
 * ⚠️ **So the island is a wood no gun can ever take.** Cover reachable on foot, and unreachable by the one arm that could dig an occupant
 * out at range -- which leaves shelling it from the shore as the answer, and
 * makes holding it worth the walk.
 *
 * ⚠️ **The lake leaves a lane down each flank**, which is what keeps the board
 * crossable for wheels with no bridge on it anywhere. The west lane is the
 * road; the east one is open field with a wood on it, so the two are worth
 * different things.
 */
export const lakeland: GameMap = {
  id: 'lakeland',
  name: 'Lakeland',
  rows: [
    '.-..........',
    '.-..........',
    '.-.~~~~~~.f.',
    '.-~~~~~~~~..',
    '.-~~~ff~~~..',
    '.-~~~ff~~~..',
    '.-~~~~~~~~..',
    '.-.~~~~~~...',
    '.----------.',
    '.-.^.....^..',
    '.-..........',
    '.-..........',
  ],
};
