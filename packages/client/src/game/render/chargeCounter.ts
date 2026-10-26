import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';

// How close a unit is to a charge: its charge meter as a small number beside
// it, counting up, then a disc of its own once the meter is full, and nothing
// at 0. A unit that cannot charge never leaves 0, so it never shows one.
//
// ⚠️ **The ready disc is not the next digit**, because sizes differ by type: a
// digit is a different distance from a charge on each, and *ready* has to read
// the same on all of them.
//
// ⚠️ **A number, not a ring.** Three segments around the health ring were the
// first idea, and there is no room for them: infantry's ring already reaches
// most of the way to its tile's edge.

// In tiles, like the health ring, and for the same reason.
const SIZE = 0.3;
/** Beside the figure rather than over it: right on screen, and off the ground. */
const BESIDE = 0.42;
const UP = 0.45;

/** Drawn at this many pixels square; it is a digit on a disc, so small is fine. */
const TEXTURE = 64;
const DISC = '#1c1f2b';
const EDGE = '#c03a3a';
const INK = '#ffffff';
const FONT = 38;

export interface ChargeCounter {
  /** Shows `meter`, or the ready disc once `ready`, and nothing at 0. */
  setMeter(meter: number, ready: boolean): void;
}

/** What a counter's disc shows: its text, fill and ring, and its cache name. */
interface Face {
  name: string;
  text: string;
  fill: string;
  ring: string;
}

const digitFace = (digit: number): Face => ({
  name: `charge-counter-${digit}`,
  text: String(digit),
  fill: DISC,
  ring: EDGE,
});

/** Inverted, so *ready* stands apart from the count at a glance. */
const READY: Face = { name: 'charge-counter-ready', text: '!', fill: EDGE, ring: INK };

/**
 * One material per face, cached on the scene by name.
 *
 * ⚠️ The health ring's arrangement and its hazard: whatever disposes a counter
 * must not take the material with it. Counters are children of unit nodes, and
 * a figure disposes its node with `disposeMaterialAndTextures: false`.
 */
function faceMaterial(scene: Scene, { name, text, fill, ring }: Face): StandardMaterial {
  const existing = scene.getMaterialByName(name);
  if (existing) return existing as StandardMaterial;

  const texture = new DynamicTexture(name, { width: TEXTURE, height: TEXTURE }, scene, true);
  const context = texture.getContext();
  const middle = TEXTURE / 2;
  context.clearRect(0, 0, TEXTURE, TEXTURE);
  context.beginPath();
  context.arc(middle, middle, middle - 4, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = ring;
  context.stroke();
  texture.hasAlpha = true;
  // Null placement centres it both ways, and this also uploads the canvas.
  // ⚠️ A whole pixel size: `drawText` reads the size back out of the font by
  // dropping every non-digit, so a fractional one lands the digit off the disc.
  texture.drawText(text, null, null, `bold ${FONT}px sans-serif`, INK, null);

  // Unlit, so the number reads the same under every light on the board.
  const material = new StandardMaterial(name, scene);
  material.emissiveTexture = texture;
  material.opacityTexture = texture;
  material.diffuseColor = Color3.Black();
  material.disableLighting = true;
  return material;
}

/**
 * Attaches a counter to a unit's node.
 *
 * ⚠️ **Parented, so it rides the walk animation for free**, and billboarded,
 * which in Babylon keeps the parent's position and scale but not its turn. So
 * the counter faces the camera, and the plane's own offset -- baked into it,
 * sideways in the plane -- puts it to the figure's right on screen whichever
 * way the unit looks.
 */
export function createChargeCounter(scene: Scene, parent: TransformNode): ChargeCounter {
  const mesh = CreatePlane('charge-counter', { size: SIZE }, scene);
  mesh.bakeTransformIntoVertices(Matrix.Translation(BESIDE, 0, 0));
  mesh.position.y = UP;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.parent = parent;
  mesh.isPickable = false; // picking is plane arithmetic, never a ray at a mesh
  mesh.isVisible = false;

  return {
    setMeter(meter, ready) {
      if (!ready && meter <= 0) {
        mesh.isVisible = false;
        return;
      }
      mesh.material = faceMaterial(scene, ready ? READY : digitFace(meter));
      mesh.isVisible = true;
    },
  };
}
