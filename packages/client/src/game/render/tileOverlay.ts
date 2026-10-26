import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Coordinate } from '@wargame/shared';
import { TILE_SIZE, tileToWorld } from './coordinates';

// One flat quad per tile in a single mesh, rebuilt when the set changes. Two
// of these exist: the reachable range, and the route through it.

export interface TileOverlay {
  /** Replaces what is drawn. An empty list hides the overlay. */
  setTiles(coordinates: Coordinate[]): void;
}

export interface TileOverlayOptions {
  name: string;
  color: Color3;
  alpha: number;
  /** Draw height *above the tile's own surface*. Overlays that can share a
   *  tile must not share a height. */
  height: number;
  /** How high the ground is under a given tile. */
  surfaceAt: (coordinate: Coordinate) => number;
  gridWidth: number;
  gridHeight: number;
}

export function createTileOverlay(scene: Scene, options: TileOverlayOptions): TileOverlay {
  const { name, color, alpha, height, surfaceAt, gridWidth, gridHeight } = options;

  const mesh = new Mesh(name, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = color;
  material.emissiveColor = color;
  material.alpha = alpha;
  material.backFaceCulling = false;
  mesh.material = material;
  mesh.isVisible = false;

  return {
    setTiles(coordinates) {
      if (coordinates.length === 0) {
        mesh.isVisible = false;
        return;
      }

      const half = TILE_SIZE / 2;
      const positions: number[] = [];
      const normals: number[] = [];
      const indices: number[] = [];

      coordinates.forEach((coordinate, i) => {
        const center = tileToWorld(coordinate, gridWidth, gridHeight);
        const y = surfaceAt(coordinate) + height;
        const base = i * 4;

        // One vertex per line; flattening into a column loses the shape.
        // prettier-ignore
        positions.push(
          center.x - half, y, center.z - half,
          center.x + half, y, center.z - half,
          center.x + half, y, center.z + half,
          center.x - half, y, center.z + half,
        )
        for (let v = 0; v < 4; v++) normals.push(0, 1, 0);
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      });

      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.normals = normals;
      vertexData.indices = indices;
      vertexData.applyToMesh(mesh, true);

      mesh.isVisible = true;
    },
  };
}
