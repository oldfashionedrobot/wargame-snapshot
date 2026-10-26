import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import type { Scene } from '@babylonjs/core/scene';
import { tileToWorld, TILE_SIZE } from './coordinates';

const LINE_HEIGHT = 0.012;

/**
 * A mid grey, faintly: the eye finds a boundary when it goes looking for one
 * and otherwise sees terrain, which is the whole job of a grid here.
 *
 * ⚠️ **The alpha lives in this `Color4`, and `useVertexAlpha` below is what
 * makes it do anything.** Passing `colors` to `CreateLineSystem` turns on
 * vertex colouring, after which `LinesMesh.alpha` is ignored -- the fragment
 * comes from the vertex colour. And vertex *alpha* stays off unless asked for,
 * so until it was asked for, every line drew fully opaque whatever either
 * number said.
 *
 * ⚠️ Which means the tuning this comment used to describe never happened.
 * Near-black at 35%, white at 10%, grey at 7% -- all three rendered identically
 * opaque, and only the RGB was ever really being chosen. Treat the value below
 * as the first one anybody has actually seen.
 */
const LINE_COLOR = new Color4(0.36, 0.36, 0.36, 0.25);

/**
 * ⚠️ Deliberately 1, and not the knob. `LinesMesh.alpha` does nothing while
 * vertex colouring is on; it is left at its no-op value rather than deleted,
 * because a mesh alpha that silently loses to the vertex colour is exactly the
 * trap this file already fell into once.
 */
const LINE_ALPHA = 1;

/**
 * One flat grid across the whole board, at the height of the ground.
 *
 * ⚠️ This was briefly a square per tile at each tile's *own* surface, because a
 * raised tile would otherwise have the line running through it. That is no
 * longer a case that arises: hills are a mesa standing on an ordinary tile,
 * so the **ground is flat everywhere** and only props rise above it. The grid
 * marks the board's floor, and the floor is one plane.
 *
 * Flat also means long spans rather than per-tile outlines, which means every
 * interior edge is drawn **once** instead of by both of its tiles — so the
 * alpha is the alpha, rather than roughly double it over the interior.
 *
 * Nothing here touches the overlays. A hover or range tint sits at
 * `surfaceAt`, which is the top of whatever you would stand on, so hovering a
 * mesa lights the mesa rather than the floor hidden underneath it.
 */
export function createGridLines(
  scene: Scene,
  groundLevel: number,
  gridWidth: number,
  gridHeight: number,
): LinesMesh {
  const half = TILE_SIZE / 2;
  const y = groundLevel + LINE_HEIGHT;

  const southWest = tileToWorld({ col: 0, row: 0 }, gridWidth, gridHeight);
  const northEast = tileToWorld({ col: gridWidth - 1, row: gridHeight - 1 }, gridWidth, gridHeight);
  const minX = southWest.x - half;
  const maxX = northEast.x + half;
  const minZ = southWest.z - half;
  const maxZ = northEast.z + half;

  const lines: Vector3[][] = [];
  for (let col = 0; col <= gridWidth; col++) {
    const x = minX + col * TILE_SIZE;
    lines.push([new Vector3(x, y, minZ), new Vector3(x, y, maxZ)]);
  }
  for (let row = 0; row <= gridHeight; row++) {
    const z = minZ + row * TILE_SIZE;
    lines.push([new Vector3(minX, y, z), new Vector3(maxX, y, z)]);
  }

  const colors = lines.map((line) => line.map(() => LINE_COLOR));
  // ⚠️ `useVertexAlpha` is not optional decoration: without it the alpha in
  // `LINE_COLOR` is dropped and every line draws opaque. See the note above.
  const gridLines = CreateLineSystem('grid-lines', { lines, colors, useVertexAlpha: true }, scene);
  gridLines.alpha = LINE_ALPHA;
  gridLines.isPickable = false; // picking is plane arithmetic, never a ray at a mesh
  return gridLines;
}
