import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { FACINGS } from '@wargame/shared';
import type { Facing, PlayerColor, TileType } from '@wargame/shared';

import { BAND, bandRect } from './band';
import type { BandRect } from './band';
import { everyFrame } from './clock';
import { seeded, standHeight, standingOn } from './composeTerrain';
import type { TerrainCell } from './composeTerrain';
import { BEATS, ONCE, STAGE } from './cutawayPlan';
import type { Beat, Cue, Plan, Side } from './cutawayPlan';
import { BODY } from './figures';
import type { Role } from './figures';
import type { TerrainModel, TerrainModels } from './terrainModels';
import { setUnitFacing } from './units';
import type { Figure, UnitModels } from './unitModels';

/**
 * Where the stage is built -- the seam between its two grounds -- far enough
 * from the board that neither camera can see the other's world.
 */
const SEAM = new Vector3(650, 0, 0);

/** Each side's ground, from the seam outward, and across the line. */
const GROUND_LENGTH = 18;
const GROUND_DEPTH = 16;

/**
 * What a unit stands on -- a hill's rock, a bridge's deck -- laid
 * across the line under its ensemble, from the seam out, stretched wide and
 * deep but no taller than `RISE` says.
 */
const FOOTING_DEPTH = 6.5;

/**
 * How much taller a footing stands than on the board. ⚠️ A hill's rock at its
 * own height is half a man and its sides thin bands, which read as a path round
 * a field rather than ground anyone climbed; raised, they read as a rise.
 */
const RISE: Partial<Record<TerrainModel, number>> = { rock_largeF: 2.4 };

/** How far below the water a unit in a river stands: about to a man's knee. */
const WADE = 0.3;

/** A road under the line, a few men wide. */
const ROAD_WIDTH = 3.4;

/** How far across the stage a line reaches from its middle, kept clear of scenery. */
const LINE = 1.7;

/** A village's street: how far its houses stand back from the line, and apart. */
const STREET = 0.5;
const HOUSE_GAP = 0.3;

/**
 * How much bigger a figure is drawn in the cutaway than its men would make it.
 * The gun at true size is a toy among its crew.
 */
const ENLARGE: Partial<Record<Role, number>> = { gun: 1.4 };

/**
 * Each kind of figure's size -- along the stage, across it, and up to the top
 * of a raised musket, sabre or flag -- for framing what is on the stage, before
 * `ENLARGE`.
 */
const SIZE: Record<Role, { long: number; wide: number; tall: number }> = {
  infantry: { long: 0.5, wide: 0.5, tall: 1.2 },
  gunner: { long: 0.5, wide: 0.5, tall: 1.2 },
  crew: { long: 0.5, wide: 0.5, tall: 1.05 },
  cavalry: { long: 1.4, wide: 0.6, tall: 1.9 },
  general: { long: 1.4, wide: 0.6, tall: 2.0 },
  gun: { long: 1.1, wide: 0.6, tall: 0.65 },
};

/** Air around what is framed, as a share of it. */
const MARGIN = 0.05;

/**
 * ⚠️ **Every line slants the same way across the screen**, by this much along
 * the stage for each unit across it. A rank runs straight away from a camera
 * square to the battle, and five men one behind another read as a column;
 * slanted, the line lies across the screen and every man shows. The same way
 * on both sides, so two lines that meet meet along their length.
 */
const SLANT = 0.55;

/**
 * ⚠️ Shallower than the board's camera, and deliberately: the board is read
 * from above because it is a map, a battle from nearer eye level because it is
 * figures -- though high enough to see over a line into the one behind.
 */
const STAGE_BETA = Math.PI / 3;

/** Dark enough to read as "the board is not what you are looking at". */
const BACKDROP = new Color3(0.09, 0.1, 0.14);
/** Behind the whole stage along the line of sight, so it never cuts the ground. */
const BACKDROP_DEPTH = 60;

/**
 * Scenery at its true size beside a man, rather than at the board's: a tree
 * four men tall or so, a tuft at the knee -- and as much of it as a tile's
 * kind of ground carries over the larger ground.
 */
const TREE_SIZE = 1.6;
const DOODAD_SIZE = 1.1;
const SCENERY: Record<TileType, { trees: number; doodads: number }> = {
  plains: { trees: 0, doodads: 12 },
  road: { trees: 0, doodads: 8 },
  forest: { trees: 7, doodads: 6 },
  hills: { trees: 0, doodads: 6 },
  structure: { trees: 0, doodads: 0 },
  bridge: { trees: 0, doodads: 0 },
  river: { trees: 0, doodads: 0 },
  sea: { trees: 0, doodads: 0 },
};
/**
 * What of a half the camera sees, from the seam out past the line's far rank,
 * and from behind the line to in front of it: where scenery is placed, since
 * the frame holds the figures and little more.
 */
const SEEN = { out: STAGE.home + 2.8, back: -3.4, front: 2.8 };

const TREES: TerrainModel[] = ['tree_default', 'tree_oak', 'tree_tall', 'tree_fat', 'tree_thin'];
const DOODADS: TerrainModel[] = [
  'grass',
  'grass_large',
  'grass_leafs',
  'plant_bushSmall',
  'flower_purpleA',
];

/** Places one terrain model on a side's half, at `x` from the seam. */
type Piece = (
  model: TerrainModel,
  name: string,
  x: number,
  y?: number,
  z?: number,
) => TransformNode;

/** What the stage needs of one side, besides its part in the plan. */
export interface Combatant {
  color: PlayerColor;
  /**
   * How it faces as it stands on the board, in quarter turns clockwise from
   * facing the enemy: 0 square on, 2 with its back turned, 1 or 3 flank on.
   */
  turned: number;
  terrain: TileType;
  /** The cell it stands on, taken from the board's own composition. */
  cell: TerrainCell;
}

export interface Cutaway {
  /**
   * Stages a battle's plan, plays it through and takes it down, resolving when
   * it closes. `layout` hears where the band is, at once and again whenever the
   * canvas changes size, so the page can frame it.
   */
  play(
    plan: Plan,
    attacker: Combatant,
    defender: Combatant,
    layout: (rect: BandRect) => void,
  ): Promise<void>;
}

/**
 * The battle, staged: both units as ensembles on one continuous ground, drawn
 * in a band over the board.
 *
 * ⚠️ **One camera over one ground.** The attacker's half is on the left, the
 * defender's on the right, the seam between them at the middle of the band, so
 * a charge runs from one half into the other. The camera looks back along
 * -z, so screen-left is east: the attacker stands east of the seam and faces
 * west.
 *
 * ⚠️ **A second camera, not a second scene and not the board's camera moved.**
 * A second scene would load every model again; moving the board's camera would
 * fight its locked radius, its clamped tilt and `holdTheBoard`, then have to
 * restore all three. ⚠️ **And the board's camera never gets a viewport**:
 * `holdTheBoard` sizes it from the whole canvas every frame. This one draws over
 * it instead.
 *
 * ⚠️ **Built per battle and torn down after**, rather than pooled: a figure is a
 * millisecond to build and half a megabyte to hold, so a battle's few dozen cost
 * a frame or two as it opens and nothing once it closes.
 */
export function createCutaway(
  scene: Scene,
  unitModels: UnitModels,
  terrainModels: TerrainModels,
  boardCamera: Camera,
): Cutaway {
  // From +z, where `setUnitFacing`'s north points, square to the battle.
  const camera = new ArcRotateCamera('cutaway', Math.PI / 2, STAGE_BETA, 40, SEAM.clone(), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  // ⚠️ No `attachControl`: nobody drives this camera, and attaching would put two
  // controllers on one canvas.

  // ⚠️ **A backdrop, or the board shows through** and the battle reads as figures
  // floating over the map. Geometry rather than a DOM layer, since what it sits
  // behind is drawn by Babylon.
  const backdrop = CreatePlane('cutaway-backdrop', { size: 400 }, scene);
  backdrop.billboardMode = Mesh.BILLBOARDMODE_ALL;
  backdrop.isPickable = false;
  const dark = new StandardMaterial('cutaway-backdrop', scene);
  dark.diffuseColor = BACKDROP;
  dark.emissiveColor = BACKDROP;
  dark.disableLighting = true;
  backdrop.material = dark;
  backdrop.setEnabled(false);

  /** East of the seam for the attacker, west for the defender. */
  const SIGN: Record<Side, number> = { attacker: 1, defender: -1 };
  /** Each side faces the seam to fight, and turns its back on it to run home. */
  const TOWARD: Record<Side, Facing> = { attacker: 'west', defender: 'east' };
  const AWAY: Record<Side, Facing> = { attacker: 'east', defender: 'west' };
  /**
   * ⚠️ **Beats that turn a figure to the enemy first**: a line taken in the
   * flank turns to answer, and one taken in the rear -- never answered -- takes
   * it in the back.
   */
  const SQUARES_UP: ReadonlySet<Beat> = new Set(['face', 'ready', 'advance', 'strike', 'run']);

  /**
   * One side's tile, drawn at the figures' scale: its ground, what a unit
   * stands on, and its scenery. Returns the height its figures stand at.
   */
  const lay = (side: Side, { cell, terrain }: Combatant, built: TransformNode[]): number => {
    const sign = SIGN[side];
    const piece = (model: TerrainModel, name: string, x: number, y = 0, z = 0) => {
      const node = terrainModels.instantiate(model, `cutaway-${side}-${name}`, cell.paint);
      node.position.set(SEAM.x + sign * x, y, SEAM.z + z);
      built.push(node);
      return node;
    };
    const footing = layGround(piece, cell, terrain);
    layScenery(piece, side, cell, terrain, footing !== undefined);
    // Knee-deep: the water is the model's lowest surface.
    if (terrain === 'river') return terrainModels.bottomOf('ground_riverOpen') - WADE;
    // As the board measures it, but with the footing at its rise.
    return standHeight(
      cell,
      (model) => terrainModels.topOf(model),
      (prop) => RISE[prop.model] ?? 1,
    );
  };

  /**
   * The ground stretched over the half, and what a unit stands on stretched
   * under the line from the seam out, wide and deep but no taller than `RISE`
   * says. Returns that footing, if there is one.
   */
  const layGround = (piece: Piece, cell: TerrainCell, terrain: TileType) => {
    // ⚠️ A road is grass with a road along the line, not its own piece
    // stretched: that bends with its neighbours, and stretched it paved the
    // half. A unit in a river stands in open water, its half all of it.
    const road = terrain === 'road';
    const model = road ? 'ground_grass' : terrain === 'river' ? 'ground_riverOpen' : cell.ground;
    const ground = piece(model, 'ground', GROUND_LENGTH / 2);
    ground.rotation.y = (cell.turns * Math.PI) / 2;
    // Scaled in the model's own axes, which a quarter turn swaps.
    const [along, across] =
      cell.turns % 2 === 0 ? [GROUND_LENGTH, GROUND_DEPTH] : [GROUND_DEPTH, GROUND_LENGTH];
    ground.scaling.set(along, 1, across);
    if (road) {
      // The straight piece runs along x a quarter turn round, so its own z is
      // the length; above the grass by its own sunken depth, or only its edges
      // show.
      const strip = piece('ground_pathStraight', 'road', GROUND_LENGTH / 2, 0.06);
      strip.rotation.y = Math.PI / 2;
      strip.scaling.set(ROAD_WIDTH, 1, GROUND_LENGTH);
    }

    // ⚠️ A bridge is its middle span, flat end to end: a one-tile bridge ramps
    // down at its ends, and two sides on bridges would meet in water.
    const footing = terrain === 'bridge' ? 'bridge_center_wood' : standingOn(cell)?.model;
    if (footing) {
      const node = piece(footing, 'footing', GROUND_LENGTH / 2);
      const { min, max } = node.getHierarchyBoundingVectors();
      // From the seam out, so two sides' footings meet.
      node.scaling.set(
        GROUND_LENGTH / (max.x - min.x),
        RISE[footing] ?? 1,
        FOOTING_DEPTH / (max.z - min.z),
      );
    }
    return footing;
  };

  /**
   * Scenery at true size, as much as the kind of ground carries, only where the
   * camera sees and clear of the line -- the same each time a kind of ground
   * is shown.
   */
  const layScenery = (
    piece: Piece,
    side: Side,
    cell: TerrainCell,
    terrain: TileType,
    raised: boolean,
  ) => {
    const sign = SIGN[side];
    const next = seeded(side === 'attacker' ? 7 : 13, 0);
    const { trees, doodads } = SCENERY[terrain];
    const kinds = cell.props.map((prop) => prop.model).filter((model) => model.startsWith('tree_'));
    const treeModels = kinds.length > 0 ? kinds : TREES;
    // Trees in a row just behind the line, and the last two at its outer end,
    // so a wood closes round the unit in it.
    const row = trees - 2;
    for (let i = 0; i < trees; i++) {
      const [x, z] =
        i < row
          ? [0.6 + ((i + next() * 0.6) / row) * (SEEN.out - 0.6), -LINE - 0.5 - next() * 0.9]
          : [SEEN.out - 0.3 + next() * 0.8, (i - row) * 1.8 - 1 + next() * 0.4];
      const tree = piece(treeModels[i % treeModels.length], `tree-${i}`, x, 0, z);
      tree.rotation.y = next() * Math.PI * 2;
      tree.scaling.setAll(TREE_SIZE * (0.85 + next() * 0.3));
    }
    // A village's own houses in a row behind the line, at true size and doors to
    // the camera, as far out as it sees.
    const houses = cell.props
      .map((prop) => prop.model)
      .filter((model) => model.startsWith('house_'));
    for (let i = 0, along = 0.3; houses.length > 0 && along < SEEN.out; i++) {
      const house = piece(houses[i % houses.length], `house-${i}`, 0);
      const { min, max } = house.getHierarchyBoundingVectors();
      house.position.x = SEAM.x + sign * (along + (max.x - min.x) / 2);
      house.position.z = SEAM.z - LINE - STREET - (max.z - min.z) / 2;
      along += max.x - min.x + HOUSE_GAP;
    }
    for (let i = 0, tries = 0; i < doodads && tries < doodads * 20; tries++) {
      const x = 0.3 + next() * (SEEN.out - 0.3);
      const z = SEEN.back + next() * (SEEN.front - SEEN.back);
      // Clear of the line, which slants across the stage, and of anything it
      // stands raised on.
      const line = STAGE.home + sign * z * SLANT;
      if (Math.abs(x - line) < 2 && Math.abs(z) < LINE + 0.2) continue;
      if (raised && Math.abs(z) < FOOTING_DEPTH / 2) continue;
      const doodad = piece(DOODADS[i % DOODADS.length], `doodad-${i}`, x, 0, z);
      doodad.rotation.y = next() * Math.PI * 2;
      doodad.scaling.setAll(DOODAD_SIZE * (0.8 + next() * 0.45));
      i++;
    }
  };

  /**
   * The camera fitted to what stands on the stage: every figure, by its kind's
   * size, at the height its ground stands -- as close as the band's shape
   * allows, whichever of width or height runs out first. Called again whenever
   * the band changes size.
   *
   * ⚠️ **Measured in the camera's view**, every figure's corners projected, so a
   * tilted camera's view of depth is counted. Centred across on the seam and
   * up and down on the figures, with the readout's strip hanging below them.
   */
  const frame = (points: Vector3[], rect: BandRect): void => {
    const min = points.reduce((m, p) => Vector3.Minimize(m, p));
    const max = points.reduce((m, p) => Vector3.Maximize(m, p));
    // ⚠️ **On the seam**, so the page's divider between the two panels falls on
    // it: each side fills its own half. Keeping the stage's angles, too --
    // without the last flag, `setTarget` rebuilds them from wherever it stood.
    const centre = Vector3.Center(min, max);
    camera.setTarget(new Vector3(SEAM.x, centre.y, centre.z), false, false, true);
    const toView = camera.getViewMatrix(true);
    const seen = points.map((point) => Vector3.TransformCoordinates(point, toView));
    const half = Math.max(...seen.map((p) => Math.abs(p.x)));
    const bottom = Math.min(...seen.map((p) => p.y));
    const top = Math.max(...seen.map((p) => p.y));

    const aspect = rect.width / rect.height;
    // The content's own box with its air, then the view: the content above the
    // readout's strip, the whole as wide as the band's shape makes it.
    const wide = 2 * half * (1 + MARGIN);
    const high = (top - bottom) * (1 + MARGIN);
    const span = Math.max(high / (1 - BAND.readout), wide / aspect);
    const middle = (top + bottom) / 2;
    const above = (span * (1 - BAND.readout)) / 2;
    camera.orthoTop = middle + above;
    camera.orthoBottom = middle + above - span;
    camera.orthoLeft = (-span * aspect) / 2;
    camera.orthoRight = (span * aspect) / 2;

    const sight = camera.target.subtract(camera.position).normalize();
    backdrop.position.copyFrom(camera.target.add(sight.scale(BACKDROP_DEPTH)));
  };

  /** The band on the canvas as it is now, and the camera's viewport on it. */
  const place = (): BandRect => {
    const engine = scene.getEngine();
    const [width, height] = [engine.getRenderWidth(), engine.getRenderHeight()];
    const rect = bandRect(width, height);
    // Babylon counts a viewport up from the bottom, as shares of the canvas.
    camera.viewport = new Viewport(
      rect.left / width,
      (height - rect.top - rect.height) / height,
      rect.width / width,
      rect.height / height,
    );
    return rect;
  };

  return {
    async play(plan, attacker, defender, layout) {
      const built: TransformNode[] = [];
      const surface: Record<Side, number> = {
        attacker: lay('attacker', attacker, built),
        defender: lay('defender', defender, built),
      };
      const who: Record<Side, Combatant> = { attacker, defender };

      // Every figure that stands as the battle opens, at home and facing the seam.
      const figures: Record<Side, Figure[]> = { attacker: [], defender: [] };
      for (const side of ['attacker', 'defender'] as const) {
        for (const [i, member] of plan[side].entries()) {
          const figure = unitModels.instantiate(
            member.role,
            who[side].color,
            `cutaway-${side}-${i}`,
          );
          figure.model.scaling.setAll(ENLARGE[member.role] ?? 1);
          figure.node.position.set(
            SEAM.x + SIGN[side] * (STAGE.home - member.forward) + member.across * SLANT,
            surface[side],
            SEAM.z + member.across,
          );
          // Turned as it stands on the board, against the enemy.
          const facing = FACINGS[(FACINGS.indexOf(TOWARD[side]) + who[side].turned) % 4];
          setUnitFacing(figure.node, facing);
          figures[side].push(figure);
        }
      }

      // Every figure's corners, feet to the top of its weapon, for framing.
      const points = (['attacker', 'defender'] as const).flatMap((side) =>
        figures[side].flatMap((figure, i) => {
          const { role } = plan[side][i];
          const k = ENLARGE[role] ?? 1;
          const [long, wide, tall] = [
            SIZE[role].long * k,
            SIZE[role].wide * k,
            SIZE[role].tall * k,
          ];
          const { x, y, z } = figure.node.position;
          return [-1, 1].flatMap((a) =>
            [-1, 1].flatMap((c) =>
              [0, tall].map((up) => new Vector3(x + (a * long) / 2, y + up, z + (c * wide) / 2)),
            ),
          );
        }),
      );
      const engine = scene.getEngine();
      let size = `${engine.getRenderWidth()}x${engine.getRenderHeight()}`;
      const fit = () => {
        const rect = place();
        layout(rect);
        frame(points, rect);
      };

      backdrop.setEnabled(true);
      fit();
      // ⚠️ The board stays first and keeps the whole canvas; this draws over it.
      scene.activeCameras = [boardCamera, camera];

      // Who is running where: one stretch of movement a figure at a time.
      const runs = new Map<Figure, { from: number; to: number; start: number; over: number }>();
      const apply = (cue: Cue, figure: Figure, side: Side) => {
        if ('by' in cue) {
          const from = figure.node.position.x;
          runs.set(figure, { from, to: from - SIGN[side] * cue.by, start: cue.at, over: cue.over });
          return;
        }
        // A flight is run facing home.
        if (cue.beat === 'flee') setUnitFacing(figure.node, AWAY[side]);
        if (SQUARES_UP.has(cue.beat)) setUnitFacing(figure.node, TOWARD[side]);
        const motion = BEATS[BODY[plan[side][cue.member].role]][cue.beat];
        if (!motion) return;
        if (ONCE.has(cue.beat)) void figure.playOnce(motion);
        else figure.play(motion);
      };

      let next = 0;
      await everyFrame(scene, (elapsed) => {
        // The window resized under a battle: fit it again.
        const now = `${engine.getRenderWidth()}x${engine.getRenderHeight()}`;
        if (now !== size) {
          size = now;
          fit();
        }
        for (; next < plan.cues.length && plan.cues[next].at <= elapsed; next++) {
          const cue = plan.cues[next];
          apply(cue, figures[cue.side][cue.member], cue.side);
        }
        for (const [figure, run] of runs) {
          const done = Math.min(1, Math.max(0, (elapsed - run.start) / run.over));
          const x = run.from + (run.to - run.from) * done;
          // On whichever side's ground it is over now.
          figure.node.position.x = x;
          figure.node.position.y = x > SEAM.x ? surface.attacker : surface.defender;
          if (done === 1) runs.delete(figure);
        }
        return elapsed < plan.length;
      });

      scene.activeCameras = [boardCamera];
      backdrop.setEnabled(false);
      for (const figure of [...figures.attacker, ...figures.defender]) figure.dispose();
      for (const node of built) node.dispose(false, false);
    },
  };
}
