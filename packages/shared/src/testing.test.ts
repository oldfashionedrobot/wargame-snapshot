import { describe, expect, it } from 'bun:test';
import { at, makeState, route } from './testing';
import type { Coordinate } from './types';

// The fixture helpers earn tests because the suites lean on them: a `route`
// that silently produced a diagonal would make a hundred assertions agree
// about the wrong thing, and quietly stop testing what they claim to.

const isOrthogonalRoute = (path: Coordinate[]) =>
  path.slice(1).every((step, i) => {
    const previous = path[i];
    return Math.abs(step.col - previous.col) + Math.abs(step.row - previous.row) === 1;
  });

describe('route', () => {
  it('expands endpoints into one step per tile, starting where it was told', () => {
    expect(route(at(1, 1), at(1, 3))).toEqual([at(1, 1), at(1, 2), at(1, 3)]);
  });

  it('turns corners column-first, without repeating the junction', () => {
    expect(route(at(0, 0), at(2, 1))).toEqual([at(0, 0), at(1, 0), at(2, 0), at(2, 1)]);
  });

  it('walks backwards as happily as forwards', () => {
    expect(route(at(3, 2), at(1, 2))).toEqual([at(3, 2), at(2, 2), at(1, 2)]);
  });

  it('threads waypoints in order, which is how a deliberate detour is written', () => {
    const path = route(at(0, 0), at(0, 2), at(2, 2));
    expect(path).toEqual([at(0, 0), at(0, 1), at(0, 2), at(1, 2), at(2, 2)]);
    expect(isOrthogonalRoute(path)).toBe(true);
  });

  it('is a single tile when told to go nowhere -- the wait-in-place shape', () => {
    expect(route(at(2, 2))).toEqual([at(2, 2)]);
    expect(route(at(2, 2), at(2, 2))).toEqual([at(2, 2)]);
  });

  it('only ever steps orthogonally, however far apart the waypoints are', () => {
    expect(isOrthogonalRoute(route(at(0, 0), at(7, 7)))).toBe(true);
    expect(route(at(0, 0), at(7, 7))).toHaveLength(15); // 14 steps plus the origin
  });

  it('needs somewhere to start', () => {
    expect(() => route()).toThrow(/at least one waypoint/);
  });
});

describe('makeState', () => {
  it('builds a square board of plains from a size', () => {
    const state = makeState(3, []);
    expect(state.grid).toHaveLength(3);
    expect(state.grid.every((row) => row.length === 3)).toBe(true);
    expect(state.grid.flat().every((tile) => tile === 'plains')).toBe(true);
  });

  it('builds a non-square board from cols and rows', () => {
    const state = makeState({ cols: 1, rows: 3 }, []);
    expect(state.grid).toHaveLength(3);
    expect(state.grid.every((row) => row.length === 1)).toBe(true);
  });

  // The point of the map form: terrain fixtures read like the board.
  it('builds a board from map rows, through the same parser production uses', () => {
    const state = makeState(['..^', '~..'], [{ id: 'b1', col: 0, row: 0 }]);
    expect(state.grid[0][2]).toBe('hills');
    expect(state.grid[1][0]).toBe('river');
  });

  it('defaults a unit to infantry, and takes the type when given one', () => {
    const state = makeState(3, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0, unitTypeId: 'cavalry' },
    ]);
    expect(state.units[0].unitTypeId).toBe('infantry');
    expect(state.units[1].unitTypeId).toBe('cavalry');
  });
});
