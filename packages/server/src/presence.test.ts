import { describe, expect, it } from 'bun:test';
import type { GuestId } from './guest';
import { AWAY_AFTER_MS, createPresence } from './presence';

const ME = 'me' as GuestId;
const THEM = 'them' as GuestId;

describe('createPresence', () => {
  it('counts only others as here, and only those heard from lately', () => {
    let clock = 0;
    const presence = createPresence(() => clock);
    presence.heard('m', ME);
    expect(presence.othersHere('m', ME)).toBe(false);

    presence.heard('m', THEM);
    expect(presence.othersHere('m', ME)).toBe(true);
    clock = AWAY_AFTER_MS - 1;
    expect(presence.othersHere('m', ME)).toBe(true);
    clock = AWAY_AFTER_MS;
    expect(presence.othersHere('m', ME)).toBe(false);
  });

  // ⚠️ A hidden tab polls every thirty seconds, and is still here.
  it("keeps a hidden tab's player here between its polls", () => {
    let clock = 0;
    const presence = createPresence(() => clock);
    for (; clock < 5 * 60_000; clock += 30_000) {
      presence.heard('m', THEM);
      expect(presence.othersHere('m', ME)).toBe(true);
    }
  });

  it('keeps each match to its own players', () => {
    const presence = createPresence(() => 0);
    presence.heard('m', THEM);
    expect(presence.othersHere('other', ME)).toBe(false);
  });

  it('answers the same for a match the sweep has cleared out', () => {
    let clock = 0;
    const presence = createPresence(() => clock);
    presence.heard('m', THEM);
    clock = 2 * AWAY_AFTER_MS;
    presence.heard('n', ME);
    expect(presence.othersHere('m', ME)).toBe(false);
    presence.heard('m', THEM);
    expect(presence.othersHere('m', ME)).toBe(true);
  });
});
