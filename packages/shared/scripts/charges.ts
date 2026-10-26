/**
 * What a charge is certain to finish, beside what an attack would, and its odds
 * against a target at full health.
 *
 *     bun packages/shared/scripts/charges.ts
 *
 * ⚠️ **The companion to `matchups.ts`, printed as kill lines rather than hits.**
 * A charge is certain at or under its line and a gamble above it, so the
 * question is *how worn down a target has to be*: the most health a charge is
 * sure to finish, head-on, from the flank and from the rear, next to the most an
 * attack is sure to kill at its worst roll and might kill at its best. A charge
 * is an attack's best roll times the side, so the head-on line equals the second
 * of those. The odds run down from each line to the last three columns, the
 * chance against a full-health target -- see `chargeChance`.
 *
 * ⚠️ **Per ground and per charger health**, because both move the lines: cover
 * and the attacker's band work as they do in an attack.
 */
import { chargeChance, chargeDamage, computeDamage } from '../src/combat';
import { LUCK_MAX } from '../src/data/combat';
import { TERRAIN } from '../src/data/terrain';
import { getUnitType, UNIT_TYPE_IDS } from '../src/data/unitTypes';
import type { UnitTypeId } from '../src/data/unitTypes';
import { makeState } from '../src/testing';
import type { Facing } from '../src/types';

const CHARGERS = [100, 70, 40];
// ⚠️ **Read off `TERRAIN`**, as `matchups.ts` does, so a new ground is not
// silently missing -- one per level of cover, since cover is all ground changes
// in a charge.
const GROUNDS = Object.entries(TERRAIN)
  .filter(
    ([, terrain], i, all) => all.findIndex(([, other]) => other.defense === terrain.defense) === i,
  )
  .map(([name, { char }]) => [name, char] as const);
const NAME_WIDTH = Math.max(...GROUNDS.map(([name]) => name.length)) + 1;

/**
 * ⚠️ The **defender's** facing decides the side, so the approach is set by
 * turning the target rather than by moving the attacker: `south` looks straight
 * at a charger coming from the south, `east` takes it on the flank, `north`
 * looks away.
 */
const SIDES: Facing[] = ['south', 'east', 'north'];

const board = (
  attacker: UnitTypeId,
  charger: number,
  defender: UnitTypeId,
  health: number,
  facing: Facing,
  ground: string,
) =>
  makeState(
    ['...', '.-.', `.${ground}.`],
    [
      { id: 'b1', col: 1, row: 1, unitTypeId: attacker, health: charger },
      { id: 'r1', col: 1, row: 2, owner: 'red', unitTypeId: defender, health, facing },
    ],
  );

/** The most health a target can have and still die to `damage`, read at every health. */
const killLine = (damage: (health: number) => number) => {
  let line = 0;
  for (let health = 1; health <= 100; health++) if (damage(health) >= health) line = health;
  return line;
};

console.log(
  'attack sure–might kill | charge certain head-on / flank / rear | charge odds against full health',
);

for (const attacker of UNIT_TYPE_IDS.filter((type) => getUnitType(type).attacksToCharge !== null)) {
  for (const defender of UNIT_TYPE_IDS) {
    console.log(`\n${attacker} → ${defender}`);
    for (const charger of CHARGERS) {
      for (const [name, char] of GROUNDS) {
        const attack = (roll: number) =>
          killLine((health) => {
            const state = board(attacker, charger, defender, health, 'south', char);
            return computeDamage(state, state.units[0], state.units[1], roll);
          });
        const charge = SIDES.map((facing) =>
          killLine((health) => {
            const state = board(attacker, charger, defender, health, facing, char);
            return chargeDamage(state, state.units[0], state.units[1]);
          }),
        );
        const odds = SIDES.map((facing) => {
          const state = board(attacker, charger, defender, 100, facing, char);
          return `${chargeChance(state, state.units[0], state.units[1])}%`;
        });
        console.log(
          `  ${`${charger}hp`.padEnd(7)}${name.padEnd(NAME_WIDTH)}${`${attack(0)}–${attack(LUCK_MAX)}`.padEnd(9)}| ${charge.join(' / ').padEnd(16)}| ${odds.join(' / ')}`,
        );
      }
    }
  }
}
