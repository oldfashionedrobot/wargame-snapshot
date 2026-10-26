/** A point or a size on the board, in CSS pixels from the canvas's top-left. */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * How far a pane clears the tile it describes, in CSS pixels.
 *
 * ⚠️ On top of the renderer's world-space `ANCHOR_LIFT`, which does the real
 * work above a tile: this is the last few pixels. Below a tile there is no lift,
 * so it is the whole gap.
 */
export const PANE_CLEARANCE = 12;

/**
 * Where a pane anchored to a tile goes: its top-left corner.
 *
 * Centred over `above`, the point a tile's height over it, and shifted in from
 * the left and right edges so it stays on the board. ⚠️ **Flipped below the
 * tile when there is no room above**, hanging from `below`, the lowest the tile
 * itself reaches on screen -- the far row is where a pane above would leave the
 * canvas, and a pane shifted down instead would cover what it describes.
 *
 * ⚠️ A pane wider than the board sits at its left edge, where its start is
 * readable.
 */
export function fitPane(above: Point, below: number, pane: Size, board: Size): Point {
  const x = Math.max(0, Math.min(above.x - pane.width / 2, board.width - pane.width));
  const over = above.y - PANE_CLEARANCE - pane.height;
  return { x, y: over >= 0 ? over : below + PANE_CLEARANCE };
}
