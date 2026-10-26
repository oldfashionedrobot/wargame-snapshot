// Side effect: installs scene.createPickingRay (and scene.pick, which the
// pointer observable's PICK events use) -- undefined at runtime without it.
import '@babylonjs/core/Culling/ray';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { Scene } from '@babylonjs/core/scene';
import { isWithinGrid } from '@wargame/shared';
import type { Coordinate } from '@wargame/shared';

import { worldToTile } from './coordinates';

/**
 * Which tile is under a point on screen.
 *
 * Still plane arithmetic rather than mesh-picking -- tile lookup stays
 * independent of what is actually drawn, and Babylon's picking performance
 * gates stay out of it. What changed is that there is no longer **one** plane.
 *
 * ⚠️ A single plane at `y = 0` is only right for a flat board. Raise a tile and
 * it draws up-screen of where it sits, so a click on a peak lands on the tile
 * *behind* it -- which is why height used to be capped at a quarter of a tile.
 * Instead this tries each distinct surface height the board has, **tallest
 * first**, and takes the first answer that agrees with itself: the tile found
 * at height `h` must actually be a tile whose surface is at `h`. Tallest first
 * is what makes a peak win over the plains it occludes, which is the same order
 * the renderer draws them in.
 *
 * Cheap because a board has two or three distinct heights, not hundreds.
 *
 * Clicking the *side* of a raised tile agrees with nothing -- the cliff face
 * belongs to a surface that is neither its top nor the ground -- so the flat
 * answer is kept as a fallback and returned when no level is consistent. That
 * is exactly what this did before, for every click.
 */
export function screenToTile(
  scene: Scene,
  camera: Camera,
  screenX: number,
  screenY: number,
  gridWidth: number,
  gridHeight: number,
  surfaceAt: (coordinate: Coordinate) => number,
  levels: readonly number[],
): Coordinate | null {
  const ray = scene.createPickingRay(screenX, screenY, Matrix.Identity(), camera);
  if (Math.abs(ray.direction.y) < 1e-6) return null;

  let fallback: Coordinate | null = null;

  for (const level of levels) {
    const distance = (level - ray.origin.y) / ray.direction.y;
    if (distance < 0) continue;

    const coordinate = worldToTile(
      ray.origin.x + ray.direction.x * distance,
      ray.origin.z + ray.direction.z * distance,
      gridWidth,
      gridHeight,
    );
    // Levels arrive tallest first, so the last one standing is the flattest
    // reading -- the answer a single ground plane would have given, including
    // *no tile* for a pointer past the board's edge, where the frame draws land.
    if (!isWithinGrid(coordinate, gridWidth, gridHeight)) {
      fallback = null;
      continue;
    }

    if (surfaceAt(coordinate) === level) return coordinate;
    fallback = coordinate;
  }

  return fallback;
}
