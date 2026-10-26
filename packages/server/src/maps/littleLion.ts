import type { GameMap } from './types';

/**
 * Drawn after Advance Wars: Dual Strike's *Little Lion*, at a skirmish board's
 * size. The armies start in opposite corners, with a ridge and a lake in each
 * of the other two, and one road from each army meeting in the middle -- so
 * the zones are declared toward the corners.
 */
export const littleLion: GameMap = {
  id: 'little-lion-12',
  name: 'Little Lion',
  rows: [
    '.-..........',
    '.-..........',
    '.-..^.ffww..',
    '.-..^^^wwww.',
    '.-#...#wwww.',
    '.-----......',
    '.....------.',
    '.wwww#...#-.',
    '.wwww^^^..-.',
    '..wwff.^..-.',
    '..........-.',
    '..........-.',
  ],
  zoneStarts: [0, 2],
};
