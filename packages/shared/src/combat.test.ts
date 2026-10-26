import { describe, expect, it } from 'bun:test';
import type { Facing } from './types';
import { makeState } from './testing';
import { band, BANDS, computeDamage, tilesInRange, wouldCounter } from './combat';
import { BASE_DAMAGE, LUCK_MAX } from './data/combat';
import { TERRAIN } from './data/terrain';
import { getUnitType, MAX_HEALTH } from './data/unitTypes';
import type { GameState, Unit } from './types';

// Two units on a board whose terrain is chosen per test: the defender's tile is
// the only one that matters, since defence comes from terrain and nowhere else.
function fight(
  rows: string[],
  attacker: Partial<Unit> & { unitTypeId?: Unit['unitTypeId'] } = {},
  defender: Partial<Unit> & { unitTypeId?: Unit['unitTypeId'] } = {},
): { state: GameState; a: Unit; d: Unit } {
  const state = makeState(rows, [
    {
      id: 'a',
      col: 0,
      row: 0,
      unitTypeId: attacker.unitTypeId ?? 'infantry',
      health: attacker.health ?? MAX_HEALTH,
    },
    {
      id: 'd',
      col: 1,
      row: 0,
      owner: 'red',
      unitTypeId: defender.unitTypeId ?? 'infantry',
      health: defender.health ?? MAX_HEALTH,
    },
  ]);
  return { state, a: state.units[0], d: state.units[1] };
}

const HILLS = ['.^', '..']; // the defender stands on the peak
const ROAD = ['.-', '..']; // zero defence, so the terrain term vanishes

describe('computeDamage', () => {
  it('is the table value on open ground, at full health, with no luck', () => {
    const { state, a, d } = fight(ROAD);
    // Road is 0 stars, so the cover term is 100/100 and nothing is taken off.
    expect(computeDamage(state, a, d, 0)).toBe(BASE_DAMAGE.infantry.infantry);
  });

  // The property every matchup number depends on: the table is a percentage of
  // a full-health target, so it has to survive the trip through the formula
  // unchanged when nothing else is in play.
  it('passes every table entry through untouched on open ground', () => {
    for (const attacker of ['infantry', 'cavalry', 'artillery'] as const) {
      for (const defender of ['infantry', 'cavalry', 'artillery'] as const) {
        const { state, a, d } = fight(ROAD, { unitTypeId: attacker }, { unitTypeId: defender });
        expect(computeDamage(state, a, d, 0)).toBe(BASE_DAMAGE[attacker][defender]);
      }
    }
  });

  it('scales down with the attacker’s health, linearly', () => {
    const { state, a, d } = fight(ROAD, { health: 50 });
    expect(computeDamage(state, a, d, 0)).toBe(Math.floor(BASE_DAMAGE.infantry.infantry / 2));
  });

  // ⚠️ The sign check that matters. AW's published formula divides HP by 10
  // because its HP is 1-10; taken literally here, cover would exceed a whole hit
  // and hills would heal. Anything negative means the rescale was dropped.
  it('reduces damage on defended terrain rather than inverting it', () => {
    const { state, a, d } = fight(HILLS);
    const open = fight(ROAD);
    const defended = computeDamage(state, a, d, 0);

    expect(defended).toBeGreaterThan(0);
    expect(defended).toBeLessThan(computeDamage(open.state, open.a, open.d, 0));
    // A star takes a point off per band, and a full-health defender has them all.
    const left = 100 - TERRAIN.hills.defense * BANDS;
    expect(defended).toBe(Math.floor((BASE_DAMAGE.infantry.infantry * left) / 100));
  });

  // ⚠️ The table's order, not two named grounds: which ground shelters best
  // is a dial, and the rule is only that more defence takes more off.
  it('takes more off the more defence the ground has, in the table’s order', () => {
    const grounds = Object.values(TERRAIN).sort((a, b) => a.defense - b.defense);
    const damage = grounds.map(({ char }) => {
      const { state, a, d } = fight([`.${char}`, '..']);
      return computeDamage(state, a, d, 0);
    });
    for (let i = 1; i < damage.length; i++) expect(damage[i]).toBeLessThanOrEqual(damage[i - 1]);
    expect(damage[damage.length - 1]).toBeLessThan(damage[0]);
  });

  // Cover scales by *defender* health, which is what stops a damaged unit
  // turtling on a peak: the worse it gets, the less the ground does for it.
  it('gives a wounded defender less cover than a healthy one', () => {
    const healthy = fight(HILLS);
    const wounded = fight(HILLS, {}, { health: 20 });
    expect(computeDamage(wounded.state, wounded.a, wounded.d, 0)).toBeGreaterThan(
      computeDamage(healthy.state, healthy.a, healthy.d, 0),
    );
  });

  // At full strength into the open there is nothing to scale luck by, so the
  // whole band lands -- and no roll ever does worse than no luck at all.
  it('adds the whole luck band at full strength in the open, and never subtracts', () => {
    const { state, a, d } = fight(ROAD);
    const floorValue = computeDamage(state, a, d, 0);
    for (let roll = 0; roll <= LUCK_MAX; roll++) {
      const damage = computeDamage(state, a, d, roll);
      expect(damage).toBeGreaterThanOrEqual(floorValue);
      expect(damage).toBeLessThanOrEqual(floorValue + LUCK_MAX);
    }
    expect(computeDamage(state, a, d, LUCK_MAX)).toBe(floorValue + LUCK_MAX);
  });

  // ⚠️ **The spread narrows as the attacker weakens**, which is Advance Wars'
  // behaviour in every game: luck joins the base, and the attacker's band then
  // scales both. A unit on its last band cannot luck its way into an extra tenth.
  it('narrows the luck spread as the attacker weakens', () => {
    const spread = (health: number): number => {
      const { state, a, d } = fight(ROAD, { health });
      return computeDamage(state, a, d, LUCK_MAX) - computeDamage(state, a, d, 0);
    };
    expect(spread(MAX_HEALTH)).toBe(LUCK_MAX);
    expect(spread(50)).toBeLessThan(LUCK_MAX);
    expect(spread(50)).toBeGreaterThan(0);
    expect(spread(1)).toBeLessThanOrEqual(1);
  });

  // The same scaling from the other side: cover cuts luck as it cuts the rest.
  it('lets cover take its share of luck', () => {
    const spread = (rows: string[]): number => {
      const { state, a, d } = fight(rows);
      return computeDamage(state, a, d, LUCK_MAX) - computeDamage(state, a, d, 0);
    };
    expect(spread(HILLS)).toBeLessThan(spread(ROAD));
  });

  it('never returns a negative number', () => {
    const { state, a, d } = fight(HILLS, { health: 1 }, { unitTypeId: 'artillery' });
    expect(computeDamage(state, a, d, 0)).toBeGreaterThanOrEqual(0);
  });

  // ⚠️ **The tuning guard, and the reason both HP terms read a band.** Before
  // banding, a cavalry unit at 4 health or less dealt *zero* to infantry in
  // forest even on a maximum roll -- so two wounded units could be permanently
  // unable to kill each other, with elimination the only way a match ends.
  //
  // This sweeps every matchup on every terrain at every health, with the worst
  // possible roll. It is a statement about the *table* as much as the formula:
  // drop a base value far enough and the floors will swallow it again, and this
  // is what says so before a playtest does.
  //
  // ⚠️ **The terrains come from `TERRAIN`, never a list written out here.** A
  // copy would leave a newly added ground unswept by the one test that guards
  // the tuning, and it would pass while doing it.
  //
  // ⚠️ **It is also the limit on how many stars ground may carry**: cover
  // enough to floor the weakest hit to nothing fails here, well before cover
  // could reach a whole hit and heal.
  it('leaves no living attacker harmless, in any matchup on any terrain', () => {
    const types = ['infantry', 'cavalry', 'artillery'] as const;
    for (const terrain of Object.values(TERRAIN).map((ground) => ground.char)) {
      for (const attacker of types) {
        for (const defender of types) {
          for (const health of [1, 4, 9, 10, 11, 50, 99, MAX_HEALTH]) {
            const { state, a, d } = fight(
              ['.' + terrain, '..'],
              { unitTypeId: attacker, health },
              { unitTypeId: defender },
            );
            // The whole case in the assertion, so a failure names the matchup
            // and terrain rather than just a line number.
            const damage = computeDamage(state, a, d, 0);
            expect(`${attacker}→${defender} on ${terrain} at ${health}: ${damage}`).not.toMatch(
              /: 0$/,
            );
          }
        }
      }
    }
  });

  // No guard does this: luck joins the base, and `band(0)` zeroes both.
  it('lets a dead attacker deal nothing, luck included', () => {
    const { state, a, d } = fight(ROAD, { health: 0 });
    expect(computeDamage(state, a, d, 0)).toBe(0);
    expect(computeDamage(state, a, d, LUCK_MAX)).toBe(0);
  });

  it('reads the defender’s terrain, not the attacker’s', () => {
    // Attacker on the peak, defender on the road: the peak must not protect it.
    const state = makeState(
      ['^-', '..'],
      [
        { id: 'a', col: 0, row: 0 },
        { id: 'd', col: 1, row: 0, owner: 'red' },
      ],
    );
    expect(computeDamage(state, state.units[0], state.units[1], 0)).toBe(
      BASE_DAMAGE.infantry.infantry,
    );
  });
});

// ⚠️ Exported so the board's health ring can draw one segment per band. Pinned
// here because the display's whole claim -- that it cannot promise precision the
// rules lack -- rests on this being the same function the formula reads.
describe('band', () => {
  it('runs 1 to BANDS and never reaches zero while alive', () => {
    expect(band(1)).toBe(1);
    expect(band(10)).toBe(1);
    expect(band(11)).toBe(2);
    expect(band(MAX_HEALTH)).toBe(BANDS);
  });

  // The boundary that decides whether 91 and 100 fight identically. They do.
  it('rounds up, so a whole band shares a step', () => {
    expect(band(91)).toBe(band(MAX_HEALTH));
    expect(band(90)).not.toBe(band(91));
  });
});

describe('wouldCounter', () => {
  // The attacker, standing where it attacked from: infantry unless a test says
  // otherwise, so every reach and facing case below is a ranged attack.
  const at = (col: number, row: number, unitTypeId: 'infantry' | 'cavalry' = 'infantry') =>
    makeState(8, [{ id: 'a', col, row, unitTypeId }]).units[0];
  // ⚠️ Facing `north` on purpose, because these attackers are all placed to the
  // north: an attack from directly behind is never answered, so a defender left
  // on the fixture's `south` default would refuse every one of them and this
  // whole block would assert the rear rule while reading as a range-band check.
  // The rear rule has its own block below.
  const unitAt = (
    col: number,
    row: number,
    unitTypeId: 'infantry' | 'cavalry' | 'artillery' = 'infantry',
    facing: Facing = 'north',
  ) => makeState(8, [{ id: 'd', col, row, owner: 'red', unitTypeId, facing }]).units[0];

  // ⚠️ **A slow unit never answers, whatever the distance.** A gun has to be
  // traversed, and cannot be swung round in time -- so this is not a band check
  // with a hole in it, it is the band never being consulted.
  it('never answers when the defender is slow', () => {
    const gun = unitAt(0, 0, 'artillery'); // slow, whatever its band
    for (const row of [1, 3, 5, 6]) expect(wouldCounter(gun, at(0, row))).toBe(false);
  });

  // ⚠️ **The band's `near` end is no longer observable here**, and that is a
  // consequence rather than a gap: artillery is the only unit with `min > 1`,
  // and it is slow, so a counter refused for being *too close* cannot happen.
  // `refuseAttack` still reads both ends, which is where that half is tested.
  // ⚠️ Both bounds are inclusive -- the formula's band and the counter's share
  // one predicate, so an exclusive bound here would be one everywhere.
  it('answers inside its own band, both ends included, and nowhere else', () => {
    const foot = unitAt(0, 0);
    const { min, max } = getUnitType('infantry').range;
    expect(wouldCounter(foot, at(0, min))).toBe(true);
    expect(wouldCounter(foot, at(0, max))).toBe(true);
    expect(wouldCounter(foot, at(0, max + 1))).toBe(false); // outranged
  });

  // ⚠️ A melee unit strikes back on its own turn, never in answer to a shot --
  // but a melee attack is still answered, by melee and ranged alike.
  it('lets a melee unit answer a melee attacker and never a ranged one', () => {
    const horse = unitAt(0, 0, 'cavalry');
    expect(wouldCounter(horse, at(0, 1))).toBe(false); // infantry, point-blank
    expect(wouldCounter(horse, at(0, 1, 'cavalry'))).toBe(true); // sabre on sabre
  });

  it('answers a melee attacker from a ranged defender', () => {
    expect(wouldCounter(unitAt(0, 0), at(0, 1, 'cavalry'))).toBe(true);
  });

  it('never answers when it did not survive', () => {
    const dead = makeState(8, [
      { id: 'd', col: 0, row: 0, owner: 'red', health: 0, facing: 'north' },
    ]).units[0];
    expect(wouldCounter(dead, at(0, 1))).toBe(false);
  });

  // Diagonals cost two, like every other distance in the game.
  it('measures in orthogonal steps', () => {
    const foot = unitAt(0, 0);
    // A diagonal whose steps add up to the far edge of the band exactly.
    const { max } = getUnitType('infantry').range;
    const across = Math.ceil(max / 2);
    const up = max - across;
    expect(wouldCounter(foot, at(across, up))).toBe(true);
    expect(wouldCounter(foot, at(across + 1, up))).toBe(false); // one step more
  });

  // ⚠️ The one place facing changes an exchange. Every case here is inside the
  // defender's range and would be answered but for the direction, which is what
  // makes it a test of the rear rule rather than of the band.
  describe('an attack from behind', () => {
    it('is never answered, at any distance it could have answered from', () => {
      const foot = unitAt(0, 4, 'infantry', 'south');
      expect(wouldCounter(foot, at(0, 5))).toBe(false); // adjacent, behind
      expect(wouldCounter(foot, at(0, 6))).toBe(false); // the far end of the band
    });

    it('still answers the same tiles from the front and the flanks', () => {
      const foot = unitAt(4, 4, 'infantry', 'south');
      expect(wouldCounter(foot, at(4, 3))).toBe(true); // front
      expect(wouldCounter(foot, at(5, 4))).toBe(true); // flank
      expect(wouldCounter(foot, at(3, 4))).toBe(true); // the other flank
      expect(wouldCounter(foot, at(4, 5))).toBe(false); // rear
    });

    // ⚠️ It only ever subtracts. A gun firing from outside the defender's band
    // is unanswered whichever way anyone is looking, so the rule cannot turn a
    // shot that was already safe into anything else -- and cannot be mistaken
    // for having granted a counter it did not.
    it('changes nothing about a shot that was out of range anyway', () => {
      // ⚠️ Infantry, not a gun: artillery returns false on `slow` before the
      // band is consulted, so it cannot show that the band is what refused.
      const foot = unitAt(0, 4, 'infantry', 'south');
      const beyond = getUnitType('infantry').range.max + 1;
      expect(wouldCounter(foot, at(0, 4 + beyond))).toBe(false); // rear *and* outranged
      expect(wouldCounter(foot, at(0, 4 - beyond))).toBe(false); // front, still outranged
    });
  });
});

describe('tilesInRange', () => {
  // ⚠️ The bands are read off the catalog, not written here: they are dials,
  // and a test that knew them by number would fail on a retune while still
  // describing the band it was written against.
  const foot = getUnitType('infantry').range;
  const gun = getUnitType('artillery').range;
  const SIZE = 7 + Math.max(foot.max, gun.max);
  const unit = (unitTypeId: 'infantry' | 'artillery') =>
    makeState(SIZE, [{ id: 'a', col: 5, row: 5, unitTypeId }]).units[0];
  const band = (unitTypeId: 'infantry' | 'artillery') =>
    tilesInRange(unit(unitTypeId), { col: 5, row: 5 }, SIZE, SIZE);
  const has = (tiles: { col: number; row: number }[], col: number, row: number) =>
    tiles.some((t) => t.col === col && t.row === row);

  // ⚠️ Reach, not targets: the band is drawn whether or not anything stands in
  // it, because a gun's reach is most of what makes it a gun.
  it('covers the whole band regardless of what is standing there', () => {
    const tiles = band('infantry');
    for (let d = foot.min; d <= foot.max; d++) expect(has(tiles, 5, 5 + d)).toBe(true);
    expect(has(tiles, 5, 5 + foot.max + 1)).toBe(false); // out of the band
  });

  it('excludes the tiles a minimum range forbids', () => {
    const tiles = band('artillery');
    for (let d = 0; d < gun.min; d++) expect(has(tiles, 5, 5 + d)).toBe(false); // the zone
    expect(has(tiles, 5, 5 + gun.min)).toBe(true); // the near edge of the band
    expect(has(tiles, 5, 5 + gun.max)).toBe(true); // the far edge
    expect(has(tiles, 5, 5 + gun.max + 1)).toBe(false);
  });

  // Diagonals cost two, like every other distance in the game -- so the band is
  // a diamond, and a square would quietly let a gun reach corners it cannot.
  it('is a diamond, not a square', () => {
    const tiles = band('infantry');
    const across = Math.ceil(foot.max / 2);
    const up = foot.max - across;
    expect(has(tiles, 5 + across, 5 + up)).toBe(true); // the far edge, in steps
    expect(has(tiles, 5 + across + 1, 5 + up)).toBe(false); // one step more
  });

  it('stays on the board at a corner', () => {
    const corner = makeState(12, [{ id: 'a', col: 0, row: 0, unitTypeId: 'artillery' }]).units[0];
    const tiles = tilesInRange(corner, { col: 0, row: 0 }, 12, 12);
    expect(tiles.every((t) => t.col >= 0 && t.row >= 0)).toBe(true);
  });
});
