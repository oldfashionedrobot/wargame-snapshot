/**
 * What the combat tables actually mean, printed as hits-to-kill.
 *
 *     bun packages/shared/scripts/matchups.ts
 *
 * ⚠️ **Hits-to-kill is the artefact worth tuning against, not raw damage.** A
 * damage figure needs dividing by 100 in your head before it says anything; the
 * number of blows a unit survives is the thing a player actually experiences,
 * and it is where a matchup being wrong becomes obvious.
 *
 * ⚠️ This is the one thing in the repo that imports `shared/` while being
 * neither `server/` nor `client/`, which is only possible *because* `shared/` is
 * pure: no browser, no server, no database, and rolls are an input rather than
 * something it reaches for.
 */
import { computeDamage } from '../src/combat';
import { TERRAIN } from '../src/data/terrain';
import { BASE_DAMAGE, LUCK_MAX } from '../src/data/combat';
import { MAX_HEALTH, UNIT_TYPE_IDS } from '../src/data/unitTypes';
import { makeState } from '../src/testing';
import type { UnitTypeId } from '../src/data/unitTypes';

// Every terrain a unit can be standing on when it is shot at. `defense` is the
// only column that matters here.
//
// ⚠️ **Read off `TERRAIN` rather than listed again.** A hand-written copy is a
// terrain that gets added and then never swept -- the new ground would be
// missing from the one table built to say what ground is worth, and nothing
// would report it. The `Record<TileType, …>` is what makes the table itself
// complete; this is what carries that completeness through to the print-out.
const GROUND = Object.entries(TERRAIN).map(([name, { char }]) => ({ name, char }));

/** A two-tile board: attacker on plains, defender on whatever is being tested. */
function duel(ground: string, attacker: UnitTypeId, defender: UnitTypeId, health: number) {
  const state = makeState(
    ['.' + ground],
    [
      { id: 'a', col: 0, row: 0, unitTypeId: attacker },
      { id: 'd', col: 1, row: 0, owner: 'red', unitTypeId: defender, health },
    ],
  );
  return { state, attacker: state.units[0], defender: state.units[1] };
}

function damageAt(ground: string, a: UnitTypeId, d: UnitTypeId, health: number, roll: number) {
  const { state, attacker, defender } = duel(ground, a, d, health);
  return computeDamage(state, attacker, defender, roll);
}

/**
 * Blows to take a full-health defender to zero, the attacker staying fresh.
 *
 * ⚠️ Not `ceil(MAX_HEALTH / firstHit)`. Cover scales by the defender's band, so
 * each hit lands harder than the one before it as the target weakens -- the
 * whole reason terrain is not a flat percentage. Only simulating gets that
 * right, and `Infinity` is reachable the moment a tuned-down base value is
 * swallowed by the floors, which is exactly what this script exists to show.
 */
function hitsToKill(ground: string, a: UnitTypeId, d: UnitTypeId, roll: number): number {
  let health = MAX_HEALTH;
  for (let hits = 1; hits <= 99; hits++) {
    const damage = damageAt(ground, a, d, health, roll);
    if (damage <= 0) return Infinity;
    health -= damage;
    if (health <= 0) return hits;
  }
  return Infinity;
}

const show = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
const pad = (s: string, w: number) => s.padStart(w);

function table(title: string, columns: string[], rows: Array<[string, string[]]>): void {
  const label = Math.max(...rows.map(([name]) => name.length));
  const width = Math.max(...columns.map((c) => c.length), 5) + 2;
  console.log(`\n${title}`);
  console.log(' '.repeat(label) + columns.map((c) => pad(c, width)).join(''));
  for (const [name, cells] of rows) {
    console.log(name.padEnd(label) + cells.map((c) => pad(c, width)).join(''));
  }
}

console.log('Combat tables, as played. Attacker at full health.');

table(
  `First hit, on road — no cover, no luck (and the spread luck adds, 0..${LUCK_MAX})`,
  UNIT_TYPE_IDS,
  UNIT_TYPE_IDS.map((a) => [
    a,
    UNIT_TYPE_IDS.map((d) => {
      const low = damageAt('-', a, d, MAX_HEALTH, 0);
      const high = damageAt('-', a, d, MAX_HEALTH, LUCK_MAX);
      return `${low}-${high}`;
    }),
  ]),
);

table(
  'Hits to kill, by the ground the defender is standing on — no luck',
  GROUND.map((g) => g.name),
  UNIT_TYPE_IDS.flatMap((a) =>
    UNIT_TYPE_IDS.map((d): [string, string[]] => [
      `${a} → ${d}`,
      GROUND.map((g) => show(hitsToKill(g.char, a, d, 0))),
    ]),
  ),
);

table(
  'Hits to kill with luck always maximal — the best case, for comparison',
  GROUND.map((g) => g.name),
  UNIT_TYPE_IDS.flatMap((a) =>
    UNIT_TYPE_IDS.map((d): [string, string[]] => [
      `${a} → ${d}`,
      GROUND.map((g) => show(hitsToKill(g.char, a, d, LUCK_MAX))),
    ]),
  ),
);

// The table itself last, so the numbers above can be read back to their source.
console.log('\nBASE_DAMAGE, for reference');
for (const a of UNIT_TYPE_IDS) {
  console.log(
    `  ${a.padEnd(10)} ${UNIT_TYPE_IDS.map((d) => pad(String(BASE_DAMAGE[a][d]), 10)).join('')}`,
  );
}
console.log(`  ${' '.repeat(10)} ${UNIT_TYPE_IDS.map((d) => pad(d, 10)).join('')}\n`);
