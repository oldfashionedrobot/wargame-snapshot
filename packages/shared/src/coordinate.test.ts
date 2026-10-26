import { describe, expect, it } from 'bun:test';
import {
  attackSide,
  coordinateKey,
  coordinatesEqual,
  directionBetween,
  facingToward,
  isWithinGrid,
  orthogonalNeighbours,
  tileDistance,
} from './coordinate';
import { at } from './testing';

describe('coordinatesEqual', () => {
  it('compares by value, since Coordinate has no identity in JS', () => {
    expect(coordinatesEqual(at(2, 3), at(2, 3))).toBe(true);
    expect(coordinatesEqual(at(2, 3), at(3, 2))).toBe(false);
  });
});

describe('coordinateKey', () => {
  // It exists so coordinates can key a Map. Two different tiles sharing a key
  // would silently merge in the movement search.
  it('gives transposed coordinates different keys', () => {
    expect(coordinateKey(at(1, 2))).not.toBe(coordinateKey(at(2, 1)));
  });

  it('gives equal coordinates the same key', () => {
    expect(coordinateKey(at(4, 7))).toBe(coordinateKey(at(4, 7)));
  });
});

describe('orthogonalNeighbours', () => {
  it('gives the four touching tiles and no diagonal', () => {
    expect(orthogonalNeighbours(at(3, 3))).toEqual([at(3, 4), at(4, 3), at(3, 2), at(2, 3)]);
  });

  // ⚠️ Unclipped on purpose: the search rejects a tile by cost and the panel by
  // the board's edge, so folding either filter in here would make the other
  // pass bounds it has no use for.
  it('does not clip to a board it was never told about', () => {
    expect(orthogonalNeighbours(at(0, 0))).toContainEqual(at(-1, 0));
    expect(orthogonalNeighbours(at(0, 0))).toContainEqual(at(0, -1));
  });
});

describe('isWithinGrid', () => {
  // The bounds are half-open, and both axes are checked -- a version that
  // tested only one, or used <= on the far edge, is what this pins.
  it('accepts the corners and rejects everything one step past them', () => {
    expect(isWithinGrid(at(0, 0), 4, 3)).toBe(true);
    expect(isWithinGrid(at(3, 2), 4, 3)).toBe(true); // last column, last row
    expect(isWithinGrid(at(4, 2), 4, 3)).toBe(false); // one column too far
    expect(isWithinGrid(at(3, 3), 4, 3)).toBe(false); // one row too far
    expect(isWithinGrid(at(-1, 0), 4, 3)).toBe(false);
    expect(isWithinGrid(at(0, -1), 4, 3)).toBe(false);
  });
});

describe('directionBetween', () => {
  it('names each of the four orthogonal steps', () => {
    expect(directionBetween(at(1, 1), at(2, 1))).toBe('east');
    expect(directionBetween(at(1, 1), at(0, 1))).toBe('west');
    expect(directionBetween(at(1, 1), at(1, 2))).toBe('north');
    expect(directionBetween(at(1, 1), at(1, 0))).toBe('south');
  });

  // Both cases a caller has to treat the same way: nothing to derive.
  it('is null for standing still and for a jump', () => {
    expect(directionBetween(at(2, 2), at(2, 2))).toBeNull();
    expect(directionBetween(at(0, 0), at(0, 2))).toBeNull(); // two tiles
    expect(directionBetween(at(0, 0), at(1, 1))).toBeNull(); // diagonal
  });
});

describe('tileDistance', () => {
  it('counts orthogonal steps, not straight-line distance', () => {
    expect(tileDistance({ col: 0, row: 0 }, { col: 3, row: 0 })).toBe(3);
    expect(tileDistance({ col: 0, row: 0 }, { col: 0, row: 3 })).toBe(3);
  });

  // ⚠️ The case that decides the whole function. Euclidean would call this 1.41
  // and Chebyshev would call it 1; the board is orthogonal, so it is 2 -- and a
  // range band that disagreed would let a gun reach corners its movement cannot.
  it('counts a diagonal as two steps', () => {
    expect(tileDistance({ col: 0, row: 0 }, { col: 1, row: 1 })).toBe(2);
  });

  it('is zero for a tile against itself, and symmetric otherwise', () => {
    expect(tileDistance({ col: 4, row: 7 }, { col: 4, row: 7 })).toBe(0);
    expect(tileDistance({ col: 1, row: 5 }, { col: 4, row: 2 })).toBe(
      tileDistance({ col: 4, row: 2 }, { col: 1, row: 5 }),
    );
  });
});

describe('facingToward', () => {
  it('points along an axis when the target is on one', () => {
    expect(facingToward(at(2, 2), at(2, 5), 'west')).toBe('north');
    expect(facingToward(at(2, 2), at(2, 0), 'west')).toBe('south');
    expect(facingToward(at(2, 2), at(6, 2), 'west')).toBe('east');
    expect(facingToward(at(2, 2), at(0, 2), 'north')).toBe('west');
  });

  // ⚠️ Where `directionBetween` gives up: a target off both axes is not one
  // step in any direction, and an attack still has to leave the unit looking
  // somewhere.
  it('takes the dominant axis when the target is off both', () => {
    expect(facingToward(at(0, 0), at(1, 4), 'west')).toBe('north');
    expect(facingToward(at(0, 0), at(4, 1), 'west')).toBe('east');
  });

  it('breaks an exact diagonal toward the row, consistently', () => {
    expect(facingToward(at(0, 0), at(3, 3), 'west')).toBe('north');
    expect(facingToward(at(0, 0), at(3, -3), 'west')).toBe('south');
  });

  it('keeps the unit’s own facing for its own tile', () => {
    expect(facingToward(at(4, 4), at(4, 4), 'west')).toBe('west');
  });
});

describe('attackSide', () => {
  // ⚠️ The sign, asserted from both ends deliberately. Read the arguments the
  // other way round -- as the direction the *attack travels* rather than the
  // direction the defender looks to find it -- and front and rear swap with
  // nothing about either result looking wrong. One example would be satisfied
  // by the inverted reading; a matched pair cannot be.
  it('is front when the defender is looking at the attack, rear when away', () => {
    expect(attackSide('north', at(2, 2), at(2, 5))).toBe('front');
    expect(attackSide('north', at(2, 2), at(2, 0))).toBe('rear');
    expect(attackSide('south', at(2, 2), at(2, 0))).toBe('front');
    expect(attackSide('south', at(2, 2), at(2, 5))).toBe('rear');
  });

  it('is flank from either side, and they are not told apart', () => {
    expect(attackSide('north', at(2, 2), at(5, 2))).toBe('flank');
    expect(attackSide('north', at(2, 2), at(0, 2))).toBe('flank');
  });

  it('classifies all four directions against one facing', () => {
    expect(attackSide('east', at(2, 2), at(5, 2))).toBe('front');
    expect(attackSide('east', at(2, 2), at(0, 2))).toBe('rear');
    expect(attackSide('east', at(2, 2), at(2, 5))).toBe('flank');
    expect(attackSide('east', at(2, 2), at(2, 0))).toBe('flank');
  });

  // Inherited from `facingToward` rather than decided again here: the dominant
  // axis wins and an exact diagonal goes to the row. Stated once, so a gun off
  // the axis is classified by the same rule that turns the attacker.
  it('takes the dominant axis off the line, ties going to the row', () => {
    expect(attackSide('north', at(0, 0), at(1, 4))).toBe('front'); // mostly ahead
    expect(attackSide('north', at(0, 0), at(4, 1))).toBe('flank'); // mostly aside
    expect(attackSide('north', at(0, 0), at(3, 3))).toBe('front'); // the tie
  });

  // Nothing may target itself, so this is unreachable rather than meaningful --
  // it is here because `facingToward` needs *some* fallback and a unit reading
  // as attacked from its own front is the harmless answer.
  it('reads its own tile as front', () => {
    expect(attackSide('west', at(4, 4), at(4, 4))).toBe('front');
  });
});
