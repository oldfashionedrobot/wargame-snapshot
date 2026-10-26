import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { band, BANDS } from '@wargame/shared';

// How hurt a unit is, read at a glance: a ring of ten segments at its base,
// extinguishing as it weakens and absent entirely at full strength.
//
// ⚠️ **Ten segments because the formula reads ten bands.** `computeDamage` uses
// `ceil(health / 10)`, so 91 and 100 fight identically -- a bar drawn from raw
// health would show two different states that behave the same. Ten segments for
// ten bands means the display *cannot* promise precision the rules do not have.
// The exact figure belongs to a selected-unit panel, later.
//
// ⚠️ Segments extinguish rather than dim. Bands are discrete, and a fade would
// imply a continuum that is not there.

// ⚠️ **The rulebook's own count, not a matching constant.** This file used to
// compute `ceil(health / (MAX_HEALTH / SEGMENTS))` with its own `SEGMENTS = 10`,
// which made "one segment per band" a coincidence that held as long as two
// numbers in two packages happened to agree. `band` is what `computeDamage`
// reads, so the display now cannot drift from the arithmetic it describes.
const SEGMENTS = BANDS;
/** Of each segment's 36 degrees, how much is drawn -- the rest is the gap. */
const FILL = 0.78;
// In tiles, and the same on every piece: `PIECE_SCALE` sizes a unit's model,
// never the node the ring hangs from.
const OUTER = 0.435;
const INNER = 0.315;
const HEIGHT = 0.045;

/**
 * ⚠️ **Deliberately not in the amber family.** `SELECTED_COLOR` is
 * `(1, 0.85, 0.1)` and `FACING_COLOR` `(1, 0.82, 0.35)` -- a health ring in that
 * range was tried and read as another selection tint sitting under the piece.
 * Orange-red is unused by the palette, says *damage* without reaching for the
 * red player's own colour, and survives being a thin ring on teal ground.
 */
const COLOR = new Color3(1, 0.42, 0.28);
const ALPHA = 0.95;

export interface HealthRing {
  /** Redraws for `health`, or hides the ring when nothing is missing. */
  setHealth(health: number): void;
}

/**
 * One material for every ring, cached on the scene by name.
 *
 * ⚠️ Whatever disposes a ring must not take the material with it, or every
 * other ring goes with it. Rings are children of unit nodes, and a figure
 * disposes its node with `disposeMaterialAndTextures: false`, which is what
 * keeps that safe.
 */
function ringMaterial(scene: Scene): StandardMaterial {
  const name = 'health-ring';
  const existing = scene.getMaterialByName(name);
  if (existing) return existing as StandardMaterial;

  const material = new StandardMaterial(name, scene);
  material.emissiveColor = COLOR;
  material.diffuseColor = Color3.Black();
  material.disableLighting = true;
  material.alpha = ALPHA;
  material.backFaceCulling = false;
  return material;
}

/**
 * Attaches a ring to a unit's node.
 *
 * ⚠️ **Parented, so it rides the walk animation for free** -- position lives on
 * that node and the ring inherits it. It therefore also turns with the unit.
 * Accepted: a ring is rotationally symmetric, so only the segment boundaries
 * move. Fixing it properly means separating position from rotation, which the
 * loader's `__root__` makes a three-node job rather than a two-node one.
 */
export function createHealthRing(scene: Scene, parent: TransformNode): HealthRing {
  const mesh = new Mesh('health-ring', scene);
  mesh.material = ringMaterial(scene);
  mesh.parent = parent;
  mesh.isPickable = false; // picking is plane arithmetic, never a ray at a mesh
  mesh.isVisible = false;

  return {
    setHealth(health) {
      const lit = band(Math.max(0, health));

      // ⚠️ Nothing missing, nothing drawn. A ring under every unit at full
      // strength is noise on a board where most units are untouched.
      if (lit >= SEGMENTS || lit <= 0) {
        mesh.isVisible = false;
        return;
      }

      const positions: number[] = [];
      const normals: number[] = [];
      const indices: number[] = [];

      for (let i = 0; i < lit; i++) {
        const step = (Math.PI * 2) / SEGMENTS;
        const from = i * step;
        const to = from + step * FILL;
        const base = i * 4;

        // An annular wedge: inner and outer arc ends, flat in the XZ plane.
        // prettier-ignore
        positions.push(
          INNER * Math.cos(from), HEIGHT, INNER * Math.sin(from),
          OUTER * Math.cos(from), HEIGHT, OUTER * Math.sin(from),
          OUTER * Math.cos(to),   HEIGHT, OUTER * Math.sin(to),
          INNER * Math.cos(to),   HEIGHT, INNER * Math.sin(to),
        )
        for (let v = 0; v < 4; v++) normals.push(0, 1, 0);
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }

      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.normals = normals;
      vertexData.indices = indices;
      vertexData.applyToMesh(mesh, true);

      mesh.isVisible = true;
    },
  };
}
