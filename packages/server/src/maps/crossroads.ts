import type { GameMap } from './types';

/**
 * A road network closed into a figure of eight, with a wood inside two of its
 * cells.
 *
 * No water and no high ground, so nothing here is impassable and cost is the
 * only thing shaping a move -- which is what makes it the board artillery
 * likes. `wheels` pays less for road than for the field beside it, so the
 * network multiplies a gun's reach and is worth more to that arm than to
 * either other.
 *
 * ⚠️ **The two woods are diagonally opposite**, one in the near-west cell and
 * one in the far-east. Each player has a strongpoint to take and a matching one
 * to shell, and neither sits on the way to the other -- so taking yours is a
 * decision rather than something that happens on the way past.
 */
export const crossroads: GameMap = {
  id: 'crossroads',
  name: 'Crossroads',
  rows: [
    '..-......-..',
    '..-......-..',
    '..--------..',
    '..-.ff...-..',
    '..-.ff...-..',
    '..--------..',
    '..-...ff.-..',
    '..-...ff.-..',
    '..--------..',
    '..-......-..',
    '..-......-..',
    '..-......-..',
  ],
};
