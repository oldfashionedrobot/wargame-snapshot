// Side effect: registers the .gltf/.glb SceneLoader plugin. The 2.0 entry
// point is deliberate -- it skips the legacy glTF 1.0 loader, and importing
// the package root would pull both.
import '@babylonjs/loaders/glTF/2.0';
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import type { PlayerColor } from '@wargame/shared';
import { FIGURE_FILES, figureFile } from './figures';
import type { Motion, Role } from './figures';

/** One figure's model, posed by name. */
export interface Figure {
  /** Ours, to place and turn and hang things from. */
  node: TransformNode;
  /** The model alone beneath `node`, to size without sizing what else hangs there. */
  model: TransformNode;
  /** Loops a motion; asking for the one already playing changes nothing. */
  play(motion: Motion): void;
  /** Plays a motion through once and holds its last frame, resolving when it ends. */
  playOnce(motion: Motion): Promise<void>;
  /**
   * Removes the figure with everything instantiating it made. ⚠️ Not only the
   * node: the skeleton and the animation groups are the figure's own copies and
   * belong to the scene, and a group left behind animates a dead skeleton.
   */
  dispose(): void;
}

export interface UnitModels {
  /** A fresh figure of this role for this side, standing. */
  instantiate(role: Role, color: PlayerColor, name: string): Figure;
}

/**
 * Loads every figure once, into containers that stay out of the scene -- both
 * armies, since every match fields both, and the cutaway's gunners and crew.
 *
 * The models are small and local, but this is still I/O, which is why
 * `createGameRenderer` is async: a renderer whose units have not loaded is not
 * a renderer, and the alternative -- constructing empty and filling in later --
 * gives `syncUnits` and `playEvents` a window where a unit has no mesh.
 */
export async function loadUnitModels(scene: Scene): Promise<UnitModels> {
  const containers = await Promise.all(
    FIGURE_FILES.map((file) =>
      LoadAssetContainerAsync(`models/units/${file}.glb`, scene, {
        pluginOptions: {
          gltf: {
            // Left to itself the loader starts each file's first animation on
            // the container's own nodes, which nobody draws.
            animationStartMode: GLTFLoaderAnimationStartMode.NONE,
            // ⚠️ Raw bytes, as painted. By default a colour texture goes into an
            // sRGB buffer, decoded as it is sampled, which only PBR encodes again
            // on the way out -- `drawAsPainted`'s material would draw it dark.
            useSRGBBuffers: false,
          },
        },
      }),
    ),
  );
  for (const container of containers) drawAsPainted(container, scene);
  const byFile = new Map<string, AssetContainer>(
    FIGURE_FILES.map((file, i) => [file, containers[i]]),
  );

  return {
    instantiate(role, color, name) {
      const file = figureFile(role, color);
      const container = byFile.get(file);
      if (!container) throw new Error(`no figure loaded: ${file}`);

      // Nodes of our own, with the loaded model beneath them.
      //
      // Not decoration: the glTF loader puts a `__root__` node above the model
      // carrying the right-handed-to-left-handed conversion, which is a
      // negative scale. Setting our facing rotation on *that* node composes
      // with the flip and turns the unit the wrong way. Rotating a parent of
      // it leaves the conversion alone.
      const node = new TransformNode(name, scene);
      const model = new TransformNode(`${name}-model`, scene);
      model.parent = node;
      // Clones, sharing the file's materials: nothing changes one unit's look.
      const entries = container.instantiateModelsToScene((source) => `${name}-${source}`, false);
      for (const root of entries.rootNodes) root.parent = model;

      const groups = new Map<string, AnimationGroup>(
        entries.animationGroups.map((group) => [group.name.slice(name.length + 1), group]),
      );
      let playing: AnimationGroup | null = null;
      const start = (motion: Motion, loop: boolean): AnimationGroup => {
        const group = groups.get(motion);
        if (!group) throw new Error(`${file} has no ${motion}`);
        playing?.stop();
        playing = group.start(loop);
        return group;
      };

      const figure: Figure = {
        node,
        model,
        play(motion) {
          if (playing === groups.get(motion) && playing?.isPlaying) return;
          start(motion, true);
        },
        playOnce(motion) {
          const group = start(motion, false);
          return new Promise((resolve) => {
            group.onAnimationGroupEndObservable.addOnce(() => resolve());
          });
        },
        dispose() {
          for (const group of entries.animationGroups) group.dispose();
          for (const skeleton of entries.skeletons) skeleton.dispose();
          // ⚠️ Not the materials: every figure from a file shares them.
          node.dispose(false, false);
        },
      };
      // Never unposed: the model's rest is a T-pose.
      figure.play('stand');
      return figure;
    },
  };
}

/**
 * The file's materials swapped for unlit `StandardMaterial`s carrying the same
 * texture, once per file, so every figure cloned from it shares them: each
 * texel drawn as painted, whatever the light.
 *
 * ⚠️ Unlit because lit, a figure's sides fall into shadow under a light from
 * above exactly where its silhouette has to read, and a dark uniform -- the
 * Continentals' navy -- went black.
 */
function drawAsPainted(container: AssetContainer, scene: Scene): void {
  const swapped = new Map<PBRMaterial, StandardMaterial>();
  for (const mesh of container.meshes) {
    const source = mesh.material;
    if (!(source instanceof PBRMaterial)) continue;
    let painted = swapped.get(source);
    if (!painted) {
      painted = new StandardMaterial(`figure-${source.name}`, scene);
      painted.diffuseTexture = source.albedoTexture;
      // Two-sided where the file says so.
      painted.backFaceCulling = source.backFaceCulling;
      painted.disableLighting = true;
      // With no light the texture is multiplied by the emissive alone.
      painted.emissiveColor = Color3.White();
      swapped.set(source, painted);
    }
    mesh.material = painted;
  }
  // The texture stays: it is the new material's now.
  for (const source of swapped.keys()) source.dispose(false, false);
}
