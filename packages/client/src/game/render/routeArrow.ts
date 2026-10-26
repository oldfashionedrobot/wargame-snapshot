import { Constants } from '@babylonjs/core/Engines/constants';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import type { Coordinate } from '@wargame/shared';
import { TILE_SIZE, tileToWorld } from './coordinates';

// The pinned route, drawn the way Advance Wars draws one: a line with a head on
// it. A tint says *these tiles*; an arrow says *this way, ending here*.
//
// One merged mesh of per-tile quads, exactly like `tileOverlay.ts` -- the only
// addition is UVs, and ⚠️ **orientation is a cyclic shift of the four UV
// corners** rather than a per-tile transform, so every quad stays axis-aligned
// and the draw-call story is unchanged.

export interface RouteArrow {
  /** Replaces what is drawn. Fewer than two tiles hides it. */
  setPath(path: Coordinate[]): void;
}

// N E S W, and the order is load-bearing: a rotation is `+1` around this ring,
// which is what makes orientation arithmetic rather than a lookup table.
const NORTH = 0;
const EAST = 1;
const SOUTH = 2;
const WEST = 3;

// Atlas cells, in the 2x2 grid drawn below.
export const TAIL = 0;
export const STRAIGHT = 1;
export const CORNER = 2;
export const HEAD = 3;

const CELL = 128;
const ATLAS = CELL * 2;

/**
 * Which way `to` lies from `from`, as a ring index.
 *
 * ⚠️ Row increases **north** and col increases **east**, matching `tileToWorld`
 * and the deployment the maps are asserted against. Steps are always one tile
 * and always orthogonal, so the first matching test is the answer.
 */
function directionTo(from: Coordinate, to: Coordinate): number {
  if (to.row > from.row) return NORTH;
  if (to.row < from.row) return SOUTH;
  return to.col > from.col ? EAST : WEST;
}

/**
 * The piece a tile needs, and how far to turn it.
 *
 * ⚠️ Exported for its tests. This is the only part of the module that decides
 * anything -- the rest is vertices -- and `composeTerrain` sets the precedent:
 * the pure piece of a renderer module is tested like any other pure module,
 * because a browser can only tell you that *something* looks wrong.
 *
 * A path never branches, so a tile connects to one neighbour or two -- never
 * three. That is the whole reason four shapes cover every case.
 */
export function pieceFor(path: Coordinate[], i: number): { cell: number; rotation: number } {
  const toPrev = i > 0 ? directionTo(path[i], path[i - 1]) : null;
  const toNext = i < path.length - 1 ? directionTo(path[i], path[i + 1]) : null;

  // The start: a stub, pointing the way the route leaves.
  if (toPrev === null) return { cell: TAIL, rotation: toNext ?? NORTH };

  // The end: the head points the way it was travelling, which is away from the
  // tile it came from.
  if (toNext === null) return { cell: HEAD, rotation: (toPrev + 2) % 4 };

  // Straight through. Symmetric, so either direction rotates it correctly.
  if (toPrev === (toNext + 2) % 4) return { cell: STRAIGHT, rotation: toNext };

  // A bend. Canonical connects {SOUTH, EAST}; rotating that ring by `r` gives
  // {(SOUTH+r), (EAST+r)}, and the four rotations cover all four bends. Only
  // the *pair* matters -- a bend has no direction, so there is no mirrored
  // twin to disambiguate.
  for (let r = 0; r < 4; r++) {
    const a = (SOUTH + r) % 4;
    const b = (EAST + r) % 4;
    if ((toPrev === a && toNext === b) || (toPrev === b && toNext === a)) {
      return { cell: CORNER, rotation: r };
    }
  }
  return { cell: STRAIGHT, rotation: toNext }; // unreachable: the four bends are exhaustive
}

/**
 * The four shapes, drawn once into a texture at startup.
 *
 * No asset file and no pipeline: they are strokes, and a stroke is cheaper to
 * describe in code than to load. Everything is white -- the colour lives on the
 * material, so it stays one tunable constant rather than being baked in here.
 */
function drawAtlas(texture: DynamicTexture): void {
  const ctx = texture.getContext();
  const mid = CELL / 2;
  const width = CELL * 0.3;

  ctx.clearRect(0, 0, ATLAS, ATLAS);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = width;
  // ⚠️ No `lineCap`: Babylon's context type does not expose it, and the default
  // `butt` is what this wants anyway -- a flush end is what lets one tile's
  // segment meet the next one's without a seam or a bulge.
  ctx.lineJoin = 'round';

  // ⚠️ Canvas y grows downward and `DynamicTexture` inverts it, so *up here is
  // north*. Every canonical piece below is drawn travelling north.
  const cell = (index: number): { x: number; y: number } => ({
    x: (index % 2) * CELL,
    y: Math.floor(index / 2) * CELL,
  });

  // Tail: a rounded stub at the centre, running out of the north edge.
  const tail = cell(TAIL);
  ctx.beginPath();
  ctx.arc(tail.x + mid, tail.y + mid, width / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(tail.x + mid, tail.y + mid);
  ctx.lineTo(tail.x + mid, tail.y);
  ctx.stroke();

  // Straight: edge to edge.
  const straight = cell(STRAIGHT);
  ctx.beginPath();
  ctx.moveTo(straight.x + mid, straight.y + CELL);
  ctx.lineTo(straight.x + mid, straight.y);
  ctx.stroke();

  // Corner: in from the south edge, out through the east.
  const corner = cell(CORNER);
  ctx.beginPath();
  ctx.moveTo(corner.x + mid, corner.y + CELL);
  ctx.lineTo(corner.x + mid, corner.y + mid);
  ctx.lineTo(corner.x + CELL, corner.y + mid);
  ctx.stroke();

  // Head: in from the south edge, ending in a triangle that fills the tile's
  // northern half.
  const head = cell(HEAD);
  const tip = head.y + CELL * 0.12;
  const base = head.y + CELL * 0.55;
  ctx.beginPath();
  ctx.moveTo(head.x + mid, head.y + CELL);
  ctx.lineTo(head.x + mid, base);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(head.x + mid, tip);
  ctx.lineTo(head.x + CELL * 0.82, base);
  ctx.lineTo(head.x + CELL * 0.18, base);
  ctx.closePath();
  ctx.fill();

  texture.update();
}

export interface RouteArrowOptions {
  name: string;
  color: Color3;
  alpha: number;
  /** Draw height *above the tile's own surface*, as `tileOverlay` uses it. */
  height: number;
  /** After the board's and before the units'. */
  renderingGroupId: number;
  surfaceAt: (coordinate: Coordinate) => number;
  gridWidth: number;
  gridHeight: number;
}

export function createRouteArrow(scene: Scene, options: RouteArrowOptions): RouteArrow {
  const { name, color, alpha, height, renderingGroupId, surfaceAt, gridWidth, gridHeight } =
    options;

  const texture = new DynamicTexture(`${name}-atlas`, { width: ATLAS, height: ATLAS }, scene);
  drawAtlas(texture);

  const material = new StandardMaterial(`${name}-material`, scene);
  // The shapes carry transparency, the material carries the colour: that keeps
  // the arrow tunable from one constant instead of a redraw.
  material.opacityTexture = texture;
  material.emissiveColor = color;
  material.diffuseColor = Color3.Black();
  material.disableLighting = true;
  material.alpha = alpha;
  material.backFaceCulling = false;
  // ⚠️ Over the board whatever stands on it: a route through a wood is still a
  // route, and drawn among the trees it showed nothing but its head. Writing no
  // depth is what lets the units drawn after it stand on it.
  material.depthFunction = Constants.ALWAYS;
  material.disableDepthWrite = true;

  const mesh = new Mesh(name, scene);
  mesh.material = material;
  mesh.isVisible = false;
  mesh.renderingGroupId = renderingGroupId;

  return {
    setPath(path) {
      // ⚠️ A single tile is *standing still*, which AW draws nothing for either
      // -- so the case that looks like it needs a fifth shape needs none.
      if (path.length < 2) {
        mesh.isVisible = false;
        return;
      }

      const half = TILE_SIZE / 2;
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      path.forEach((coordinate, i) => {
        const centre = tileToWorld(coordinate, gridWidth, gridHeight);
        const y = surfaceAt(coordinate) + height;
        const base = i * 4;

        // Vertices run SW, SE, NE, NW -- the same winding `tileOverlay` uses.
        // prettier-ignore
        positions.push(
          centre.x - half, y, centre.z - half,
          centre.x + half, y, centre.z - half,
          centre.x + half, y, centre.z + half,
          centre.x - half, y, centre.z + half,
        )
        for (let v = 0; v < 4; v++) normals.push(0, 1, 0);

        const { cell, rotation } = pieceFor(path, i);
        const u0 = (cell % 2) * 0.5;
        const v0 = (1 - Math.floor(cell / 2)) * 0.5; // v grows north, rows grow down
        // The cell's corners in the same SW, SE, NE, NW order as the vertices.
        // Rotating the piece is shifting which corner each vertex samples.
        const corners: Array<[number, number]> = [
          [u0, v0],
          [u0 + 0.5, v0],
          [u0 + 0.5, v0 + 0.5],
          [u0, v0 + 0.5],
        ];
        for (let v = 0; v < 4; v++) {
          const [u, w] = corners[(v + rotation) % 4];
          uvs.push(u, w);
        }

        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      });

      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.normals = normals;
      vertexData.uvs = uvs;
      vertexData.indices = indices;
      vertexData.applyToMesh(mesh, true);

      mesh.isVisible = true;
    },
  };
}
