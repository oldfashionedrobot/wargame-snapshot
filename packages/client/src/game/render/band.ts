/**
 * The cutaway's band: a modal over the board, two square halves side by side
 * with a divider between them, as Advance Wars lays out a battle. The camera
 * draws into it and the page frames it and prints its readout, both from
 * `bandRect`, so the two cannot disagree about where it is.
 *
 * ⚠️ **The readout's strip is reserved in the camera**, not left to the layout:
 * the stage fills its band, so a bar placed inside without it would cross the
 * figures' feet.
 */
export const BAND = {
  /** The tallest the band stands, as a share of the canvas's height. */
  height: 0.75,
  /** The widest it may be, as a share of the canvas's width. */
  width: 0.96,
  /** Each half's width over its height. */
  half: 1,
  /** The share of the band's height kept clear at its foot for the readout. */
  readout: 0.2,
  /** Between the two halves, in pixels. */
  divider: 10,
} as const;

/** Where a band sits, in pixels from the canvas's top left. */
export interface BandRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The band on a canvas this size: as tall as it may be, unless too wide, and centred. */
export function bandRect(canvasWidth: number, canvasHeight: number): BandRect {
  const height = Math.min(
    canvasHeight * BAND.height,
    (canvasWidth * BAND.width - BAND.divider) / (2 * BAND.half),
  );
  const width = 2 * BAND.half * height + BAND.divider;
  return {
    left: (canvasWidth - width) / 2,
    top: (canvasHeight - height) / 2,
    width,
    height,
  };
}
