import type { Scene } from '@babylonjs/core/scene';

/**
 * Calls `step` once a frame with the animation time since it began, in
 * milliseconds, until it returns false.
 *
 * ⚠️ **The scene's animation time, the clock the figures already run on** --
 * never a timer. A hidden tab draws no frames, so nothing here advances either;
 * on return Babylon advances by the whole time away in one frame, and this
 * sees the same jump the animations do. A timer would run on, throttled, out
 * of step with animation that had stopped.
 */
export function everyFrame(scene: Scene, step: (elapsed: number) => boolean): Promise<void> {
  return new Promise((resolve) => {
    let elapsed = 0;
    const observer = scene.onAfterAnimationsObservable.add(() => {
      elapsed += scene.deltaTime || 0;
      if (step(elapsed)) return;
      scene.onAfterAnimationsObservable.remove(observer);
      resolve();
    });
  });
}

/** Resolves once `ms` of animation time has passed. */
export function wait(scene: Scene, ms: number): Promise<void> {
  return everyFrame(scene, (elapsed) => elapsed < ms);
}
