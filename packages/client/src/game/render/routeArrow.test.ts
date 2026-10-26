import { describe, expect, it } from 'vitest';
import { CORNER, HEAD, pieceFor, STRAIGHT, TAIL } from './routeArrow';
import type { Coordinate } from '@wargame/shared';
import { at } from '@wargame/shared/testing';

// The one part of the arrow that decides anything; the rest is vertices.
// ⚠️ A wrong rotation on one of the four bends is invisible until somebody
// routes that way, and a screenshot only ever shows one of them at a time.
//
// Row increases north and col increases east, matching `tileToWorld`. Rotation
// is a quarter turn around the ring N E S W, and every canonical piece is drawn
// travelling north.

const piece = (path: Coordinate[], i: number) => pieceFor(path, i);

describe('pieceFor', () => {
  // (0,0) → (0,1) → (0,2): straight north.
  const northward = [at(0, 0), at(0, 1), at(0, 2)];

  it('starts with a tail pointing the way the route leaves', () => {
    expect(piece(northward, 0)).toEqual({ cell: TAIL, rotation: 0 });
  });

  it('ends with a head pointing the way it was travelling', () => {
    expect(piece(northward, 2)).toEqual({ cell: HEAD, rotation: 0 });
  });

  it('runs straight through a tile entered and left on one axis', () => {
    expect(piece(northward, 1).cell).toBe(STRAIGHT);
  });

  // ⚠️ The head points *away* from where it came, not toward it. Getting this
  // backwards draws an arrow aimed at the unit that fired it.
  it('turns the head with the direction of travel', () => {
    const eastward = [at(0, 0), at(1, 0), at(2, 0)];
    const southward = [at(0, 2), at(0, 1), at(0, 0)];
    const westward = [at(2, 0), at(1, 0), at(0, 0)];
    expect(piece(eastward, 2).rotation).toBe(1);
    expect(piece(southward, 2).rotation).toBe(2);
    expect(piece(westward, 2).rotation).toBe(3);
  });

  // ⚠️ All four bends, because the corner is one canonical {SOUTH, EAST} piece
  // rotated -- and a single screenshot can only ever show one of them.
  it('gives each of the four bends its own rotation', () => {
    // Named by the pair of edges the middle tile connects, since that -- not the
    // direction of travel -- is what picks the corner.
    const bends: Array<[Coordinate[], number]> = [
      [[at(0, 0), at(0, 1), at(1, 1)], 0], // {south, east}
      [[at(0, 1), at(1, 1), at(1, 0)], 1], // {west, south}
      [[at(1, 2), at(1, 1), at(0, 1)], 2], // {north, west}
      [[at(2, 1), at(1, 1), at(1, 2)], 3], // {east, north}
    ];
    const seen = bends.map(([path, expected]) => {
      const { cell, rotation } = piece(path, 1);
      expect(cell).toBe(CORNER);
      expect(rotation).toBe(expected);
      return rotation;
    });
    // Every bend distinct: a lookup collapsing two of them would still pass the
    // assertions above if both expectations happened to be written wrong.
    expect(new Set(seen).size).toBe(4);
  });

  it('is symmetric: walking a bend backwards is the same corner', () => {
    const forward = piece([at(0, 0), at(0, 1), at(1, 1)], 1);
    const backward = piece([at(1, 1), at(0, 1), at(0, 0)], 1);
    expect(backward.cell).toBe(CORNER);
    expect(backward.rotation).toBe(forward.rotation);
  });
});
