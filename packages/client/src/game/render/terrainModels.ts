// Side effect: registers the .glb loader. Already imported by unitModels, but
// stated here too -- this module does not want to depend on load order.
import '@babylonjs/loaders/glTF/2.0';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Scene } from '@babylonjs/core/scene';

// Kenney's Nature Kit, CC0. Every ground model is exactly 1x1 in x and z, which
// is TILE_SIZE, so the board needs no scaling. Their tops are *not* all level
// and nothing here assumes they are: grass and every riverbank sit at -0.05 and
// open water at -0.10, with no bank to speak of. That is what `topOf` is for --
// and it measures props too, since hills are a mesa standing on grass and
// what a unit stands on there is the rock's own top.
//
// ⚠️ Those numbers do not match the position accessors, because every model in
// the kit hangs under a node translated -0.05 in y. Reading the raw geometry
// gives answers a uniform 0.05 too high -- which is exactly the kind of thing
// measuring the loaded meshes gets right for free and a transcribed table does
// not. See the licence alongside them in public/models/terrain/.
const MODEL_DIR = 'models/terrain'; // relative to the page, as the unit models are
const HOUSE_DIR = 'models/buildings';

/** Every model the tiler can ask for. A name not in here is a compile error.
 *  Unexported: `TerrainModel` below is the surface, and the list is how it is
 *  spelled rather than something a caller has any use for. */
const TERRAIN_MODELS = [
  'ground_grass',
  // Water, as a body: the mask counts water neighbours, so these are named for
  // where the *land* is.
  'ground_riverOpen',
  'ground_riverSide',
  'ground_riverCorner',
  'ground_riverStraight',
  'ground_riverEnd',
  'ground_riverTile',
  'ground_riverCornerSmall',
  // Water as a channel a tile wide, where the land in a crook says so.
  'ground_riverBend',
  'ground_riverSplit',
  'ground_riverCross',
  // Roads, as connectors -- a road is never a body of anything.
  'ground_pathCross',
  'ground_pathSplit',
  'ground_pathBend',
  'ground_pathStraight',
  'ground_pathEnd',
  'ground_pathTile',
  // A mesa: a flat-topped outcrop with a grass cap, which a unit stands on top
  // of. ⚠️ It is a **prop**, never ground -- a rock's silhouette does not fill a
  // square, and used as ground it left the board see-through at the corners.
  // `rock_largeF` and not `rock_largeD`, which is the same family but a domed
  // mound whose grass sits in a dish you cannot see from overhead.
  'rock_largeF',
  // Things that stand on the ground rather than being it.
  'bridge_wood',
  // A crossing longer than a tile: an end piece ramped onto each bank, and
  // middle spans between.
  'bridge_side_wood',
  'bridge_center_wood',
  // Woodland, varied. ⚠️ All of these are painted `woodBark` and `leafsGreen`,
  // the two a single tree already brought, so the variety is free -- the pines
  // are not, carrying `woodBarkDark` and `leafsDark` of their own.
  'tree_default',
  'tree_oak',
  'tree_tall',
  'tree_fat',
  'tree_thin',
  'tree_cone',
  // Scattered thinly over open ground, so a field of plains is not one flat
  // green. ⚠️ The first four are painted `grass` and cost nothing at all --
  // they merge into a group the board already has. `flower_purpleA` brings
  // `colorPurple` with it and is the one doodad that adds a draw call, which
  // is what buys the only spot of colour out there.
  'grass',
  'grass_large',
  'grass_leafs',
  'plant_bushSmall',
  'flower_purpleA',
  // A village's houses, from the Beelim packs rather than this kit: converted by
  // `bun run models`, a man to the unit and each door to +z, into `HOUSE_DIR`.
  'house_cottage',
  'house_timbered',
  'house_slate',
  'house_narrow',
  'house_dutch',
  'house_villa',
] as const;

export type TerrainModel = (typeof TERRAIN_MODELS)[number];

export interface TerrainModels {
  /**
   * How high the top of a model sits, measured from its geometry.
   *
   * ⚠️ **Measured, never declared.** A tile's walkable surface *is* the top of
   * something drawn there, so deriving it means there is no second number to
   * drift out of step with the art -- swap the model and the height follows.
   * The same discipline as `entryCost` being the only cost model.
   *
   * Asked about props as well as ground: hills are a mesa standing on
   * grass, and what a unit stands on there is the rock's own top.
   *
   * ⚠️ Bounded by `MAX_STAND_HEIGHT`, which explains why; `warnIfTooTall` is
   * what checks it, since the answer is not knowable until these are loaded.
   */
  topOf(model: TerrainModel): number;
  /**
   * How low a model reaches, measured the same way `topOf` measures up.
   *
   * ⚠️ **A tile is not flat, and `topOf` cannot tell you so.** A river is a
   * channel cut *down* into its tile: the banks measure 0.00 and the water sits
   * at -0.05, so the top reports the bank and says nothing about the surface a
   * player actually sees. Anything positioning itself *under* the board has to
   * ask this instead -- `boardBase` does, and hanging it off `topOf` put the
   * slab straight through every river on the map.
   */
  bottomOf(model: TerrainModel): number;
  /**
   * A fresh copy of one model, parented to a node of ours.
   *
   * The caller owns the returned node's transform. The loader's own `__root__`
   * stays underneath it carrying the right-handed-to-left-handed conversion as
   * a negative scale, which a rotation set on it would compose with and get
   * wrong -- the same reason unit models are wrapped.
   *
   * `paint` recolours it beyond what the model is always recoloured to.
   */
  instantiate(model: TerrainModel, name: string, paint?: Paint): TransformNode;
}

/**
 * Loads every terrain model once, sharing materials by name across all of them.
 *
 * The sharing is the point: `grass` appears in `ground_grass`, `ground_riverSide`
 * and half the scenery, and a separate instance per file would defeat merging by
 * material later -- the difference between about fourteen draw calls for a board
 * and one per model per tile.
 */
export async function loadTerrainModels(scene: Scene): Promise<TerrainModels> {
  const containers = await Promise.all(
    TERRAIN_MODELS.map((model) =>
      LoadAssetContainerAsync(
        `${model.startsWith('house_') ? HOUSE_DIR : MODEL_DIR}/${model}.glb`,
        scene,
        // ⚠️ Raw bytes, as the figures take them: a house's texture otherwise
        // goes into an sRGB buffer and draws dark under a StandardMaterial.
        { pluginOptions: { gltf: { useSRGBBuffers: false } } },
      ),
    ),
  );

  const byModel = new Map(TERRAIN_MODELS.map((model, i) => [model, containers[i]]));

  const tops = new Map<TerrainModel, number>(
    TERRAIN_MODELS.map((model, i) => {
      const ys = containers[i].meshes
        .filter((mesh) => mesh.getTotalVertices() > 0)
        .map((mesh) => mesh.getBoundingInfo().boundingBox.maximumWorld.y);
      return [model, ys.length > 0 ? Math.max(...ys) : 0];
    }),
  );
  const bottoms = new Map<TerrainModel, number>(
    TERRAIN_MODELS.map((model, i) => {
      const ys = containers[i].meshes
        .filter((mesh) => mesh.getTotalVertices() > 0)
        .map((mesh) => mesh.getBoundingInfo().boundingBox.minimumWorld.y);
      return [model, ys.length > 0 ? Math.min(...ys) : 0];
    }),
  );
  const sharedMaterials = new Map<string, StandardMaterial>();

  return {
    topOf(model) {
      return tops.get(model) ?? 0;
    },
    bottomOf(model) {
      return bottoms.get(model) ?? 0;
    },
    instantiate(model, name, paint) {
      const container = byModel.get(model);
      if (!container) throw new Error(`no terrain model: ${model}`);

      const holder = new TransformNode(name, scene);
      const entries = container.instantiateModelsToScene((source) => `${name}-${source}`, false);
      for (const root of entries.rootNodes) root.parent = holder;

      for (const mesh of holder.getChildMeshes()) {
        shareMaterial(scene, model, mesh, sharedMaterials, paint);
      }
      return holder;
    },
  };
}

/**
 * Repaints, by the prefix of the models they apply to and the material they
 * replace. The kit reuses a handful of materials across everything it ships,
 * which three times now has made two kinds of tile the same object on the
 * board. Recolouring is the answer every time: the *shapes* were never the
 * problem, and in each case the model was doing exactly what it was built to.
 *
 * ⚠️ An entry supplies a **name** as well as a colour, because merging groups
 * meshes by material name. Two colours sharing one name would merge into
 * whichever happened to win.
 *
 * - **Roads** are painted `dirt`/`dirtDark`, the same two a riverbank is, which
 *   left a road and a river near enough identical — one just had water down the
 *   middle. A cool grey gravel separates it from the warm bank.
 * - **A mesa's body** is `dirt`, the same warm orange as every riverbank, which
 *   made a peak read as a clay mound rather than as rock. Grey stone says rock
 *   and leaves the grass cap alone -- the cap is the half that should stay
 *   green, because it is what a unit stands on.
 * - **Scenery on open ground** is painted the *exact* green of the ground it
 *   stands on, which makes a grass tuft on grass invisible by construction.
 *   ⚠️ It does not render dark, whatever it looks like: measured against the
 *   board it comes out between `#17725f` and `#24b499` where the ground is
 *   `#27c0a4` — the same hue, merely shaded, which reads as a smudge rather
 *   than a plant. Lighting was not the problem and lighting could not fix it;
 *   a warmer, lighter green is what separates a thing growing on the ground
 *   from the ground.
 */
const FOLIAGE = { name: 'foliage', color: new Color3(0.63, 0.97, 0.5) };
const ROAD_SURFACE = { name: 'roadSurface', color: new Color3(0.62, 0.62, 0.6) };

const RECOLOUR: Record<string, Record<string, { name: string; color: Color3 }>> = {
  rock_: {
    dirt: { name: 'mesaStone', color: new Color3(0.58, 0.64, 0.66) },
  },
  ground_path: {
    dirt: ROAD_SURFACE,
    dirtDark: { name: 'roadEdge', color: new Color3(0.47, 0.47, 0.46) },
  },
  // ⚠️ **A bridge's deck ships the same pale blue as river water** -- (184, 226,
  // 232) against water's (176, 244, 255) -- so a crossing rendered as a wooden
  // frame with the river apparently running straight through it. Opaque the
  // whole time; it simply matched what was underneath. ⚠️ It takes the *road's*
  // name rather than a bridge one of its own, so the deck is the same object as
  // the road either side and the surface visibly continues over the water --
  // which is what a bridge is. Sharing the name also costs no extra draw call.
  bridge_: {
    stone: ROAD_SURFACE,
  },
  // ⚠️ Safe as prefixes only because no *ground* model begins with any of
  // them -- the board's own grass is `ground_grass`.
  grass: { grass: FOLIAGE },
  plant_: { grass: FOLIAGE },
  flower_: { grass: FOLIAGE },
};

/** A colour a cell asks for, where `RECOLOUR` paints by model. */
export type Paint = 'sea' | 'paved';

const PAINT: Record<Paint, Record<string, { name: string; color: Color3 }>> = {
  // ⚠️ Deep, so open sea never reads as water anyone could wade; and teal
  // rather than blue, so the blue army's pieces do not sink into it.
  sea: { water: { name: 'seaWater', color: new Color3(0.1, 0.32, 0.42) } },
  // The road's own surface, so a building meets the road it stands beside.
  paved: { grass: ROAD_SURFACE },
};

function recolour(model: TerrainModel, materialName: string, paint?: Paint) {
  const painted = paint && PAINT[paint][materialName];
  if (painted) return painted;
  for (const prefix in RECOLOUR) {
    if (model.startsWith(prefix)) return RECOLOUR[prefix][materialName];
  }
  return undefined;
}

/**
 * One flat material per name, shared by every mesh that asked for it.
 *
 * ⚠️ The loaded material is *replaced*, not reused. The kit ships PBR materials
 * with `metallicFactor: 1`, and a fully metallic surface has no diffuse
 * response — with no environment map to reflect, a whole board renders as blank
 * white. Taking the albedo onto a plain matte `StandardMaterial` also puts
 * terrain and units in the same lighting model, which is the other half of why
 * they used to look like different substances.
 *
 * The kit paints with flat colours and the houses with a texture each, which is
 * carried over with the sides they are drawn from: a house's walls are single
 * planes, seen from inside as well as out.
 */
function shareMaterial(
  scene: Scene,
  model: TerrainModel,
  mesh: AbstractMesh,
  shared: Map<string, StandardMaterial>,
  paint?: Paint,
): void {
  const source = mesh.material;
  if (!source) return;

  const override = recolour(model, source.name, paint);
  const key = override?.name ?? source.name;

  const existing = shared.get(key);
  if (existing) {
    mesh.material = existing;
    return;
  }

  const flat = new StandardMaterial(`terrain-${key}`, scene);
  flat.diffuseColor =
    override?.color ??
    (source instanceof PBRMaterial ? source.albedoColor.clone() : new Color3(1, 1, 1));
  flat.specularColor = new Color3(0, 0, 0);
  if (source instanceof PBRMaterial && source.albedoTexture) {
    flat.diffuseTexture = source.albedoTexture;
    flat.backFaceCulling = source.backFaceCulling;
  }
  // Keyed by the name merging will group on, which is why an override has to
  // supply one: two colours under one name would merge into whichever won.
  shared.set(key, flat);
  mesh.material = flat;
}
