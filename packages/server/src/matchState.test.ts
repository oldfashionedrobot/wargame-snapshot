import { describe, expect, it } from 'bun:test';
import { getMap } from './maps';
import type { GameMap } from './maps';
import { createMatchState, PLAYERS } from './matchState';
import type { Deployment, DeploymentZone } from './matchState';

const classic = getMap('classic');

const board = (rows: string[]): GameMap => ({ id: 'fixture', name: 'Fixture', rows });

// ⚠️ **Every test that pins a *position* supplies its own armies and zone.**
// Both are tuning dials -- the formation has been rewritten mid-playtest, and
// where the zone sits is map data -- so a suite that reads either is a suite
// that breaks every time the game is tuned. Only the agnostic properties use the
// defaults.
// The seats' ids, read rather than written out: they are the list's to name.
const [FIRST, SECOND] = PLAYERS.map((player) => player.id);

const versus = (blue: string[], red: string[] = blue): Deployment[] => [
  { player: PLAYERS[0], army: blue },
  { player: PLAYERS[1], army: red },
];
const zone = (width: number, depth: number): DeploymentZone => ({ width, depth });

const EIGHT_WIDE = ['iiiiiiii'];
/** Two units, different types, so a rotation shows up as a mirror. */
const ASYMMETRIC = ['ac'];
const TEN_BY_SIX = () => board(Array.from({ length: 6 }, () => '..........'));

describe('createMatchState', () => {
  it('instantiates the map into a board', () => {
    const state = createMatchState(classic);
    expect(state.grid).toHaveLength(classic.rows.length);
    expect(state.grid[0]).toHaveLength(classic.rows[0].length);
    expect(state.currentTurn).toBe(FIRST);
    expect(state.units.every((unit) => !unit.hasActed)).toBe(true);
  });

  it('gives both players a roster under the default deployment', () => {
    const state = createMatchState(classic);
    const perOwner = new Map<string, number>();
    for (const unit of state.units) perOwner.set(unit.owner, (perOwner.get(unit.owner) ?? 0) + 1);

    expect([...perOwner.keys()].sort()).toEqual([FIRST, SECOND]);
    // The default happens to be symmetric; that it *may* not be is below.
    expect(new Set(perOwner.values()).size).toBe(1);
  });

  // ⚠️ The point of the whole change: the two sides no longer mirror. Different
  // compositions *and* different counts, because a budget buys unequal numbers
  // of unequal things.
  it('deploys each player their own army', () => {
    const state = createMatchState(TEN_BY_SIX(), versus(['cccc'], ['aaii']), zone(4, 1));
    const typesOf = (owner: string) =>
      state.units
        .filter((unit) => unit.owner === owner)
        .map((unit) => unit.unitTypeId)
        .sort();

    expect(typesOf(FIRST)).toEqual(['cavalry', 'cavalry', 'cavalry', 'cavalry']);
    expect(typesOf(SECOND)).toEqual(['artillery', 'artillery', 'infantry', 'infantry']);
  });

  it('lets the two sides field different numbers of units', () => {
    const state = createMatchState(TEN_BY_SIX(), versus(['cc..'], ['aaii']), zone(4, 1));
    const count = (owner: string) => state.units.filter((unit) => unit.owner === owner).length;

    expect(count(FIRST)).toBe(2);
    expect(count(SECOND)).toBe(4);
  });

  it('centres the zone and puts each army on its own edge', () => {
    // Ten wide, an eight-wide zone: a column spare each side.
    const state = createMatchState(TEN_BY_SIX(), versus(EIGHT_WIDE), zone(8, 1));
    const blue = state.units.filter((unit) => unit.owner === FIRST);
    const red = state.units.filter((unit) => unit.owner === SECOND);

    expect(blue.map((unit) => unit.position.col).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(new Set(blue.map((unit) => unit.position.row))).toEqual(new Set([0]));
    expect(new Set(red.map((unit) => unit.position.row))).toEqual(new Set([5]));
  });

  // ⚠️ **The zone is centred, not the units** -- which is the whole reason an
  // army grid is padded rather than trimmed. Under auto-centring these three
  // deployments were the same four units in the middle of the board.
  it('lets empty squares offset an army within the zone', () => {
    const colsFor = (army: string[]) =>
      createMatchState(TEN_BY_SIX(), versus(army), zone(10, 1))
        .units.filter((unit) => unit.owner === FIRST)
        .map((unit) => unit.position.col)
        .sort((a, b) => a - b);

    expect(colsFor(['iiii......'])).toEqual([0, 1, 2, 3]);
    expect(colsFor(['...iiii...'])).toEqual([3, 4, 5, 6]);
    expect(colsFor(['......iiii'])).toEqual([6, 7, 8, 9]);
  });

  // ⚠️ A rotation, not a translation. Copy the zone across and both lines run
  // the same way down the board; turn it, and each player's line is drawn from
  // its own left -- so the two armies mirror through the centre. A two-unit
  // formation of *different* types is the smallest thing that can tell those
  // two apart; a symmetric one passes either way.
  it('rotates the second army rather than copying it', () => {
    const state = createMatchState(TEN_BY_SIX(), versus(ASYMMETRIC), zone(2, 1));
    const typeAt = (col: number, row: number) =>
      state.units.find((unit) => unit.position.col === col && unit.position.row === row)
        ?.unitTypeId;

    // Blue lays 'ac' down from its own left; red's is mirrored through centre.
    expect(typeAt(4, 0)).toBe('artillery');
    expect(typeAt(5, 0)).toBe('cavalry');
    expect(typeAt(5, 5)).toBe('artillery');
    expect(typeAt(4, 5)).toBe('cavalry');
  });

  // ⚠️ Columns chosen so the three readings disagree: centred would put blue at
  // 3 and 4, and the far zone turned from the near one would put red at 7
  // and 6. Declared, red's line still runs from its own left.
  it('deploys each army where the map declares its zone', () => {
    const map = { ...TEN_BY_SIX(), zoneStarts: [2, 5] as [number, number] };
    const state = createMatchState(map, versus(['ac..']), zone(4, 1));
    const typeAt = (col: number, row: number) =>
      state.units.find((unit) => unit.position.col === col && unit.position.row === row)
        ?.unitTypeId;

    expect(typeAt(2, 0)).toBe('artillery');
    expect(typeAt(3, 0)).toBe('cavalry');
    expect(typeAt(8, 5)).toBe('artillery');
    expect(typeAt(7, 5)).toBe('cavalry');
  });

  // An odd spare column cannot be split evenly, and the far zone is the near
  // one turned -- so it lands a column east, not on the same columns.
  it('centres an undeclared zone on an odd-width board as the near one turned', () => {
    const state = createMatchState(
      board(['...........', '...........']),
      versus(['i.........']),
      zone(10, 1),
    );
    const at = (owner: string) => state.units.find((unit) => unit.owner === owner)?.position;
    expect(at(FIRST)).toEqual({ col: 0, row: 0 });
    expect(at(SECOND)).toEqual({ col: 10, row: 1 });
  });

  it('refuses a declared zone that leaves the board, naming the seat', () => {
    const declaring = (zoneStarts: [number, number]) => () =>
      createMatchState({ ...TEN_BY_SIX(), zoneStarts }, versus(['iiii']), zone(4, 1));
    expect(declaring([0, 7])).toThrow(new RegExp(`${SECOND}'s deployment zone at column 7`));
    expect(declaring([-1, 0])).toThrow(new RegExp(`${FIRST}'s deployment zone at column -1`));
    expect(declaring([0.5, 0])).toThrow(new RegExp(`${FIRST}'s deployment zone`));
  });

  it('faces each army at the other', () => {
    const state = createMatchState(classic);
    for (const unit of state.units) {
      expect(unit.facing).toBe(unit.owner === FIRST ? 'north' : 'south');
    }
  });

  // Ids have to be reproducible: initial_state plus the log must replay to the
  // same board, and a generated or random id breaks that.
  it('numbers units per owner in army scan order', () => {
    const state = createMatchState(TEN_BY_SIX(), versus(EIGHT_WIDE), zone(8, 1));
    const blue = state.units.filter((unit) => unit.owner === FIRST);

    expect(blue.map((unit) => unit.id)).toEqual([
      'p1-1',
      'p1-2',
      'p1-3',
      'p1-4',
      'p1-5',
      'p1-6',
      'p1-7',
      'p1-8',
    ]);
    // Scan order is left to right, so p1-1 is the leftmost of seat 1's rank.
    expect(blue[0].position.col).toBe(1);
  });

  // ⚠️ Numbering is per player, so an army half the size of its opponent's still
  // starts at 1 -- the ids are not positions in a combined roster.
  it('numbers each player from one, whatever the other fields', () => {
    const state = createMatchState(TEN_BY_SIX(), versus(['cc..'], ['aaii']), zone(4, 1));
    const idsOf = (owner: string) =>
      state.units.filter((unit) => unit.owner === owner).map((unit) => unit.id);

    expect(idsOf(FIRST)).toEqual(['p1-1', 'p1-2']);
    expect(idsOf(SECOND)).toEqual(['p2-1', 'p2-2', 'p2-3', 'p2-4']);
  });

  it('gives the same ids every time it runs', () => {
    const ids = () => createMatchState(classic).units.map((unit) => unit.id);
    expect(ids()).toEqual(ids());
  });

  it('refuses a board too small to deploy onto', () => {
    // ⚠️ Refused rather than clamped: a negative margin deploys units at
    // negative columns, which parses, stores and replays perfectly while being
    // wrong from the first frame.
    expect(() =>
      createMatchState(board(['....', '....', '....', '....']), versus(EIGHT_WIDE), zone(8, 1)),
    ).toThrow(/too small for 2 deployment zones/);
  });

  // ⚠️ The error the fixed zone exists to produce. Under auto-centring this was
  // a four-wide rank quietly centred on the board, which is exactly the silent
  // behaviour an explicit offset replaces.
  it('refuses an army that is not the size of the zone', () => {
    expect(() => createMatchState(TEN_BY_SIX(), versus(['iiii']), zone(10, 1))).toThrow(
      /fields an army 4x1, not the 10x1 deployment zone/,
    );
    expect(() => createMatchState(TEN_BY_SIX(), versus(['iiii......']), zone(10, 2))).toThrow(
      /fields an army 10x1, not the 10x2 deployment zone/,
    );
  });

  it('names the player whose army does not fit', () => {
    expect(() =>
      createMatchState(TEN_BY_SIX(), versus(['iiii......'], ['ii']), zone(10, 1)),
    ).toThrow(new RegExp(`${SECOND} fields an army 2x1`));
  });
});
