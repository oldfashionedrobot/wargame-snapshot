// Side effect: installs scene.stopAnimation, which syncUnits leans on --
// undefined at runtime without it.
import '@babylonjs/core/Animations/animatable';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Engine } from '@babylonjs/core/Engines/engine';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type {
  AttackKind,
  BattleResolvedEvent,
  Coordinate,
  Facing,
  GameEvent,
  GameState,
  PlayerColor,
  Unit,
  UnitTypeId,
} from '@wargame/shared';
import {
  applyEvents,
  canSelectUnit,
  FACINGS,
  facingToward,
  chargeReady,
  defenseAt,
  isOver,
  isWithinGrid,
} from '@wargame/shared';
import { TILE_SIZE, tileToWorld } from './coordinates';
import { fitPane } from './fitPane';
import { createGridLines } from './gridLines';
import type { BandRect } from './band';
import { wait } from './clock';
import { createCutaway } from './cutaway';
import { planBattle } from './cutawayPlan';
import type { Side } from './cutawayPlan';
import type { Combatant } from './cutaway';
import { createTileHighlight, setHighlightTile } from './highlight';
import { createChargeCounter } from './chargeCounter';
import type { ChargeCounter } from './chargeCounter';
import { createHealthRing } from './healthRing';
import type { HealthRing } from './healthRing';
import { createRouteArrow } from './routeArrow';
import { createTileOverlay } from './tileOverlay';
import { screenToTile } from './picking';
import { createTerrainMesh } from './terrain';
import { createBoardBase } from './boardBase';
import { FRAME, MAX_STAND_HEIGHT, composeTerrain, frameGrid, standHeight } from './composeTerrain';
import type { TerrainCell } from './composeTerrain';
import { loadTerrainModels } from './terrainModels';
import type { TerrainModel } from './terrainModels';
import { animateUnitAlongPath, createPiece, getUnitFacing, setUnitFacing } from './units';
import { loadUnitModels } from './unitModels';
import type { Figure } from './unitModels';

/**
 * Zoom, as a multiple of the distance at which the whole board just fits.
 *
 * ⚠️ **`MIN_ZOOM` of 1 is the floor for a reason, not a taste.** Below it the
 * board stops filling the viewport and the wheel buys nothing but background.
 * The camera starts closer than the floor, with the playable board just filling
 * the window -- see `startZoom`.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 3.5;
const ZOOM_PER_NOTCH = 1.12;
/** A hair of air around the board at full zoom-out, so it is not flush. */
const FIT_MARGIN = 1.04;

/**
 * How far the camera may tilt, and what the band costs at each end.
 *
 * Orbit stays free in `alpha` — facing and flanking are mechanics here, and a
 * unit's rear is only a target you can aim at if you can go round and look at
 * it. Only `beta` is clamped, and until this existed it had **no limits at all**:
 * a drag could take the camera anywhere, including angles no constant on the
 * board had been chosen against.
 *
 * ⚠️ **The shallow end is a judgement, not arithmetic** — worth saying plainly,
 * because it reads like arithmetic. A surface of height `h` draws `h / tan θ`
 * tiles up-screen, so the mesa (0.479, the tallest thing a unit stands on)
 * covers 0.60 of the tile behind it at the starting angle and **0.83 at 30°**.
 * That is the whole price. It is not a *picking* price: `screenToTile` searches
 * every surface height tallest-first, so a click finds a peak wherever it is
 * drawn however shallow the view. What degrades is only how much board a raised
 * tile hides, and that is a thing to look at rather than solve.
 *
 * ⚠️ There is more room here than there looks, and the reason is the trees. The
 * bound was first drawn at 38.66° against `MAX_STAND_HEIGHT`, while the tallest
 * thing actually on the board was a tree at **1.96** — occluding two and a half
 * tiles and governed by nothing. At today's scale the tallest is 0.79, so the
 * shallow view costs less now than the steep one used to.
 *
 * The top-down end stays free of all this: tilting *up* only ever shortens what
 * a prop covers, so 60° is a view limit rather than a legibility one.
 */
const CAMERA_BETA = Math.PI / 3.5; // start: 38.57° above the horizon
const CAMERA_BETA_TOPDOWN = Math.PI / 6; // 60° above the horizon — nearly overhead
const CAMERA_BETA_SHALLOW = Math.PI / 3; // 30° above the horizon

/**
 * How far above a tile an anchored element floats, in world units.
 *
 * ⚠️ Over the tallest piece, so the pane clears the unit rather than only the
 * ground. Measured in tiles, because `TILE_SIZE` is 1. Nothing to do with the
 * overlays below -- it sat in the middle of them for a while, which is how a
 * block of triples stops being readable at a glance.
 */
const ANCHOR_LIFT = 1.7;

/** How a unit killed in battle goes, once it has fallen: blinks, then gone. */
const DEATH_BLINKS = 3;
const DEATH_BLINK_MS = 120;

/**
 * Every tile overlay, as a colour, an opacity and a height above the surface.
 *
 * ⚠️ **One triple each, in that order, with nothing between them.** They are
 * the whole visual tuning surface for the board, and the only thing that makes
 * a block of twenty-odd constants legible is that it has exactly one shape.
 * `height` orders them against each other where two could coincide.
 */
const HOVER_COLOR = new Color3(1, 1, 1);
const HOVER_ALPHA = 0.6;
const HOVER_HEIGHT = 0.02;

const SELECTED_COLOR = new Color3(1, 0.85, 0.1);
const SELECTED_ALPHA = 0.55;
const SELECTED_HEIGHT = 0.025;

// The reachable set, and the route through it to whatever the pointer is
// over. The route sits above the range so it reads on top of it.
const RANGE_COLOR = new Color3(0.3, 0.55, 1);
const RANGE_ALPHA = 0.4;
const RANGE_HEIGHT = 0.015;

const ROUTE_COLOR = new Color3(0.95, 0.98, 1);
const ROUTE_ALPHA = 0.75;
const ROUTE_HEIGHT = 0.018;
// ⚠️ **The route draws over the board and under the units**, as Advance Wars
// draws its arrow. Groups draw in order, and neither of these clears depth: the
// route ignores depth and writes none, so the units after it still meet the
// terrain's and stand behind a hill as they did.
const ROUTE_GROUP = 1;
const UNIT_GROUP = 2;
// The four tiles a unit may turn to look at. Warm, so it does not read as
// somewhere to go -- by this point movement is already decided.
const FACING_COLOR = new Color3(1, 0.82, 0.35);
const FACING_ALPHA = 0.55;
const FACING_HEIGHT = 0.02;

/**
 * ⚠️ **Opaque where every other overlay is a wash, and the board is why.**
 * Red and this teal ground are near-complementary, so blending them gives
 * *grey* rather than pink: a desaturated red at 0.34 was invisible, and even a
 * strong red at 0.4 read as a slightly dirty tile. The pale blue range and amber
 * facing tints survive at 0.4-0.55 because neither fights the ground that way.
 * At 0.8 it reads as a salmon band and terrain is still legible underneath,
 * which is what a player is evaluating.
 *
 * It sits below `FACING_HEIGHT` deliberately -- but the two sets are never lit
 * together, since attacking and facing are separate modes. The ordering is
 * insurance, not the rule.
 */
const ATTACK_COLOR = new Color3(0.95, 0.2, 0.24);
const ATTACK_ALPHA = 0.8;
const ATTACK_HEIGHT = 0.016;
// ⚠️ **A deeper red than the attack band, not a different hue.** A charge is
// an attack, so it should read as one at a glance; what it must not do is read
// as *the same* attack, because the two are never offered together and a player
// arriving at a lit board needs to know which question is being asked. Same
// alpha and height for the same reason the attack band needed 0.8 -- red over
// this teal ground blends toward grey at anything less.
const CHARGE_COLOR = new Color3(0.62, 0.08, 0.12);
const CHARGE_ALPHA = 0.8;
const CHARGE_HEIGHT = 0.016;

/**
 * What a cutaway is showing, for the DOM half to print over it.
 *
 * ⚠️ **Both healths, before and after**, because a bar counting down needs the
 * value it counts *from* and `battleResolved` carries only results (invariant
 * 9). The before-value is the last-drawn state with the batch's earlier events
 * folded on, which `playEvents` keeps as it goes.
 */
export interface CutawaySide {
  unitTypeId: UnitTypeId;
  color: PlayerColor;
  before: number;
  after: number;
  /** The defence the terrain under this unit is worth. */
  defense: number;
  /**
   * When its side's blow lands, in milliseconds after the cutaway opens, or
   * null if none does: its bar holds at `before` until then.
   */
  hit: number | null;
}

export interface CutawayScene {
  /**
   * Which battle this is, counting up.
   *
   * ⚠️ Carried so the DOM half can *remount* per battle rather than mutate. A
   * health bar that animates has to start at the before-value, and a component
   * that persists across battles would have to correct itself after mounting --
   * which is a synchronous `setState` in an effect, and a cascading render.
   * Nothing else reads it.
   */
  id: number;
  kind: AttackKind;
  attacker: CutawaySide;
  defender: CutawaySide;
  /** Where the band is on the canvas, in pixels, for the page to frame it. */
  rect: BandRect;
}

/**
 * Which of the three mutually exclusive overlays is lit.
 *
 * ⚠️ Takes tiles rather than a centre, like every other overlay: `facing` used
 * to derive its four itself, which put a question about the *selection* inside
 * the thing that paints. Clipping to the board went to `selection.ts` with it,
 * where it is testable -- nothing in here has unit tests, being WebGL.
 */
export type StepOverlay = 'attack' | 'charge' | 'facing';

export interface GameRenderer {
  onTileClick(handler: (coordinate: Coordinate) => void): void;
  setSelectedTile(coordinate: Coordinate | null): void;
  /** Light the tiles a selected unit may reach, or clear them. */
  setRange(tiles: Coordinate[]): void;
  /**
   * Light one of the step overlays and clear the other two, or clear all three.
   *
   * ⚠️ **One call, because only one may ever be lit**, and this used to be
   * three independent setters with that rule written in a comment over the
   * caller. Every update then had to remember to clear the other two, which is
   * an invariant a reader has to reconstruct from three call sites instead of
   * reading off the signature. Now it cannot be broken.
   *
   * ⚠️ **Named for what it paints, not for what the player is doing.** `attack`
   * is the attack *band* -- red means in range -- while `charge` is
   * *targets*, since a charge is contact-only and has no reach to show; and
   * `facing` is the four a unit may turn to look at. Which tiles those are is
   * decided in `selection.ts`, where the board is. Keeping the two vocabularies
   * apart is what stops `render/` importing the interaction layer to name a
   * colour.
   */
  setStepTiles(overlay: StepOverlay | null, tiles: Coordinate[]): void;
  /**
   * Draw a pinned route, or clear it.
   *
   * ⚠️ Coordinates, not a `Movement`. The renderer used to hold the search
   * itself so it could answer `POINTERMOVE` without troubling React -- which
   * meant the route existed only under a pointer, and a touchscreen never saw
   * one at all. Presentation is given tiles to light, not a search to query.
   */
  setRoute(path: Coordinate[]): void;
  /**
   * Keep `element` positioned over `coordinate`, and on the board, or stop.
   *
   * ⚠️ The renderer writes `transform` rather than React re-rendering: a DOM
   * overlay tracking the board is otherwise a React commit every frame the
   * camera turns. React owns the content, this owns the placement.
   */
  anchorTo(element: HTMLElement | null, coordinate: Coordinate | null): void;
  /** Animates what the authority says happened. Resolves when done. */
  playEvents(events: GameEvent[]): Promise<void>;
  /**
   * Makes the meshes match `state`: the dead are removed, the living are
   * positioned, no tween. A no-op after a played animation, the correction
   * after a skipped or failed one.
   *
   * ⚠️ **Removal only, never creation, and that is not an oversight.** Nothing
   * can add a unit to a match: `applyEvents` only ever maps over `units`, and
   * there is no production, no reinforcement and no recruitment. Units enter
   * state once, in `createMatchState`, before this renderer is built. If that
   * ever changes, the other half goes here.
   */
  syncUnits(state: GameState): void;
  /**
   * Called when a battle's cutaway opens and closes, with what to print over it.
   *
   * ⚠️ **The staged models are Babylon's; the numbers are React's.** Health bars
   * and figures want text, layout and transitions, which is DOM's job and not
   * something to rebuild in a 3D scene. So the renderer raises the views and
   * hands the caller everything it would otherwise have had to re-derive.
   */
  onCutaway(handler: (scene: CutawayScene | null) => void): void;
  /**
   * Walk a unit to a destination it has not actually moved to. Resolves when
   * the preview **settles** -- which is when the walk finishes, but also when
   * a cancel or a snap ends it early. Never left pending: `stopAnimation` does
   * not fire an animation's end callback, so a promise tied to the tween alone
   * would hang and the menu waiting on it would never open.
   */
  previewMove(unitId: string, path: Coordinate[]): Promise<void>;
  /** Put a previewed unit back where it really stands. */
  cancelPreview(): void;
  /**
   * Where a tile's surface is in the viewport, or null off the grid -- what a
   * browser check clicks, so it addresses a tile rather than guessing a pixel.
   *
   * ⚠️ Viewport, not canvas: the canvas's own rectangle is added, because the
   * page around it is not at the origin.
   */
  tileToScreen(coordinate: Coordinate): { x: number; y: number } | null;
  toggleInspector(): void;
  dispose(): void;
}

// Dev-only: the Inspector UI ships in a separate package, dynamically
// imported here so it's never pulled into a production bundle.
async function toggleInspector(scene: Scene): Promise<void> {
  if (!import.meta.env.DEV) return;

  // scene.debugLayer is itself an augmentation. Loaded inside the guard like
  // the Inspector, so neither ships in a production bundle.
  await import('@babylonjs/core/Debug/debugLayer');
  if (scene.debugLayer.isVisible()) {
    scene.debugLayer.hide();
    return;
  }

  await import('@babylonjs/inspector');
  await scene.debugLayer.show({ embedMode: true });
}

/**
 * Shouts if any tile's walkable surface is higher than picking can absorb.
 *
 * ⚠️ Checks the **surface**, not the ground model, because that is what
 * `MAX_STAND_HEIGHT` governs. Testing `topOf` alone and `standOn` alone passes
 * a cell that breaches the ceiling on their sum — a deck on a raised pad is
 * only ever one map away, and each half would look innocent.
 *
 * The way this gets breached is a model swap — the kit has a half-height cliff
 * sitting right beside the quarter-height one — and the symptom is not a raised
 * tile but *clicks landing on the neighbour*, which nobody would trace back to
 * the art. Heights are measured at load, so this is the earliest point anything
 * can know. A warning rather than a throw: the board still draws, and the
 * browser is this renderer's only check anyway.
 */
function warnIfTooTall(cells: TerrainCell[][], surfaceAt: (at: Coordinate) => number): void {
  // One complaint per offending ground, not per tile: a range of hills
  // would otherwise say the same thing thirty times.
  const tall = new Map<TerrainModel, number>();
  cells.forEach((cellRow, row) =>
    cellRow.forEach((cell, col) => {
      const surface = surfaceAt({ col, row });
      if (surface > MAX_STAND_HEIGHT) tall.set(cell.ground, surface);
    }),
  );

  for (const [ground, surface] of tall) {
    console.error(
      `terrain: a ${ground} tile stands at ${surface.toFixed(2)}, over the ` +
        `${MAX_STAND_HEIGHT} a tile may be before clicks land on the wrong one`,
    );
  }
}

// ⚠️ **One engine per canvas at a time.** A canvas has one WebGL context, and
// two engines on it share the GL state while each keeps its own record of what
// is bound. Disposing one unbinds every texture slot it holds, the other still
// believes its textures bound and never binds them again, and the route arrow
// sampled an empty slot and drew as solid tiles. StrictMode builds twice in
// dev, so a build waits until the last renderer on its canvas is disposed.
const canvasFreed = new WeakMap<HTMLCanvasElement, Promise<void>>();

/**
 * The edge of the board the camera starts behind: the near one, row 0, where
 * the first seat deploys, or the far one opposite.
 */
export type ViewFrom = 'near' | 'far';

export async function createGameRenderer(
  canvas: HTMLCanvasElement,
  initialState: GameState,
  viewFrom: ViewFrom,
): Promise<GameRenderer> {
  const previous = canvasFreed.get(canvas);
  let free = (): void => {};
  canvasFreed.set(
    canvas,
    new Promise((resolve) => {
      free = resolve;
    }),
  );
  await previous;
  try {
    return await buildGameRenderer(canvas, initialState, viewFrom, free);
  } catch (cause) {
    // A build that fails is never disposed, and must not hold the canvas.
    free();
    throw cause;
  }
}

async function buildGameRenderer(
  canvas: HTMLCanvasElement,
  initialState: GameState,
  viewFrom: ViewFrom,
  free: () => void,
): Promise<GameRenderer> {
  const gridHeight = initialState.grid.length;
  const gridWidth = initialState.grid[0]?.length ?? 0;

  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  const camera = new ArcRotateCamera(
    'camera',
    // Half a turn apart: only where the camera starts, since orbit is free.
    viewFrom === 'near' ? -Math.PI / 2 : Math.PI / 2,
    CAMERA_BETA,
    Math.max(gridWidth, gridHeight) + 2 * FRAME,
    Vector3.Zero(),
    scene,
  );
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.attachControl(canvas, true);

  // ⚠️ An orthographic camera's apparent size comes entirely from its ortho
  // bounds; `radius` changes nothing you can see. So the wheel's default job --
  // moving the camera along its radius -- is not zoom here, it is walking the
  // camera into the board until the near plane starts eating it. Take the
  // input away and drive the bounds instead.
  camera.inputs.removeByType('ArcRotateCameraMouseWheelInput');
  // Pinned, so nothing else can drift it, and far enough out that orbiting
  // never brings a corner of the board's frame through the near plane.
  camera.lowerRadiusLimit = camera.radius;
  camera.upperRadiusLimit = camera.radius;
  // Rotation stays free; only the tilt is bounded. The camera starts partway up
  // its own band rather than at an end of it — see CAMERA_BETA above for what
  // each end costs.
  camera.lowerBetaLimit = CAMERA_BETA_TOPDOWN;
  camera.upperBetaLimit = CAMERA_BETA_SHALLOW;
  camera.minZ = 0.1;

  let zoom = MIN_ZOOM;

  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const scale = event.deltaY < 0 ? ZOOM_PER_NOTCH : 1 / ZOOM_PER_NOTCH;
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * scale));
  };
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  const light = new HemisphericLight('light', new Vector3(0, 1, 0.3), scene);
  light.intensity = 0.9;
  // ⚠️ Not the default black. `groundColor` is what a surface facing *away*
  // from the light receives, and at zero anything vertical goes to nothing.
  // That was invisible while the board was flat-topped tiles; it is not once
  // things stand up on them -- a grass blade turned away rendered at #23361c
  // against ground at #27bea2, which reads as dirt rather than as a plant.
  light.groundColor = new Color3(0.42, 0.44, 0.42);

  // Awaited alongside the unit models: a board that pops into existence a frame
  // late is a frame nobody needs to see.
  const terrainModels = await loadTerrainModels(scene);
  // Composed whole, so rivers and roads tile across the seam, and drawn whole;
  // everything that asks about the board reads its own cells, cut back out.
  const framed = composeTerrain(frameGrid(initialState.grid, FRAME));
  const cells = framed
    .slice(FRAME, FRAME + gridHeight)
    .map((cellRow) => cellRow.slice(FRAME, FRAME + gridWidth));

  /**
   * How high a unit stands on a tile — **the only answer to that question**.
   *
   * Terrain, props, units, the walk animation, all five overlays and the battle
   * close-up go through here, so there is no second way to ask and nothing to
   * drift. The ground's share is measured off the model rather than declared;
   * `standOn` adds the one case where you stand on a prop instead, a bridge
   * deck.
   */
  const surfaceAt = ({ col, row }: Coordinate): number => {
    const cell = cells[row]?.[col];
    return cell ? standHeight(cell, (model) => terrainModels.topOf(model)) : 0;
  };

  /**
   * Every distinct height a tile's surface sits at, tallest first.
   *
   * This is what lets `screenToTile` find a raised tile where it is *drawn*
   * rather than where it would fall onto a flat board. Worked out once: terrain
   * does not change during a match, and a board has two or three of these.
   */
  const levels = [
    ...new Set(cells.flatMap((cellRow, row) => cellRow.map((_, col) => surfaceAt({ col, row })))),
  ].sort((a, b) => b - a);

  warnIfTooTall(cells, surfaceAt);

  createTerrainMesh(scene, terrainModels, framed);
  // The board's floor, which every tile shares -- hills raise a rock, not their
  // ground. Taken from the models rather than assumed to be zero.
  const groundLevel = Math.max(...cells.flat().map((cell) => terrainModels.topOf(cell.ground)));
  createGridLines(scene, groundLevel, gridWidth, gridHeight);
  // Under the floor, so the board is an object rather than geometry that stops.
  // Nothing reads it: it is not pickable and `surfaceAt` does not know it.
  //
  // ⚠️ `bottomOf`, not `topOf`. The grid lines take the highest *top* because
  // they go over everything; a slab has to clear the lowest *geometry*, which
  // is a different question -- a river is a channel cut into its tile, so its
  // top is the bank at 0.00 while the water it has to stay under is at -0.05.
  // Measuring the top here hangs the slab through every river on the board.
  const boardFloor = Math.min(...framed.flat().map((cell) => terrainModels.bottomOf(cell.ground)));
  const boardBase = createBoardBase(
    scene,
    boardFloor,
    gridWidth + 2 * FRAME,
    gridHeight + 2 * FRAME,
  );

  /**
   * The eight corners of the board as an object: the playable rectangle, from
   * the floor down to the slab's underside.
   *
   * ⚠️ **The board's rectangle, not the slab's**, which reaches under the frame
   * too -- the camera fits and pans on what can be played, and the frame is
   * only what surrounds it. The slab's depth is in here because it hangs below
   * the board and is part of the silhouette at shallow angles.
   */
  boardBase.computeWorldMatrix(true);
  const slabBottom = boardBase.getBoundingInfo().boundingBox.minimumWorld.y;
  const halfWidth = (gridWidth * TILE_SIZE) / 2;
  const halfHeight = (gridHeight * TILE_SIZE) / 2;
  const boardCorners = [-halfWidth, halfWidth].flatMap((x) =>
    [-halfHeight, halfHeight].flatMap((z) =>
      [slabBottom, groundLevel].map((y) => new Vector3(x, y, z)),
    ),
  );

  /**
   * How much room the board needs, worked out **once** and never again.
   *
   * ⚠️ **Nothing here may read the camera.** A fit that consults the current
   * angle rescales the board as the camera moves, which is the camera
   * breathing, and it is wrong at both ends: a square board is `half-width`
   * across down an axis and `half-diagonal` across at 45°, and its depth
   * projects by `cos β`, which changes as you tilt. A mouse drag moves *both*,
   * so consulting either is enough to make a still board change size while you
   * look at it.
   *
   * So both numbers are the worst case over everywhere the camera may go:
   * `reachX` is the ground-plane half-diagonal, which no `alpha` exceeds, and
   * `reachY` is measured at `CAMERA_BETA_TOPDOWN`, the most overhead tilt
   * allowed and so the one that needs the most vertical room.
   *
   * ⚠️ The price is dead space at every angle that is not the worst one -- on a
   * 12×12 the board sits in about three quarters of the height it could fill
   * looking down an axis. That is what a still image costs, and it is a better
   * trade than a board that resizes itself whenever the camera turns.
   */
  const boardRadius = Math.max(...boardCorners.map((corner) => Math.hypot(corner.x, corner.z)));
  const boardRise = Math.max(...boardCorners.map((corner) => Math.abs(corner.y)));
  const reachX = boardRadius;
  const reachY =
    boardRadius * Math.cos(CAMERA_BETA_TOPDOWN) + boardRise * Math.sin(CAMERA_BETA_TOPDOWN);

  /**
   * Where zoom starts: the board's own rectangle just filling the window from
   * the starting pose, so the frame shows only past its edges -- where
   * `zoom = 1`, fitted to the worst angle, leaves it showing all round.
   */
  const startZoom = (): number => {
    camera.getViewMatrix(true);
    const across = camera.getDirection(Vector3.Right());
    const upward = camera.getDirection(Vector3.Up());
    const startX = Math.max(...boardCorners.map((corner) => Math.abs(Vector3.Dot(corner, across))));
    const startY = Math.max(...boardCorners.map((corner) => Math.abs(Vector3.Dot(corner, upward))));
    const aspect = canvas.clientWidth / canvas.clientHeight;
    if (!(aspect > 0 && Number.isFinite(aspect))) return MIN_ZOOM;
    const fill = Math.max(reachY, reachX / aspect) / Math.max(startY, startX / aspect);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fill));
  };
  zoom = startZoom();

  /**
   * Sizes the frustum, then keeps the board under it.
   *
   * Run every frame rather than on a change, because everything it depends on
   * -- the orbit, the tilt, the zoom, the window -- moves independently, and
   * sixteen dot products is not worth the bookkeeping of tracking which.
   */
  const holdTheBoard = (): void => {
    const aspect = canvas.clientWidth / canvas.clientHeight;

    // ⚠️ Only the **window** and the **wheel** get a say. `reachX` and `reachY`
    // were settled at build time and no camera angle is read here, which is the
    // whole point: turn the board and it turns, nothing else.
    const extent = (Math.max(reachY, reachX / aspect) * FIT_MARGIN) / zoom;
    camera.orthoLeft = -extent * aspect;
    camera.orthoRight = extent * aspect;
    camera.orthoTop = extent;
    camera.orthoBottom = -extent;

    // ⚠️ **Panning is clamped to the board, and centring falls out of it.** Per
    // axis the target may stray by however much board the viewport does not
    // already cover -- and at full zoom-out it covers all of it, the expression
    // goes to zero, and the board is centred with nowhere to pan. Centring is
    // not a rule of its own; it is this clamp at its limit.
    const right = camera.getDirection(Vector3.Right());
    const up = camera.getDirection(Vector3.Up());
    // ⚠️ Built from the same fixed reach, so the pan limits do not move either.
    // A limit that shrank as the camera turned would snap a panned camera back,
    // which is the same fidget somewhere else.
    const slackX = Math.max(0, reachX - extent * aspect);
    const slackY = Math.max(0, reachY - extent);

    // The board is centred on the origin, so the target *is* its own offset.
    const alongX = Vector3.Dot(camera.target, right);
    const alongY = Vector3.Dot(camera.target, up);
    const heldX = Math.min(slackX, Math.max(-slackX, alongX));
    const heldY = Math.min(slackY, Math.max(-slackY, alongY));
    if (heldX !== alongX || heldY !== alongY) {
      camera.target.copyFrom(right.scale(heldX).add(up.scale(heldY)));
    }
  };
  const hoverHighlight = createTileHighlight(scene, 'hover-highlight', HOVER_COLOR, HOVER_ALPHA);
  const selectedHighlight = createTileHighlight(
    scene,
    'selected-highlight',
    SELECTED_COLOR,
    SELECTED_ALPHA,
  );
  const rangeOverlay = createTileOverlay(scene, {
    name: 'movement-range',
    color: RANGE_COLOR,
    alpha: RANGE_ALPHA,
    height: RANGE_HEIGHT,
    surfaceAt,
    gridWidth,
    gridHeight,
  });
  for (const group of [ROUTE_GROUP, UNIT_GROUP]) {
    scene.setRenderingAutoClearDepthStencil(group, false);
  }
  const routeArrow = createRouteArrow(scene, {
    name: 'movement-route',
    color: ROUTE_COLOR,
    alpha: ROUTE_ALPHA,
    height: ROUTE_HEIGHT,
    renderingGroupId: ROUTE_GROUP,
    surfaceAt,
    gridWidth,
    gridHeight,
  });
  const attackOverlay = createTileOverlay(scene, {
    name: 'attack-range',
    color: ATTACK_COLOR,
    alpha: ATTACK_ALPHA,
    height: ATTACK_HEIGHT,
    surfaceAt,
    gridWidth,
    gridHeight,
  });
  const chargeOverlay = createTileOverlay(scene, {
    name: 'charge-targets',
    color: CHARGE_COLOR,
    alpha: CHARGE_ALPHA,
    height: CHARGE_HEIGHT,
    surfaceAt,
    gridWidth,
    gridHeight,
  });

  const facingOverlay = createTileOverlay(scene, {
    name: 'facing-choices',
    color: FACING_COLOR,
    alpha: FACING_ALPHA,
    height: FACING_HEIGHT,
    surfaceAt,
    gridWidth,
    gridHeight,
  });

  // Awaited before any unit exists: a renderer whose units are still loading
  // would give syncUnits and playEvents a window in which a unit has no mesh.
  const models = await loadUnitModels(scene);

  // ⚠️ Seeded with the board's own starting state, so there is never a moment
  // when nothing has been drawn. Advanced only by `syncUnits`.
  let drawn: GameState = initialState;

  const figures = new Map<string, Figure>();
  // Parallel to `figures` and disposed with them: a ring and a counter are
  // *children* of their unit's node, so a figure's `dispose` takes them, and
  // only these maps need clearing.
  const healthRings = new Map<string, HealthRing>();
  const chargeCounters = new Map<string, ChargeCounter>();

  // What a unit's state shows besides where it stands: its health, its charge
  // meter, and whether it walks on the spot -- ⚠️ the rulebook's own *can act*,
  // so the side not to move stands even where a unit of it was never used.
  // Called by the build as well as by `syncUnits`, because the first board sync
  // arrives before this renderer exists -- a reload mid-turn would otherwise
  // show every unit standing.
  const showUnit = (state: GameState, unit: Unit, figure: Figure): void => {
    healthRings.get(unit.id)?.setHealth(unit.health);
    chargeCounters.get(unit.id)?.setMeter(unit.chargeMeter, chargeReady(unit));
    figure.play(!isOver(state) && canSelectUnit(state, unit) ? 'walk' : 'stand');
  };

  for (const unit of initialState.units) {
    const owner = initialState.players.find((player) => player.id === unit.owner);
    if (!owner) throw new Error(`unit ${unit.id} has unknown owner ${unit.owner}`);
    const figure = createPiece(models, unit, owner.color, surfaceAt, gridWidth, gridHeight);
    figures.set(unit.id, figure);
    healthRings.set(unit.id, createHealthRing(scene, figure.node));
    chargeCounters.set(unit.id, createChargeCounter(scene, figure.node));
    for (const mesh of figure.node.getChildMeshes()) mesh.renderingGroupId = UNIT_GROUP;
    showUnit(initialState, unit, figure);
  }

  // The whole ghost: which unit is displaced, where it really stands, and the
  // promise whoever asked for the preview is waiting on.
  interface Preview {
    unitId: string;
    origin: Coordinate;
    facing: Facing;
    settle: () => void;
  }
  let preview: Preview | null = null;

  // Arriving and ending are different moments, and conflating them loses the
  // origin: the record has to outlive the walk, because a Cancel *after* the
  // unit lands is exactly when something needs to know where to put it back.
  const arrivePreview = (): void => {
    preview?.settle();
  };

  const endPreview = (): void => {
    if (!preview) return;
    // Stopping matters as much as settling: a preview ended mid-walk would
    // otherwise leave its tween writing positions over whatever replaced it,
    // and a second preview of the same unit would run two walks on one mesh.
    const figure = figures.get(preview.unitId);
    if (figure) scene.stopAnimation(figure.node);

    preview.settle();
    preview = null;
  };

  // Tiles are 1.0 apart, so this only has to beat float drift off a finished
  // tween, not distinguish anything close together.
  const TILE_EPSILON = 0.01;

  const isStandingOn = (mesh: TransformNode, coordinate: Coordinate): boolean => {
    const target = tileToWorld(coordinate, gridWidth, gridHeight);
    return (
      Math.abs(mesh.position.x - target.x) < TILE_EPSILON &&
      Math.abs(mesh.position.z - target.z) < TILE_EPSILON
    );
  };

  const hoveredCoordinate = (): Coordinate | null =>
    screenToTile(
      scene,
      camera,
      scene.pointerX,
      scene.pointerY,
      gridWidth,
      gridHeight,
      surfaceAt,
      levels,
    );

  // Where a DOM overlay is pinned, and what it is pinned to. Both null unless
  // something is anchored, which is the common case.
  let anchorElement: HTMLElement | null = null;
  let anchorTile: Coordinate | null = null;

  // Render-buffer pixels to CSS pixels. ⚠️ They are equal today
  // (`adaptToDeviceRatio` is off, so the scaling level is 1) and would silently
  // diverge on a retina display the day it is not.
  //
  // ⚠️ **Through the board camera's own matrices**, not the scene's current
  // one: that is set only while a frame renders, so it is empty before the
  // first, and during a battle it is left holding the close-up's camera.
  const project = (point: Vector3): { x: number; y: number } => {
    const screen = Vector3.Project(
      point,
      Matrix.Identity(),
      camera.getViewMatrix().multiply(camera.getProjectionMatrix()),
      camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
    );
    const scale = engine.getHardwareScalingLevel();
    return { x: screen.x * scale, y: screen.y * scale };
  };

  const HALF_TILE = TILE_SIZE / 2;
  const TILE_CORNERS = [
    [-HALF_TILE, -HALF_TILE],
    [-HALF_TILE, HALF_TILE],
    [HALF_TILE, -HALF_TILE],
    [HALF_TILE, HALF_TILE],
  ] as const;

  // ⚠️ Measures the pane and the canvas every frame, as it projects: both change
  // under it -- the pane with what it says, the canvas with the window.
  const placeAnchor = (): void => {
    if (!anchorElement || !anchorTile) return;
    const { x, z } = tileToWorld(anchorTile, gridWidth, gridHeight);
    const surface = surfaceAt(anchorTile);
    // ⚠️ **Lifted, and lifted in *world* space.** Projecting the tile's own
    // surface put the element's bottom edge exactly there, so it sat on the tile
    // it was describing -- over a route's arrowhead, or over the unit whose
    // choices it was offering. A pixel margin would have drifted with zoom; a
    // world offset holds, because it is projected like everything else. One tile
    // up clears both a tile's drawn extent and the tallest piece standing on it.
    const above = project(new Vector3(x, surface + ANCHOR_LIFT, z));
    // The lowest the tile reaches on screen, for a pane flipped below it. Every
    // corner, so it holds however the camera has turned.
    const below = Math.max(
      ...TILE_CORNERS.map(([dx, dz]) => project(new Vector3(x + dx, surface, z + dz)).y),
    );
    const { x: left, y: top } = fitPane(
      above,
      below,
      { width: anchorElement.offsetWidth, height: anchorElement.offsetHeight },
      { width: canvas.clientWidth, height: canvas.clientHeight },
    );
    anchorElement.style.transform = `translate(${left}px, ${top}px)`;
  };

  const cutaway = createCutaway(scene, models, terrainModels, camera);
  let cutawayHandler: ((scene: CutawayScene | null) => void) | null = null;
  let battleCount = 0;

  /**
   * A unit killed in a battle falls where it stands and blinks out, its ring and
   * counter gone first, so `syncUnits` removes nothing anyone can see.
   */
  const fallOnBoard = async (figure: Figure, unitId: string): Promise<void> => {
    healthRings.get(unitId)?.setHealth(0);
    chargeCounters.get(unitId)?.setMeter(0, false);
    await figure.playOnce('fall');
    for (let blink = 0; blink < DEATH_BLINKS; blink += 1) {
      figure.node.setEnabled(false);
      await wait(scene, DEATH_BLINK_MS);
      figure.node.setEnabled(true);
      await wait(scene, DEATH_BLINK_MS);
    }
    figure.node.setEnabled(false);
  };

  /**
   * Play one battle in the cutaway, resolving when it has closed.
   *
   * ⚠️ **Its own branch, never part of the `unitMoved` one.** That branch skips a
   * move whose mesh already stands at its destination -- true of an approach the
   * player previewed -- and a charge's cutaway would be skipped along with it.
   */
  const playBattle = async (event: BattleResolvedEvent, before: GameState): Promise<void> => {
    const find = (id: string) => {
      const unit = before.units.find((u) => u.id === id);
      const owner = before.players.find((p) => p.id === unit?.owner);
      return unit && owner ? { unit, owner } : null;
    };
    const attacker = find(event.attacker.unitId);
    const defender = find(event.defender.unitId);
    // A participant the last-drawn state does not know is a desync, not a
    // drawable battle. Skipping beats staging a blank.
    if (!attacker || !defender) return;

    const fighters = {
      attacker: { ...attacker, after: event.attacker.health },
      defender: { ...defender, after: event.defender.health },
    };
    const fighter = (side: Side) => ({
      unitTypeId: fighters[side].unit.unitTypeId,
      before: fighters[side].unit.health,
      after: fighters[side].after,
    });
    const plan = planBattle({
      kind: event.kind,
      answered: event.answered,
      attacker: fighter('attacker'),
      defender: fighter('defender'),
    });
    // What the DOM prints over a side and what the stage builds, from one lookup.
    const readout = (side: Side): CutawaySide => {
      const { unit, owner, after } = fighters[side];
      return {
        unitTypeId: unit.unitTypeId,
        color: owner.color,
        before: unit.health,
        after,
        defense: defenseAt(before, unit.position),
        hit: plan.hits[side],
      };
    };
    const staged = (side: Side): Combatant => {
      const { unit, owner } = fighters[side];
      const enemy = fighters[side === 'attacker' ? 'defender' : 'attacker'].unit;
      // How it faces against the enemy: the comparison the rules make for front,
      // flank and rear, through the same `facingToward`.
      const toward = facingToward(unit.position, enemy.position, unit.facing);
      const turned = (FACINGS.indexOf(unit.facing) - FACINGS.indexOf(toward) + 4) % 4;
      const { row, col } = unit.position;
      return { color: owner.color, turned, terrain: before.grid[row][col], cell: cells[row][col] };
    };

    const shown = {
      id: (battleCount += 1),
      kind: event.kind,
      attacker: readout('attacker'),
      defender: readout('defender'),
    };
    // ⚠️ **It ends when the battle has played**, never on a click: one that waited
    // stranded whoever was not watching the opponent's battle, with every later
    // batch queued behind it.
    await cutaway.play(plan, staged('attacker'), staged('defender'), (rect) =>
      cutawayHandler?.({ ...shown, rect }),
    );
    cutawayHandler?.(null);
  };

  /**
   * The battle's dead falling on the board, resolving once they are gone. The
   * dead are whoever the battle leaves off it: the rulebook's answer, read from
   * the state it folds to rather than restated here.
   */
  const fell = (event: BattleResolvedEvent, after: GameState): Promise<unknown> =>
    Promise.all(
      [event.attacker.unitId, event.defender.unitId]
        .filter((id) => !after.units.some((unit) => unit.id === id))
        .map((id) => {
          const figure = figures.get(id);
          return figure ? fallOnBoard(figure, id) : undefined;
        }),
    );

  let clickHandler: ((coordinate: Coordinate) => void) | null = null;
  scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
      const coordinate = hoveredCoordinate();
      setHighlightTile(hoverHighlight, coordinate, HOVER_HEIGHT, surfaceAt, gridWidth, gridHeight);
      return;
    }

    // ⚠️ **`POINTERTAP`, not `POINTERPICK`, and the difference is a bug that
    // shipped.** Babylon only emits `POINTERPICK` when its ray actually hits a
    // *pickable mesh* -- and the terrain sets `isPickable = false`, precisely
    // because picking here is plane arithmetic and wants no ray at a mesh. So
    // clicks only ever arrived where some other pickable mesh happened to be:
    // a unit, a tree, or a lit overlay quad. Bare ground swallowed them.
    //
    // That was survivable while every meaningful click was on a unit or a lit
    // tile, which is why it went unnoticed; it is not survivable now that "a
    // click on the dark backs out" is a rule. `POINTERTAP` fires for any tap
    // that is not a drag, which is what the plane arithmetic always assumed.
    if (pointerInfo.type === PointerEventTypes.POINTERTAP && clickHandler) {
      const coordinate = hoveredCoordinate();
      if (coordinate) clickHandler(coordinate);
    }
  });

  engine.runRenderLoop(() => {
    holdTheBoard();
    scene.render();
    placeAnchor();
  });

  const handleResize = (): void => {
    engine.resize();
  };
  window.addEventListener('resize', handleResize);

  return {
    onTileClick(handler) {
      clickHandler = handler;
    },
    setSelectedTile(coordinate) {
      setHighlightTile(
        selectedHighlight,
        coordinate,
        SELECTED_HEIGHT,
        surfaceAt,
        gridWidth,
        gridHeight,
      );
    },
    setStepTiles(overlay, tiles) {
      attackOverlay.setTiles(overlay === 'attack' ? tiles : []);
      chargeOverlay.setTiles(overlay === 'charge' ? tiles : []);
      facingOverlay.setTiles(overlay === 'facing' ? tiles : []);
    },
    setRange(tiles) {
      rangeOverlay.setTiles(tiles);
    },
    setRoute(path) {
      routeArrow.setPath(path);
    },
    anchorTo(element, coordinate) {
      anchorElement = element;
      anchorTile = coordinate;
      // Placed now rather than next frame: an overlay that appears at its
      // previous position and corrects a frame later reads as a jump.
      placeAnchor();
    },
    onCutaway(handler) {
      cutawayHandler = handler;
    },
    async playEvents(events) {
      // ⚠️ **Each battle is staged against the state just before it**, not the
      // last sync: a move-then-attack's approach has already moved the attacker,
      // and an earlier battle in the batch has already hurt its targets. Folded
      // at the top of the step, so a skipped (previewed) move is folded too.
      let shown = drawn;
      // ⚠️ **The dead fall while the batch goes on**, so a charge that breaks
      // through walks into the square as its last defender is still going
      // down. A later battle waits for them, and so does the batch's end, which
      // `syncUnits` follows.
      let dying: Promise<unknown> = Promise.resolve();
      for (const event of events) {
        const before = shown;
        shown = applyEvents(shown, [event]);
        if (event.type === 'battleResolved') {
          await dying;
          await playBattle(event, before);
          dying = fell(event, shown);
          continue;
        }
        if (event.type !== 'unitMoved') continue;
        const figure = figures.get(event.unitId);
        if (!figure) continue;

        // Already shown. A confirmed preview has walked this unit here
        // already, so replaying the move would send it back to the second
        // tile and forward again. Positional rather than a flag: if the mesh
        // is where the event says it ends, the move has been seen. Safe
        // because the menu only opens once the walk has arrived.
        const destination = event.path[event.path.length - 1];
        if (isStandingOn(figure.node, destination)) continue;

        await animateUnitAlongPath(figure, event.path, surfaceAt, gridWidth, gridHeight, scene);
      }
      await dying;
    },
    previewMove(unitId, path) {
      endPreview();
      const figure = figures.get(unitId);
      if (!figure) return Promise.resolve();

      let settle!: () => void;
      const settled = new Promise<void>((resolve) => (settle = resolve));
      preview = { unitId, origin: path[0], facing: getUnitFacing(figure.node), settle };

      void animateUnitAlongPath(figure, path, surfaceAt, gridWidth, gridHeight, scene).then(() => {
        // Only if this preview is still the live one -- a cancel or a snap
        // may have ended it while the walk was running.
        if (preview?.settle === settle) arrivePreview();
      });
      return settled;
    },
    tileToScreen(coordinate) {
      if (!isWithinGrid(coordinate, gridWidth, gridHeight)) return null;
      const { x, z } = tileToWorld(coordinate, gridWidth, gridHeight);
      const onCanvas = project(new Vector3(x, surfaceAt(coordinate), z));
      const { left, top } = canvas.getBoundingClientRect();
      return { x: left + onCanvas.x, y: top + onCanvas.y };
    },
    cancelPreview() {
      const previewed = preview;
      if (!previewed) return;

      const node = figures.get(previewed.unitId)?.node;
      if (node) {
        // Stop first: a cancel mid-walk must win over the tween still writing
        // positions, exactly as a snap does.
        scene.stopAnimation(node);
        const home = tileToWorld(previewed.origin, gridWidth, gridHeight);
        node.position.set(home.x, surfaceAt(previewed.origin), home.z);
        setUnitFacing(node, previewed.facing);
      }
      endPreview();
    },
    syncUnits(state) {
      // Recorded before the work, not after: everything below reads `state`
      // anyway, and a mid-function throw would otherwise leave this behind by
      // one commit -- a silent, permanent one-turn lag in any damage animation.
      drawn = state;
      // Authority overwrites every position, the previewed one included, so
      // this *is* the preview ending -- there is no separate commit.
      //
      // ⚠️ Before the removal pass, not after. A live preview holds a unit by
      // id and animates its mesh; disposing that node first would leave a tween
      // writing into a destroyed object.
      endPreview();

      // Whatever the authority no longer lists is dead, and a mesh nobody
      // removes stands on the board for the rest of the match -- unselectable,
      // unkillable, and in the way.
      const alive = new Set(state.units.map((unit) => unit.id));
      for (const [id, figure] of figures) {
        if (alive.has(id)) continue;
        // Stop first: a tween outliving its target writes into a dead node.
        scene.stopAnimation(figure.node);
        figure.dispose();
        figures.delete(id);
        // The ring and counter were children and went with the node; only the
        // entries are left.
        healthRings.delete(id);
        chargeCounters.delete(id);
      }

      for (const unit of state.units) {
        const figure = figures.get(unit.id);
        if (!figure) continue;
        // Stop first: a snap must win over any tween still writing positions.
        scene.stopAnimation(figure.node);
        const target = tileToWorld(unit.position, gridWidth, gridHeight);
        figure.node.position.set(target.x, surfaceAt(unit.position), target.z);
        setUnitFacing(figure.node, unit.facing);
        // ⚠️ Snapped, like the position beside it. Once damage animates, the
        // tween belongs in `playEvents` and this stays the corrector -- and it
        // will need stopping the ring's own animation, which
        // `scene.stopAnimation` above does *not* reach.
        showUnit(state, unit, figure);
      }
    },
    toggleInspector() {
      void toggleInspector(scene);
    },
    dispose() {
      window.removeEventListener('resize', handleResize);
      canvas.removeEventListener('wheel', handleWheel);
      engine.dispose();
      free();
    },
  };
}
