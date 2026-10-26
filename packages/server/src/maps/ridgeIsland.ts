import type { GameMap } from './types';

/**
 * From Advance Wars: Dual Strike's *Ridge Island*, redrawn at a skirmish
 * board's size. A ring road round two staggered ridges, and a bay in two
 * opposite corners, so the zones are declared clear of them. Each half is the
 * other turned.
 */
export const ridgeIsland: GameMap = {
  id: 'ridge-island-12',
  name: 'Ridge Island',
  rows: [
    '....-.....ww',
    '....-.....ww',
    '....-.....ww',
    '..--------..',
    '.#-...#ff-..',
    '..-^^^^..-..',
    '..-..^^^^-..',
    '..-ff#...-#.',
    '..--------..',
    'ww.....-....',
    'ww.....-....',
    'ww.....-....',
  ],
  zoneStarts: [0, 2],
};
