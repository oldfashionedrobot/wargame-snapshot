import type { GameMap } from './types';

/**
 * From Advance Wars: Dual Strike's *Missile Plains*, redrawn at a skirmish
 * board's size. Two ridges across the board, each with one gap, staggered, and
 * one road threading both -- so wheels zigzag from gap to gap while foot
 * climbs straight over.
 */
export const missilePlains: GameMap = {
  id: 'missile-plains-12',
  name: 'Missile Plains',
  rows: [
    '..-.........',
    '..-.........',
    '..-..ff.ww..',
    '..-#....ww..',
    '^^-^^^^^^^^^',
    '..--------#.',
    '.#.......-..',
    '^^^^^^^^^-^^',
    '..ww....#-..',
    '..ww.ff..-..',
    '.........-..',
    '.........-..',
  ],
};
