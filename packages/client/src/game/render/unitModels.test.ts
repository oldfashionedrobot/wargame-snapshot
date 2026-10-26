import { describe, expect, it } from 'vitest';
import type { PlayerColor } from '@wargame/shared';
import { BODY, MOTIONS, figureFile } from './figures';
import type { Role } from './figures';

// The figures, as data URLs: a GLB is binary, and its JSON chunk is all this reads.
const FILES = import.meta.glob<string>('../../../public/models/units/**/*.glb', {
  query: '?inline',
  import: 'default',
  eager: true,
});

/** The names of a GLB's animations, read from its JSON chunk. */
function animationsOf(dataUrl: string): string[] {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as {
    animations?: { name: string }[];
  };
  return (json.animations ?? []).map((animation) => animation.name);
}

// Each file once: the gun is one file for both sides.
const figures = [
  ...new Map(
    (Object.keys(BODY) as Role[]).flatMap((role) =>
      (['blue', 'red'] as PlayerColor[]).map((color) => [figureFile(role, color), role] as const),
    ),
  ),
];

describe('the figures', () => {
  // ⚠️ The converter names the animations and the renderer asks for them by
  // name, in two languages; a figure missing one throws only once it is asked.
  it.each(figures)('%s answers to its whole body', (file, role) => {
    const glb = FILES[`../../../public/models/units/${file}.glb`];
    expect(glb).toBeDefined();
    expect(animationsOf(glb)).toEqual(expect.arrayContaining([...MOTIONS[BODY[role]]]));
  });
});
