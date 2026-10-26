import type { GameMap } from './types';

/**
 * From Advance Wars: Dual Strike's *Mirror Islands*, redrawn at a skirmish
 * board's size. A river bending across the middle, bridged at either end of
 * the bend, and a ring road either side of it. Each half is the other turned.
 */
export const mirrorIslands: GameMap = {
  id: 'mirror-islands-12',
  name: 'Mirror Islands',
  rows: [
    '...-........',
    '...-........',
    '.----------.',
    '.-ff#..^^f-.',
    '.----------.',
    '~~=~~~~..-..',
    '..-...~~~=~~',
    '.----------.',
    '.-f^^..#ff-.',
    '.----------.',
    '........-...',
    '........-...',
  ],
};
