import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import type { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { Coordinate } from '@wargame/shared';
import { TILE_SIZE, tileToWorld } from './coordinates';

export function createTileHighlight(
  scene: Scene,
  name: string,
  color: Color3,
  alpha: number,
): Mesh {
  const mesh = CreateGround(name, { width: TILE_SIZE * 0.96, height: TILE_SIZE * 0.96 }, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = color;
  material.emissiveColor = color;
  material.alpha = alpha;
  mesh.material = material;
  mesh.setEnabled(false);
  return mesh;
}

export function setHighlightTile(
  mesh: Mesh,
  coordinate: Coordinate | null,
  /** Above the tile's own surface, so highlights stack without fighting. */
  height: number,
  surfaceAt: (coordinate: Coordinate) => number,
  gridWidth: number,
  gridHeight: number,
): void {
  if (!coordinate) {
    mesh.setEnabled(false);
    return;
  }

  const center = tileToWorld(coordinate, gridWidth, gridHeight);
  mesh.position.set(center.x, surfaceAt(coordinate) + height, center.z);
  mesh.setEnabled(true);
}
