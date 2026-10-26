import { describe, expect, it } from 'vitest';
import { fitPane, PANE_CLEARANCE } from './fitPane';

// The arithmetic that keeps a pane on the board. The renderer feeds it
// projected points every frame and has no tests of its own, being WebGL.
const board = { width: 800, height: 600 };
const pane = { width: 100, height: 40 };

describe('fitPane', () => {
  it('centres the pane over its tile, clear of it', () => {
    expect(fitPane({ x: 400, y: 300 }, 360, pane, board)).toEqual({
      x: 350,
      y: 300 - PANE_CLEARANCE - 40,
    });
  });

  it('shifts in from the left edge', () => {
    expect(fitPane({ x: 20, y: 300 }, 360, pane, board).x).toBe(0);
  });

  it('shifts in from the right edge', () => {
    expect(fitPane({ x: 790, y: 300 }, 360, pane, board).x).toBe(700);
  });

  it('flips below the tile when there is no room above', () => {
    expect(fitPane({ x: 400, y: 30 }, 90, pane, board)).toEqual({
      x: 350,
      y: 90 + PANE_CLEARANCE,
    });
  });

  it('stays above when it exactly fits', () => {
    expect(fitPane({ x: 400, y: PANE_CLEARANCE + 40 }, 90, pane, board).y).toBe(0);
  });

  it('sits at the left edge when it is wider than the board', () => {
    expect(fitPane({ x: 50, y: 300 }, 360, { width: 900, height: 40 }, board).x).toBe(0);
  });
});
