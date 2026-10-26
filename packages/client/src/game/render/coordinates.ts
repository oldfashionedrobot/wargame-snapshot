import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Coordinate } from '@wargame/shared';

export const TILE_SIZE = 1;

export function tileToWorld(
  coordinate: Coordinate,
  gridWidth: number,
  gridHeight: number,
): Vector3 {
  const offsetX = ((gridWidth - 1) * TILE_SIZE) / 2;
  const offsetZ = ((gridHeight - 1) * TILE_SIZE) / 2;
  return new Vector3(coordinate.col * TILE_SIZE - offsetX, 0, coordinate.row * TILE_SIZE - offsetZ);
}

export function worldToTile(
  x: number,
  z: number,
  gridWidth: number,
  gridHeight: number,
): Coordinate {
  const offsetX = ((gridWidth - 1) * TILE_SIZE) / 2;
  const offsetZ = ((gridHeight - 1) * TILE_SIZE) / 2;
  return {
    col: Math.round((x + offsetX) / TILE_SIZE),
    row: Math.round((z + offsetZ) / TILE_SIZE),
  };
}
