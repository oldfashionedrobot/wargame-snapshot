import type { GameMap } from './types';

/**
 * From Advance Wars: Dual Strike's *Twin Isle*, redrawn at a skirmish board's
 * size. Two shores of a strait, each a ridge inside a ring road, joined by one
 * neck -- the only way across for anything. Each half is the other turned.
 */
export const twinIsle: GameMap = {
  id: 'twin-isle-12',
  name: 'Twin Isle',
  rows: [
    '.....-......',
    '.....-......',
    '.----------f',
    '.-^^^^#^^^-f',
    '.----------.',
    'wwwww#.wwwww',
    'wwwww.#wwwww',
    '.----------.',
    'f-^^^#^^^^-.',
    'f----------.',
    '......-.....',
    '......-.....',
  ],
};
