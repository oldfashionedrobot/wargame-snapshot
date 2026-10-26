import type { GameMap } from './types';

/**
 * A river across the middle with a single crossing, and one strongpoint on each
 * approach to it.
 *
 * The bridge is the whole board. Infantry fords the river anywhere, and so does
 * cavalry for most of its budget, but `wheels` cannot enter water at any price
 * -- so artillery has exactly one way across and both players know where it is.
 *
 * ⚠️ **The two approaches are not the same ground, deliberately.** A wood stands
 * beside the road on the near bank and a rise beside it on the far one: cover
 * anything can walk into, against stouter cover no gun can hold.
 * Whoever crosses first does it past the other's strongpoint, and which kind of
 * strongpoint that is depends on which side of the river you started.
 */
export const classic: GameMap = {
  id: 'classic',
  name: 'Classic',
  rows: [
    '.....-......',
    '.....-......',
    '.....-......',
    '...ff-......',
    '...ff-......',
    '~~~~~=~~~~~~',
    '.....-..^^..',
    '.....-..^^..',
    '.....-......',
    '.....-......',
    '.....-......',
    '.....-......',
  ],
};
