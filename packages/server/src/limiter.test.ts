import { describe, expect, it } from 'bun:test';
import { createLimiter } from './limiter';

const ALLOWANCE = { count: 2, windowMs: 10_000 };

describe('createLimiter', () => {
  it('spends its allowance, then answers the whole seconds left in the window', () => {
    let clock = 0;
    const limiter = createLimiter(() => clock);
    expect(limiter.take('a', ALLOWANCE)).toBe(0);
    clock = 2_500;
    expect(limiter.take('a', ALLOWANCE)).toBe(0);
    expect(limiter.take('a', ALLOWANCE)).toBe(8);
    clock = 9_999;
    expect(limiter.take('a', ALLOWANCE)).toBe(1);
  });

  it('opens a new window once the old one ends', () => {
    let clock = 0;
    const limiter = createLimiter(() => clock);
    for (let i = 0; i < ALLOWANCE.count; i++) limiter.take('a', ALLOWANCE);
    clock = ALLOWANCE.windowMs;
    expect(limiter.take('a', ALLOWANCE)).toBe(0);
  });

  it('keeps each key to its own count', () => {
    const limiter = createLimiter(() => 0);
    for (let i = 0; i < ALLOWANCE.count; i++) limiter.take('a', ALLOWANCE);
    expect(limiter.take('a', ALLOWANCE)).toBeGreaterThan(0);
    expect(limiter.take('b', ALLOWANCE)).toBe(0);
  });
});
