import { describe, expect, it } from 'bun:test';
import {
  chargeChance,
  chargeDamage,
  chargeReady,
  computeDamage,
  refuseCharge,
  resolveBattle,
  resolveCharge,
} from './combat';
import { CHARGE_CHANCE_AT_FULL, CHARGE_FACING, LUCK_MAX } from './data/combat';
import { getUnitType, MAX_HEALTH } from './data/unitTypes';
import type { UnitTypeId } from './data/unitTypes';
import { at, fullMeter, makeState } from './testing';
import type { Facing, GameState, Unit } from './types';

const unit = (state: GameState, id: string): Unit => state.units.find((u) => u.id === id)!;

/**
 * A full-meter cavalryman just south of an infantryman, the target on road --
 * no cover -- unless told otherwise. ⚠️ The target looks `south` by default -- straight at
 * the charger -- so a charge is head-on unless a test turns it.
 */
const contact = ({
  health = MAX_HEALTH,
  facing = 'south' as Facing,
  ground = '-',
  charger = MAX_HEALTH,
  meter = fullMeter('cavalry'),
} = {}) =>
  makeState(
    ['...', '.-.', `.${ground}.`],
    [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', health: charger, chargeMeter: meter },
      { id: 'r1', col: 1, row: 2, owner: 'red', health, facing },
    ],
  );

const charge = (state: GameState) => chargeDamage(state, unit(state, 'b1'), unit(state, 'r1'));
const bestAttack = (state: GameState) =>
  computeDamage(state, unit(state, 'b1'), unit(state, 'r1'), LUCK_MAX);

describe('attacksToCharge, which is also the capability rule', () => {
  it('is set for every type but artillery', () => {
    for (const type of ['infantry', 'cavalry', 'general'] as const) {
      expect(getUnitType(type).attacksToCharge).not.toBeNull();
    }
    expect(getUnitType('artillery').attacksToCharge).toBeNull();
  });
});

describe('chargeReady', () => {
  const cavalry = (chargeMeter: number) =>
    unit(makeState(3, [{ id: 'b1', col: 0, row: 0, unitTypeId: 'cavalry', chargeMeter }]), 'b1');

  it('is ready at its type’s size and above it, and not below', () => {
    const full = fullMeter('cavalry');
    expect(chargeReady(cavalry(full - 1))).toBe(false);
    expect(chargeReady(cavalry(full))).toBe(true);
    expect(chargeReady(cavalry(full + 1))).toBe(true);
  });

  it('is never ready for a type that cannot charge, whatever its meter', () => {
    for (const chargeMeter of [0, 1, 99]) {
      const gun = makeState(3, [
        { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery', chargeMeter },
      ]);
      expect(chargeReady(unit(gun, 'b1'))).toBe(false);
    }
  });

  it('is never ready for a meter read back without the field', () => {
    const stored: Partial<Unit> = { ...cavalry(fullMeter('cavalry')) };
    delete stored.chargeMeter;
    expect(chargeReady(stored as Unit)).toBe(false);
  });
});

describe('chargeDamage', () => {
  // ⚠️ **The attack formula, not a second one**: cover and the charger's own
  // health have to work as they do in an attack, which head-on equality on every
  // ground and at every strength is what says.
  it('is an attack at its best roll, head-on, on any ground and at any strength', () => {
    for (const ground of ['-', '.', 'f', '^']) {
      for (const charger of [100, 70, 40]) {
        for (const health of [100, 50, 10]) {
          const state = contact({ ground, charger, health });
          expect(charge(state)).toBe(Math.floor((bestAttack(state) * CHARGE_FACING.front) / 100));
        }
      }
    }
  });

  it('multiplies it by the side it arrives on', () => {
    const flank = contact({ facing: 'east' });
    const rear = contact({ facing: 'north' });
    expect(charge(flank)).toBe(Math.floor((bestAttack(flank) * CHARGE_FACING.flank) / 100));
    expect(charge(rear)).toBe(Math.floor((bestAttack(rear) * CHARGE_FACING.rear) / 100));
  });

  it('always gives the defender a better chance head-on', () => {
    const front = charge(contact({ facing: 'south' }));
    const flank = charge(contact({ facing: 'east' }));
    const rear = charge(contact({ facing: 'north' }));
    expect(front).toBeLessThan(flank);
    expect(flank).toBeLessThan(rear);
  });

  it('reads the side from where the charger stands', () => {
    const state = contact({ facing: 'south' });
    const fromWest = { ...unit(state, 'b1'), position: at(0, 2) };
    expect(chargeDamage(state, fromWest, unit(state, 'r1'))).toBe(
      charge(contact({ facing: 'east' })),
    );
  });
});

describe('refuseCharge', () => {
  const b1 = (state: GameState) => unit(state, 'b1');

  // ⚠️ **Offered whatever its odds.** How strong the target is decides the
  // chance, not whether a charge may be tried.
  it('offers a charge against a target at full health', () => {
    const state = contact();
    expect(refuseCharge(state, b1(state), [at(1, 1)], 'r1')).toBeNull();
  });

  it('refuses a charger whose meter is not full', () => {
    const state = contact({ health: 1, meter: fullMeter('cavalry') - 1 });
    expect(refuseCharge(state, b1(state), [at(1, 1)], 'r1')).toBe('the charge meter is not full');
  });

  // A match stored before a size came down holds a meter above it.
  it('accepts a meter above its type’s size', () => {
    const state = contact({ meter: fullMeter('cavalry') + 1 });
    expect(refuseCharge(state, b1(state), [at(1, 1)], 'r1')).toBeNull();
  });

  // ⚠️ Contact, never the attacker's range band. Infantry reaches two tiles, so
  // reusing `refuseAttack` here would permit a "charge" from a distance.
  it('refuses anything that is not contact', () => {
    const apart = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'infantry', chargeMeter: fullMeter('infantry') },
      { id: 'r1', col: 1, row: 3, owner: 'red', health: 1 },
    ]);
    expect(refuseCharge(apart, b1(apart), [at(1, 1)], 'r1')).toBe('a charge has to reach them');
  });

  // A meter of its own, so the refusal is for what it is and not an empty meter.
  it('refuses a type that cannot charge', () => {
    const guns = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'artillery', chargeMeter: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 1 },
    ]);
    expect(refuseCharge(guns, b1(guns), [at(1, 1)], 'r1')).toBe('artillery cannot charge');
  });

  it('refuses a friend and refuses itself', () => {
    const friendly = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'b2', col: 1, row: 2, health: 1 },
    ]);
    expect(refuseCharge(friendly, b1(friendly), [at(1, 1)], 'b2')).toBe('that unit is yours');
    expect(refuseCharge(friendly, b1(friendly), [at(1, 1)], 'b1')).toBe('that unit is yours');
  });

  // ⚠️ **The rule `entryCost` could not answer, and it is currently
  // unreachable.** A charge displaces onto the target's tile, so the attacker
  // has to be able to stand there -- and `entryCost` refuses that tile for being
  // enemy-held, which is the one objection a charge is not troubled by.
  // `terrainAdmits` is the shared half.
  //
  // ⚠️ **Nothing that can charge is barred from anywhere any more.** Only
  // `foot` and `horse` units charge, and both can enter every terrain on the
  // board -- `wheels` is the only movement type with a `null`, and artillery
  // cannot charge. So this asserts the *reachable* truth.
  it('allows a charge onto water', () => {
    const river = contact({ health: 1, ground: '~' });
    expect(refuseCharge(river, b1(river), [at(1, 1)], 'r1')).toBeNull();
  });

  // ⚠️ **The guard stays despite having nothing to catch**, and cheaply: a unit
  // type that charges on `wheels`, or a terrain barred to `foot`, brings it back
  // the same day it is added.
  it('allows ground the attacker can stand on, enemy or not', () => {
    const wood = contact({ health: 1, ground: 'f' });
    expect(refuseCharge(wood, b1(wood), [at(1, 1)], 'r1')).toBeNull();
  });
});

describe('chargeChance', () => {
  const chance = (state: GameState) => chargeChance(state, unit(state, 'b1'), unit(state, 'r1'));

  // With no cover a target's health does not move the damage, so the line can
  // be read off a full-health one.
  it('is certain where the charge would kill, and not one point over', () => {
    const line = charge(contact());
    expect(chance(contact({ health: line }))).toBe(100);
    expect(chance(contact({ health: line + 1 }))).toBeLessThan(100);
  });

  it('falls to the head-on share of CHARGE_CHANCE_AT_FULL against full health, at full strength', () => {
    expect(chance(contact())).toBe(Math.floor((CHARGE_CHANCE_AT_FULL * CHARGE_FACING.front) / 100));
  });

  // The end is scaled by the side like everything else about a charge, so
  // getting round a unit still pays against one at full health.
  it('scales that end by the side the charge arrives on', () => {
    for (const [facing, side] of [
      ['east', 'flank'],
      ['north', 'rear'],
    ] as const) {
      const state = contact({ facing });
      // ⚠️ Only while a full-health target is over the line. A side multiplier
      // or luck band wide enough to make the charge certain reads as certain,
      // which is the rule and not a failure of it.
      const scaledEnd = Math.floor((CHARGE_CHANCE_AT_FULL * CHARGE_FACING[side]) / 100);
      expect(chance(state)).toBe(charge(state) >= MAX_HEALTH ? 100 : scaledEnd);
    }
  });

  it('never rises as the target gets healthier', () => {
    for (const ground of ['-', '.', 'f', '^']) {
      const odds = [...Array(MAX_HEALTH).keys()].map((h) =>
        chance(contact({ ground, health: h + 1 })),
      );
      expect(odds).toEqual([...odds].sort((a, b) => b - a));
    }
  });

  // ⚠️ **Scaled across the whole curve, not only at its end**, so a wounded
  // charger's gamble stays a long shot -- even just over its own line, which is
  // the cliff this accepts.
  it('scales everything over the line by the charger’s own health', () => {
    expect(chance(contact({ charger: 60 }))).toBe(Math.floor((chance(contact()) * 60) / 100));
    const line = charge(contact({ charger: 60 }));
    expect(chance(contact({ charger: 60, health: line + 1 }))).toBeLessThanOrEqual(60);
  });

  it('never falls under 1%', () => {
    expect(chance(contact({ charger: 1 }))).toBe(1);
  });

  it('reads the side from where the charger stands', () => {
    const state = contact({ facing: 'south' });
    const fromWest = { ...unit(state, 'b1'), position: at(0, 2) };
    expect(chargeChance(state, fromWest, unit(state, 'r1'))).toBe(
      chance(contact({ facing: 'east' })),
    );
  });
});

describe('resolveCharge', () => {
  const resolve = (state: GameState, roll: number, counter = 0) =>
    resolveCharge(state, unit(state, 'b1'), unit(state, 'r1'), {
      attack: 0,
      counter,
      charge: roll,
    });

  it('kills the target, spends the meter, and costs the charger nothing when it breaks', () => {
    const battle = resolve(contact({ charger: 60 }), 0);
    expect(battle.kind).toBe('charge');
    expect(battle.defender.health).toBe(0);
    expect(battle.attacker.health).toBe(60);
    expect(battle.attacker.chargeMeter).toBe(0);
    expect(battle.answered).toBe(false);
  });

  it('breaks through on any roll where it is certain', () => {
    expect(resolve(contact({ health: 10 }), 99).defender.health).toBe(0);
  });

  // ⚠️ **A free attack, whatever the counter rule says**: the defender's own
  // attack on the charger, with the counter roll.
  it('meets a failed charge with the defender’s own attack, and still spends the meter', () => {
    const state = contact();
    const battle = resolve(state, CHARGE_CHANCE_AT_FULL, LUCK_MAX);
    const free = computeDamage(state, unit(state, 'r1'), unit(state, 'b1'), LUCK_MAX);
    expect(battle.defender.health).toBe(MAX_HEALTH);
    expect(battle.attacker.health).toBe(MAX_HEALTH - free);
    expect(battle.attacker.chargeMeter).toBe(0);
    expect(battle.answered).toBe(true);
  });

  it('can kill the charger when it fails', () => {
    expect(resolve(contact({ charger: 5 }), 99).attacker.health).toBe(0);
  });
});

describe('the charge meter', () => {
  const meterAfterAttacking = (unitTypeId: UnitTypeId, chargeMeter: number) => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId, chargeMeter },
      { id: 'r1', col: 1, row: 2, owner: 'red', facing: 'south' },
    ]);
    const rolls = { attack: 0, counter: 0 };
    return resolveBattle(state, unit(state, 'b1'), unit(state, 'r1'), rolls).attacker.chargeMeter;
  };

  it('fills a point for every attack, up to its type’s size', () => {
    for (const type of ['infantry', 'cavalry', 'general'] as const) {
      const full = fullMeter(type);
      expect(meterAfterAttacking(type, 0)).toBe(1);
      expect(meterAfterAttacking(type, full - 1)).toBe(full);
      expect(meterAfterAttacking(type, full)).toBe(full);
    }
  });

  // A match stored before a size came down holds a meter above it.
  it('brings a meter above its type’s size down to it', () => {
    const full = fullMeter('cavalry');
    expect(meterAfterAttacking('cavalry', full + 1)).toBe(full);
  });

  it('never fills for a unit that cannot charge', () => {
    expect(meterAfterAttacking('artillery', 0)).toBe(0);
  });
});
