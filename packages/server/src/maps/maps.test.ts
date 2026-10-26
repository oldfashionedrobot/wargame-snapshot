import { describe, expect, it } from 'bun:test';
import { getTerrain, getUnitType, MAX_HEALTH, parseTerrainGrid } from '@wargame/shared';
import type { Coordinate, MovementType, TileType } from '@wargame/shared';
import { createMatchState, DEPLOYMENT_ZONE, PLAYERS } from '../matchState';
import { DEFAULT_MAP_ID, getMap, listMaps } from './index';

// A map is content the compiler cannot check: it is characters, and every way
// of getting one wrong produces a board that loads and plays wrong. These are
// the properties every map has to satisfy, applied to all of them, so a new map
// is covered the moment it is added.
//
// ⚠️ Asserted against `createMatchState` rather than against the map alone,
// because a map no longer carries units -- so what is under test is the board
// *and the army deployed onto it*, through the engine's own placement of the
// map's zones.

/** Every tile a movement type can walk to from `from`, by flood fill. */
function reach(grid: TileType[][], from: Coordinate, movementType: MovementType): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const { col, row } = queue.shift()!;
    const key = `${col},${row}`;
    if (seen.has(key)) continue;
    if (row < 0 || row >= grid.length || col < 0 || col >= grid[row].length) continue;
    if (getTerrain(grid[row][col]).cost[movementType] === null) continue;
    seen.add(key);
    queue.push({ col: col + 1, row }, { col: col - 1, row });
    queue.push({ col, row: row + 1 }, { col, row: row - 1 });
  }
  return seen;
}

/**
 * How many tiles some movement type can enter -- what reach is measured
 * against, since a board half sea would fail a measure of the whole board by
 * construction.
 */
const land = (grid: TileType[][]) =>
  grid.flat().filter((tile) => Object.values(getTerrain(tile).cost).some((cost) => cost !== null))
    .length;

/** Does a unit setting out from `from` reach most of the land? */
const reachesAcross = (grid: TileType[][], from: Coordinate, movementType: MovementType) =>
  reach(grid, from, movementType).size > land(grid) / 2;

describe('reaching across', () => {
  it('measures against land, so a board mostly sea can pass', () => {
    const grid = parseTerrainGrid(['....', 'ww.w', 'ww.w', 'ww..']);
    expect(reachesAcross(grid, { col: 0, row: 0 }, 'foot')).toBe(true);
  });

  it('fails a start cut off from most of the land', () => {
    const grid = parseTerrainGrid(['.www', 'w...', 'w...']);
    expect(reachesAcross(grid, { col: 0, row: 0 }, 'foot')).toBe(false);
  });
});

/**
 * Deep enough for a couple of turns to set up and take ground before the
 * armies meet, and as wide as the default army fills.
 */
const LARGEST_SIDE = 12;
/** A building is cover; a board full of them is cover everywhere, so nowhere. */
const MOST_BUILDINGS = 5;

/**
 * Off the board counts as water, as the renderer counts it, so water running
 * off an edge is whole rather than cut short.
 */
const wet = (grid: TileType[][], col: number, row: number) => {
  const tile = grid[row]?.[col];
  return tile === undefined || tile === 'sea' || tile === 'river' || tile === 'bridge';
};

describe('every map', () => {
  const maps = listMaps();

  it('there is at least one, and the default is among them', () => {
    expect(maps.length).toBeGreaterThan(0);
    expect(getMap(DEFAULT_MAP_ID).id).toBe(DEFAULT_MAP_ID);
  });

  // ⚠️ The registry is built by id, and a second map under an id already taken
  // silently replaces the first rather than failing -- so this counts the
  // files, which is the one place a duplicate still shows. A board left out of
  // the registry fails it too.
  it('registers every board under an id of its own', () => {
    const files = new Bun.Glob('*.ts').scanSync(import.meta.dir);
    const boards = [...files].filter((file) => !/^(index|types)\.ts$|\.test\.ts$/.test(file));
    expect(maps).toHaveLength(boards.length);
  });

  for (const map of maps) {
    describe(map.id, () => {
      const grid = parseTerrainGrid(map.rows); // throws on a ragged row or bad char
      const height = grid.length;
      const width = grid[0].length;
      const { units } = createMatchState(map);

      it('deploys both armies onto the board', () => {
        expect(units.length).toBeGreaterThan(0);
        for (const { position } of units) {
          expect(position.col).toBeGreaterThanOrEqual(0);
          expect(position.row).toBeGreaterThanOrEqual(0);
          expect(position.col).toBeLessThan(width);
          expect(position.row).toBeLessThan(height);
        }
      });

      // ⚠️ Cheap, and it guards a failure that is silent rather than loud: a
      // unit deployed without health types as `number` and is `undefined`, and
      // `undefined` arithmetic is `NaN` -- so the first symptom would be a
      // damage figure rather than a crash, several phases from here.
      it('deploys every unit at full health', () => {
        for (const { health } of units) expect(health).toBe(MAX_HEALTH);
      });

      it('is no bigger than the default army fills', () => {
        expect(Math.max(width, height)).toBeLessThanOrEqual(LARGEST_SIDE);
      });

      it('carries only a few buildings', () => {
        const buildings = grid.flat().filter((tile) => tile === 'structure');
        expect(buildings.length).toBeLessThanOrEqual(MOST_BUILDINGS);
      });

      it('draws water a tile wide as river, never as sea', () => {
        grid.forEach((cells, row) =>
          cells.forEach((tile, col) => {
            if (tile !== 'sea') return;
            const narrow =
              (!wet(grid, col - 1, row) && !wet(grid, col + 1, row)) ||
              (!wet(grid, col, row - 1) && !wet(grid, col, row + 1));
            expect(`${col},${row}: ${narrow ? 'narrow sea' : 'ok'}`).toBe(`${col},${row}: ok`);
          }),
        );
      });

      // Water open on three sides is a shore with water in both its crooks and
      // a fork with land in both; no piece draws land in just one, which shows
      // a square corner.
      it('draws its water without square corners', () => {
        const sides = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const;
        const corners = [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ] as const;
        grid.forEach((cells, row) =>
          cells.forEach((tile, col) => {
            if (tile !== 'sea' && tile !== 'river') return;
            const open = sides.filter(([dc, dr]) => wet(grid, col + dc, row + dr)).length;
            const crooks = corners.filter(
              ([dc, dr]) => wet(grid, col + dc, row) && wet(grid, col, row + dr),
            );
            const dry = crooks.filter(([dc, dr]) => !wet(grid, col + dc, row + dr)).length;
            const square = open === 3 && dry === 1;
            expect(`${col},${row}: ${square ? 'square corner' : 'ok'}`).toBe(`${col},${row}: ok`);
          }),
        );
      });

      it('never stacks two units on one tile', () => {
        const keys = units.map(({ position }) => `${position.col},${position.row}`);
        expect(new Set(keys).size).toBe(keys.length);
      });

      it('gives every player a roster to play with', () => {
        const perOwner = new Map<string, number>();
        for (const { owner } of units) perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
        expect(perOwner.size).toBeGreaterThan(1); // somebody to play against
        for (const count of perOwner.values()) expect(count).toBeGreaterThan(0);
      });

      // ⚠️ **The zone, not the army** -- and that is the stronger property. A
      // board validated against one formation is a board validated against a
      // formation nobody may field once composition is a choice; a board whose
      // deployment zones are standable throughout is one where *every* legal
      // army deploys. It is also what makes an existing convention checkable:
      // a river may only leave the board where an army does not stand.
      //
      // ⚠️ **Deployed, not worked out.** The engine places both zones, declared
      // or centred, so a test computing the columns itself would check its own
      // arithmetic rather than the board. A full zone for both seats puts a unit
      // on every square; the count makes sure an empty deployment cannot pass.
      it('leaves both deployment zones standable by every movement type', () => {
        const fullZone = Array.from({ length: DEPLOYMENT_ZONE.depth }, () =>
          'i'.repeat(DEPLOYMENT_ZONE.width),
        );
        const everySquare = createMatchState(
          map,
          PLAYERS.map((player) => ({ player, army: fullZone })),
        ).units;
        expect(everySquare.length).toBe(
          PLAYERS.length * DEPLOYMENT_ZONE.width * DEPLOYMENT_ZONE.depth,
        );

        for (const { position } of everySquare) {
          const { col, row } = position;
          // ⚠️ **Read off the cost table, not the unit catalog.** Every movement
          // type terrain knows how to price is one a unit could arrive on,
          // including one no unit uses yet -- which is the case a list taken
          // from today's roster would quietly stop covering.
          for (const [movementType, cost] of Object.entries(getTerrain(grid[row][col]).cost)) {
            // The whole square in the assertion, so a failure names the tile
            // and the movement type rather than just a line number.
            expect(`${col},${row} for ${movementType}: ${cost === null ? 'barred' : 'ok'}`).toBe(
              `${col},${row} for ${movementType}: ok`,
            );
          }
        }
      });

      it('points each army at the other rather than off its own edge', () => {
        // ⚠️ A rule reads this now: an attack from directly behind is never
        // answered, so deployment facing the wrong way would hand every opening
        // exchange's counter to whoever moved second. Row index increases north,
        // and that is the sign worth stating -- it is the one thing here that
        // can be backwards while every individual value still looks reasonable.
        //
        // ⚠️ **Asked of the owner, not of the row.** This found the northmost
        // row and expected everything else to face north, which holds only
        // while an army is one rank deep -- a two-rank formation put a player's
        // own back rank on the wrong side of the comparison. Facing is a
        // property of whose army it is.
        const [near, far] = [...new Set(units.map((unit) => unit.owner))];
        for (const unit of units) {
          expect(unit.facing).toBe(unit.owner === near ? 'north' : 'south');
        }
        expect(far).toBeDefined();
      });

      // The board has to be crossable by everything on it, or a unit is stranded
      // from the first turn. Checked per movement type actually deployed:
      // river and hills part a board only for `wheels`, and sea parts it for
      // every arm.
      const movementTypes = [
        ...new Set(units.map(({ unitTypeId }) => getUnitType(unitTypeId).movementType)),
      ];
      for (const movementType of movementTypes) {
        it(`leaves a route across for ${movementType}`, () => {
          const seed = units.find(
            ({ unitTypeId }) => getUnitType(unitTypeId).movementType === movementType,
          )!;
          const seen = reach(grid, seed.position, movementType);
          for (const { position, unitTypeId } of units) {
            if (getUnitType(unitTypeId).movementType !== movementType) continue;
            expect(seen.has(`${position.col},${position.row}`)).toBe(true);
          }
          // And the far side is reachable, not just the corner it started in.
          expect(reachesAcross(grid, seed.position, movementType)).toBe(true);
        });
      }
    });
  }
});

describe('getMap', () => {
  it('throws on an id no map has', () => {
    expect(() => getMap('atlantis')).toThrow(/unknown map: atlantis/);
  });
});
