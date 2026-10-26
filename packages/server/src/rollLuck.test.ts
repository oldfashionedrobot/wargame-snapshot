import { describe, expect, it } from 'bun:test';
import { LUCK_MAX } from '@wargame/shared';
import { rollLuck } from './rollLuck';

describe('rollLuck', () => {
  // ⚠️ Statistical, but not flaky: at ten equally likely values, missing either
  // end across two thousand draws has a probability of about 0.9^2000.
  // Both members flattened, since each is drawn the same way and both have to
  // be legal -- a bug in one draw and not the other is exactly what a single
  // pooled sample would hide.
  const rolls = Array.from({ length: 2000 }, () => rollLuck());
  const draws = rolls.flatMap(({ attack, counter }) => [attack, counter]);

  it('only ever produces whole numbers', () => {
    expect(draws.every(Number.isInteger)).toBe(true);
  });

  it('stays inside the luck band', () => {
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThanOrEqual(LUCK_MAX);
  });

  // ⚠️ Two independent draws, not one value copied into both slots. Sharing
  // them would make every counter exactly as lucky as the attack that provoked
  // it, which is a correlation nothing in the design asks for and no assertion
  // elsewhere would notice.
  it('draws the two independently', () => {
    expect(rolls.some(({ attack, counter }) => attack !== counter)).toBe(true);
  });

  // ⚠️ The one that earns this suite. `Math.random() * LUCK_MAX` instead of
  // `* (LUCK_MAX + 1)` keeps every value legal and simply never returns the
  // best one -- an attack that can never roll well, with nothing to notice.
  it('reaches both ends of it', () => {
    expect(draws).toContain(0);
    expect(draws).toContain(LUCK_MAX);
  });

  // ⚠️ 0..99, not 0..LUCK_MAX: a charge rolls against a *percentage*. Drawn on
  // the luck band, every charge above 9% would be certain -- legal, silent, and
  // it would read as the odds being far too generous rather than as a bug here.
  // Missing an end across two thousand draws is about 0.99^2000.
  it('rolls a charge across the whole percentage range', () => {
    const charges = rolls.map(({ charge }) => charge);
    expect(charges.every(Number.isInteger)).toBe(true);
    expect(Math.min(...charges)).toBe(0);
    expect(Math.max(...charges)).toBe(99);
  });

  it('draws from the source it is given', () => {
    expect(rollLuck(() => 0.999)).toEqual({ attack: LUCK_MAX, counter: LUCK_MAX, charge: 99 });
    expect(rollLuck(() => 0)).toEqual({ attack: 0, counter: 0, charge: 0 });
  });
});
