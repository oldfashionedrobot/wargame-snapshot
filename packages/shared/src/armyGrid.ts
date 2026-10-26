import { UNIT_TYPES } from './data/unitTypes';
import type { UnitTypeId } from './data/unitTypes';
import type { Coordinate } from './types';

/** Where one unit stands within an army's own grid, before it meets a board. */
export interface ArmyPlacement {
  at: Coordinate;
  unitTypeId: UnitTypeId;
}

/**
 * ⚠️ An empty square. `.` in a map is plains and `.` in an army is nobody --
 * the same character with two meanings, which is safe only because no row is
 * ever parsed as both. Stated here because the alternative is discovering it.
 */
const EMPTY = '.';

/**
 * Character rows into unit placements, the way `parseTerrainGrid` turns them
 * into tiles.
 *
 * The legend is inverted out of the catalog rather than written down twice, so
 * adding a unit type cannot leave a character behind. Rows rather than a row
 * even where an army is one rank deep: a formation two deep is a string away,
 * and nothing here should have to change for it.
 *
 * ⚠️ **`rows[0]` is the rank nearest that player's own edge**, the same
 * bottom-up convention a map is written in -- so a front rank is written last,
 * under the back rank it advances ahead of.
 *
 * Throws on an unknown character and on a ragged grid, for the reason
 * `parseTerrainGrid` does: a typo in content is a thing to catch at the source
 * rather than a unit that quietly fails to exist.
 */
export function parseArmyGrid(rows: string[]): ArmyPlacement[] {
  const byChar = new Map<string, UnitTypeId>(
    Object.values(UNIT_TYPES).map((unitType) => [unitType.char, unitType.id]),
  );

  const width = rows[0]?.length ?? 0;
  const placements: ArmyPlacement[] = [];

  rows.forEach((row, rowIndex) => {
    if (row.length !== width) {
      throw new Error(`army row ${rowIndex} is ${row.length} wide, not ${width}`);
    }

    [...row].forEach((char, col) => {
      if (char === EMPTY) return;

      const unitTypeId = byChar.get(char);
      if (!unitTypeId) throw new Error(`unknown unit character: ${char}`);

      placements.push({ at: { col, row: rowIndex }, unitTypeId });
    });
  });

  return placements;
}

/** How wide an army's grid is, which is what centring it on a board needs. */
export function armyWidth(rows: string[]): number {
  return rows[0]?.length ?? 0;
}
