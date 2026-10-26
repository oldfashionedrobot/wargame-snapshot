import { describe, expect, it } from 'vitest';
import { BAND, bandRect } from './band';

describe('the band', () => {
  it('stands as tall as it may on a wide canvas, two square halves, centred', () => {
    const rect = bandRect(1280, 720);
    expect(rect.height).toBe(720 * BAND.height);
    expect(rect.width).toBe(2 * rect.height + BAND.divider);
    expect(rect.left).toBe((1280 - rect.width) / 2);
    expect(rect.top).toBe((720 - rect.height) / 2);
  });

  it('narrows to the canvas on a narrow one, keeping its halves square', () => {
    const rect = bandRect(400, 800);
    expect(rect.width).toBeCloseTo(400 * BAND.width);
    expect((rect.width - BAND.divider) / 2).toBeCloseTo(rect.height);
  });
});
