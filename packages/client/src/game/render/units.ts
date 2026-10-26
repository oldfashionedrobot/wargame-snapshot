// Side effect: installs scene.beginAnimation -- undefined at runtime without it.
import '@babylonjs/core/Animations/animatable';
import { Animation } from '@babylonjs/core/Animations/animation';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { directionBetween } from '@wargame/shared';
import type { Coordinate, Facing, PlayerColor, Unit, UnitTypeId } from '@wargame/shared';
import { tileToWorld } from './coordinates';
import { PIECE } from './figures';
import type { Figure, UnitModels } from './unitModels';

const FRAME_RATE = 60;
// One tile of walking, at FRAME_RATE. The pace every unit moves at -- there is
// no per-type speed, so this is the single dial for how long a move takes: a
// three-tile move is 3x this. 9/60 = 0.15s.
const FRAMES_PER_TILE = 9;

/**
 * How large each figure is drawn on the board, against its converted size.
 *
 * ⚠️ **Units and terrain are not in the same scale system, on purpose.** A unit
 * is a formation drawn as one figure, so there was never a size at which it and
 * a tree were both correct. A piece is sized to read on its tile; the board is
 * sized to be a board.
 *
 * ⚠️ **The model is scaled, not the unit's node**, so the health ring and the
 * charge counter hanging from the node are one size on every piece.
 *
 * The target is **height**, which is what makes a piece read over the trees it
 * stands among, capped by whatever keeps it inside its own tile. The gun reaches
 * the cap first, its depth filling the tile, and stays lower than the men.
 */
const PIECE_SCALE: Record<UnitTypeId, number> = {
  infantry: 0.85,
  cavalry: 0.72,
  artillery: 0.92,
  general: 0.72,
};

// The models face +Z, which is what north is here: tileToWorld maps a rising
// row to a rising z. So zero rotation is zero correction.
const FACING_ROTATION: Record<Facing, number> = {
  north: 0,
  east: Math.PI / 2,
  south: Math.PI,
  west: -Math.PI / 2,
};

/** A unit's figure, standing on its tile and facing its way. */
export function createPiece(
  models: UnitModels,
  unit: Unit,
  color: PlayerColor,
  surfaceAt: (coordinate: Coordinate) => number,
  gridWidth: number,
  gridHeight: number,
): Figure {
  const figure = models.instantiate(PIECE[unit.unitTypeId], color, `unit-${unit.id}`);
  // The models' origin is their base, so scaling grows a piece upward off the
  // surface it stands on rather than sinking it into one.
  figure.model.scaling.setAll(PIECE_SCALE[unit.unitTypeId]);

  const center = tileToWorld(unit.position, gridWidth, gridHeight);
  figure.node.position.set(center.x, surfaceAt(unit.position), center.z);
  setUnitFacing(figure.node, unit.facing);
  return figure;
}

/**
 * Points a unit a compass direction. The only writer of `rotation.y`, and it
 * writes it on our own node rather than the loader's `__root__` -- see
 * `unitModels.ts` for why that distinction matters.
 */
export function setUnitFacing(node: TransformNode, facing: Facing): void {
  node.rotation.y = FACING_ROTATION[facing];
}

// Exact reverse lookup, and exact is fine: `setUnitFacing` is the only writer
// of `rotation.y` and it only ever writes a value straight out of this table,
// so no arithmetic has happened to drift it.
const ROTATION_FACING = new Map<number, Facing>(
  (Object.entries(FACING_ROTATION) as [Facing, number][]).map(([facing, y]) => [y, facing]),
);

/** Which way a unit is pointing, for anything that has to put it back. */
export function getUnitFacing(node: TransformNode): Facing {
  return ROTATION_FACING.get(node.rotation.y) ?? 'north';
}

function animateSegment(mesh: TransformNode, scene: Scene, target: Vector3): Promise<void> {
  return new Promise((resolve) => {
    const positionAnimation = new Animation(
      'unit-move',
      'position',
      FRAME_RATE,
      Animation.ANIMATIONTYPE_VECTOR3,
      Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    positionAnimation.setKeys([
      { frame: 0, value: mesh.position.clone() },
      { frame: FRAMES_PER_TILE, value: target },
    ]);
    mesh.animations = [positionAnimation];
    scene.beginAnimation(mesh, 0, FRAMES_PER_TILE, false, 1, () => resolve());
  });
}

/** Walks a unit tile by tile along `path`, its figure walking as it goes. */
export async function animateUnitAlongPath(
  figure: Figure,
  path: Coordinate[],
  surfaceAt: (coordinate: Coordinate) => number,
  gridWidth: number,
  gridHeight: number,
  scene: Scene,
): Promise<void> {
  const mesh = figure.node;
  figure.play('walk');
  for (const [index, coordinate] of path.slice(1).entries()) {
    // Turn before the step, so the unit walks the way it is looking rather
    // than arriving and rotating. A snapped turn is deliberate: interpolating
    // it costs a tween per corner for something read at a glance.
    const heading = directionBetween(path[index], coordinate);
    if (heading) setUnitFacing(mesh, heading);

    const target = tileToWorld(coordinate, gridWidth, gridHeight);
    // Carried between surfaces rather than pinned, so a unit is seen to climb
    // onto a plateau or step up onto a bridge instead of gliding through it.
    target.y = surfaceAt(coordinate);
    await animateSegment(mesh, scene, target);
  }
}
