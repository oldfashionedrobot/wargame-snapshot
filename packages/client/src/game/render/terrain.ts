import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';
import type { Scene } from '@babylonjs/core/scene';

import { tileToWorld } from './coordinates';
import { QUARTER_TURN } from './composeTerrain';
import type { TerrainCell } from './composeTerrain';
import type { TerrainModels } from './terrainModels';

// Height here is a *look*, never data: the map carries no elevation and
// climbing costs nothing extra. Picking is not what limits it -- screenToTile
// tries every surface height the board has, so a click finds a peak where it is
// drawn. `MAX_STAND_HEIGHT` is what limits it, and for a different reason: past
// about half a tile a raised surface draws far enough up-screen to occupy its
// neighbour.

/**
 * Builds the board out of models, then merges what it built.
 *
 * Merging rather than instancing because terrain is made once and never moves,
 * which is the case merging is for: grouping every tile's meshes by material
 * leaves about fourteen draw calls for a whole board, against hundreds as loose
 * copies. ⚠️ That count follows the *palette*, not the board -- it was eight
 * before scenery, a mesa and six kinds of tree brought colours of their own. At
 * this size any approach would do; this is the simplest that is also fastest.
 */
export function createTerrainMesh(
  scene: Scene,
  models: TerrainModels,
  cells: TerrainCell[][],
): Mesh {
  // ⚠️ Sized from `cells` and not from the grid it was composed out of. Taking
  // the bounds from one and indexing the other is a hazard for nothing: they
  // agree today only because nobody has passed a mismatched pair, and the
  // failure would be reading `undefined.ground` rather than anything legible.
  const gridHeight = cells.length;
  const gridWidth = cells[0]?.length ?? 0;

  const built: AbstractMesh[] = [];

  for (let row = 0; row < gridHeight; row++) {
    for (let col = 0; col < gridWidth; col++) {
      const cell = cells[row][col];
      const center = tileToWorld({ col, row }, gridWidth, gridHeight);

      const ground = models.instantiate(cell.ground, `tile-${col}-${row}`, cell.paint);
      ground.position.set(center.x, 0, center.z);
      ground.rotation.y = cell.turns * QUARTER_TURN;
      built.push(...ground.getChildMeshes());

      // Placement is entirely the tiler's call -- this only obeys it. Sat on
      // whatever the ground turned out to be, so a tree stands on the grass
      // rather than sunk into it.
      cell.props.forEach((prop, i) => {
        const node = models.instantiate(prop.model, `prop-${col}-${row}-${i}`);
        node.position.set(center.x + prop.x, models.topOf(cell.ground), center.z + prop.z);
        node.rotation.y = prop.rotation;
        // ⚠️ Local z, so it is applied before `rotation.y` and squeezes the
        // prop across its own width rather than across the board's.
        node.scaling.set(prop.scale, prop.scale, prop.scale * (prop.squeeze ?? 1));
        built.push(...node.getChildMeshes());
      });
    }
  }

  return mergeByMaterial(scene, built);
}

/**
 * One mesh per material, with the loose copies disposed.
 *
 * Leans on `terrainModels` having already shared materials by name: without
 * that, every file would contribute its own `grass` and this would group by
 * nothing.
 */
function mergeByMaterial(scene: Scene, meshes: AbstractMesh[]): Mesh {
  const groups = new Map<string, Mesh[]>();
  const materials = new Map<string, Material>();
  for (const mesh of meshes) {
    // The loader hangs an empty node above each model to carry the handedness
    // conversion, and it comes back from getChildMeshes with no vertices at
    // all. Merging one throws rather than ignoring it.
    if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
    const key = mesh.material?.name ?? 'none';
    if (mesh.material) materials.set(key, mesh.material);
    const group = groups.get(key);
    if (group) group.push(mesh);
    else groups.set(key, [mesh]);
  }

  const board = new Mesh('terrain', scene);
  for (const [name, group] of groups) {
    // Merging bakes each copy's world transform into its vertices, which is
    // what lets one mesh hold tiles that were rotated differently.
    // ⚠️ **A group of one comes back inside out.** The loader mirrors every
    // model, and Babylon rewinds a mirrored mesh's faces as it merges -- except
    // when there is nothing to merge it with, where it bakes the mirror and
    // skips the rewind, so the faces are culled from the side they face. A
    // one-tile board is mostly groups of one.
    const mirrored = group.length === 1 && group[0].computeWorldMatrix(true).determinant() < 0;
    const merged = Mesh.MergeMeshes(group, true, true);
    if (!merged) continue;
    if (mirrored) {
      // Rewound on a copy, never with `flipFaces`: that case also hands back
      // the model's own index array, and rewinding it in place turns every
      // later copy of the model inside out instead.
      const indices = merged.getIndices(false, true) ?? [];
      for (let i = 0; i < indices.length; i += 3) {
        [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      }
      merged.setIndices(indices);
    }
    merged.name = name; // already `terrain-<material>`, from terrainModels
    // Re-applied by hand: the sources are disposed as part of merging, and the
    // merged mesh does not reliably inherit their material -- which shows up as
    // a board that has exactly the right shape and no colour at all.
    const material = materials.get(name);
    if (material) merged.material = material;
    merged.parent = board;
    merged.isPickable = false; // picking is plane arithmetic, never a ray at a mesh
  }
  return board;
}
