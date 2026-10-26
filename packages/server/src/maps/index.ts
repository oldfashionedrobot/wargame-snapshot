import { classic } from './classic';
import { common } from './common';
import { crossroads } from './crossroads';
import { lakeland } from './lakeland';
import { meadow } from './meadow';
import { missilePlains } from './missilePlains';
import { ridgeIsland } from './ridgeIsland';
import { twoBridges } from './twoBridges';
import { tester } from './tester';
import { twinIsle } from './twinIsle';
import { littleLion } from './littleLion';
import { mirrorIslands } from './mirrorIslands';
import type { GameMap } from './types';

export type { GameMap } from './types';

// Every map, by id. Maps are code rather than rows because they are reviewed
// as diffs; see *Maps in a table* in the roadmap for when that changes. ⚠️ A
// Map, not an object: an id arrives from a request, and an object would answer
// `constructor` with what it inherits.
const MAPS = new Map<string, GameMap>(
  [
    classic,
    crossroads,
    twoBridges,
    lakeland,
    meadow,
    common,
    tester,
    missilePlains,
    twinIsle,
    ridgeIsland,
    littleLion,
    mirrorIslands,
  ].map((map) => [map.id, map]),
);

export const DEFAULT_MAP_ID = classic.id;

export function listMaps(): GameMap[] {
  return [...MAPS.values()];
}

/** Throws on an unknown id, the same way the other content lookups do. */
export function getMap(id: string): GameMap {
  const map = MAPS.get(id);
  if (!map) throw new Error(`unknown map: ${id}`);
  return map;
}
