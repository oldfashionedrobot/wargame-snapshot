/**
 * Plays the game against itself, many times, and reports what happened.
 *
 *     bun packages/server/scripts/simulate.ts [games] [mapId] [opener] [budget]
 *                                              [blueArmy] [redArmy]
 *
 * An army is comma-separated rows, e.g. `caac......,iiii......`. Omitted, both
 * sides take the default deployment.
 *
 * ⚠️ **A prototype, built to answer whether this is worth building properly.**
 * The bot is one-ply greedy: it scores every legal command by what it gains
 * this instant and takes the best. That is enough to find a *dominant* option
 * and nowhere near enough to play well.
 *
 * ⚠️ **Read the mechanic counts, not the win rate.** A bot confirms whatever it
 * is scored on -- score it on damage and it will report that the
 * highest-damage unit wins. What it cannot fake is whether a rule *fired*: a
 * charge nobody takes and a terrain nobody is defended by are visible here and
 * are not opinions. Both dead dials found by hand so far were of that shape.
 *
 * ⚠️ **Seeded, so any run replays exactly.** `shared/` takes rolls as an input,
 * which is what lets this exist at all -- no server, no database, no browser.
 */
import {
  applyEvents,
  canSelectUnit,
  chargeChance,
  computeDamage,
  exploreMovement,
  facingToward,
  generalOf,
  getUnit,
  getUnitType,
  isGeneral,
  isOver,
  LUCK_MAX,
  refuseAttack,
  refuseCharge,
  resolveAction,
  resolveBattle,
  tileDistance,
  UNIT_TYPE_IDS,
  validateCommand,
  victor,
} from '@wargame/shared';
import type {
  Command,
  Coordinate,
  GameEvent,
  GameState,
  MovementType,
  Unit,
  UnitTypeId,
} from '@wargame/shared';
import { getMap } from '../src/maps';
import { createMatchState, PLAYERS } from '../src/matchState';
import { rollLuck } from '../src/rollLuck';
import type { Deployment } from '../src/matchState';

// mulberry32: small, fast, and good enough for tuning statistics.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a kill that ends the match is worth over any other kill. */
const WIN = 1000;

/**
 * Would taking `target` win the match for `unit`'s side? Asked of the rules
 * rather than worked out here, so the bot cannot drift from what winning is.
 */
const winsBy = (state: GameState, unit: Unit, target: Unit): boolean =>
  victor(state, { ...state, units: state.units.filter((u) => u.id !== target.id) }) === unit.owner;

const routeCache = new WeakMap<GameState['grid'], Map<string, Map<string, number>>>();

/**
 * How far a unit is from a tile, by the route this movement type would walk
 * over the bare terrain -- not as the crow flies, which parks a unit on the
 * nearest shore of water it cannot cross. Units are left off the board: they
 * move, and the terrain does not. Where no route exists, the crow's distance is
 * all there is to go on.
 *
 * ⚠️ Kept per board, tile and movement type, since bare terrain answers the
 * same every time: searching afresh for every enemy at every decision made a
 * run many times slower.
 */
function stepsBetween(state: GameState, from: Unit, to: Coordinate, movementType: MovementType) {
  let byOrigin = routeCache.get(state.grid);
  if (!byOrigin) routeCache.set(state.grid, (byOrigin = new Map()));
  const origin = `${movementType}:${from.position.col},${from.position.row}`;
  let steps = byOrigin.get(origin);
  if (!steps) {
    const search = exploreMovement({ ...state, units: [] }, from, Infinity, movementType);
    steps = new Map(
      search.settled.map((tile) => [`${tile.col},${tile.row}`, search.pathTo(tile)!.length - 1]),
    );
    byOrigin.set(origin, steps);
  }
  return steps.get(`${to.col},${to.row}`) ?? tileDistance(to, from.position);
}

/** A candidate command and what the bot thinks it is worth. */
interface Scored {
  command: Command;
  score: number;
}

/**
 * Every legal command for the player to move, scored.
 *
 * ⚠️ Facing is not enumerated -- four facings per destination would multiply
 * the space by four for a bot too shallow to use them. An attack faces its
 * target; a plain move faces the nearest enemy.
 */
function candidates(state: GameState): Scored[] {
  const enemies = state.units.filter((u) => u.owner !== state.currentTurn);
  const out: Scored[] = [];
  if (enemies.length === 0) return out;

  for (const unit of state.units) {
    if (!canSelectUnit(state, unit)) continue;
    const type = getUnitType(unit.unitTypeId);
    const movement = exploreMovement(state, unit, type.movementRange, type.movementType);

    // Standing still is a legal "path" of one tile, and is how a gun shoots
    // without giving up its shot to `slow`.
    const stops: Coordinate[] = [unit.position, ...movement.reachable];

    for (const stop of stops) {
      const path = movement.pathTo(stop);
      if (!path) continue;
      const moved: Unit = { ...unit, position: stop };
      const { enemy: nearest, steps } = enemies
        .map((enemy) => ({ enemy, steps: stepsBetween(state, enemy, stop, type.movementType) }))
        .reduce((a, b) => (a.steps <= b.steps ? a : b));

      // A plain reposition. Scored well below any attack, so the bot only
      // walks when it cannot attack -- which is what makes it close at all.
      // ⚠️ Its own general walks the other way: kept back, like a king.
      const distance = steps * 0.01;
      out.push({
        command: {
          type: 'move',
          unitId: unit.id,
          path,
          facing: facingToward(stop, nearest.position, unit.facing),
        },
        score: isGeneral(unit) ? distance : -distance,
      });

      for (const target of enemies) {
        const facing = facingToward(stop, target.position, unit.facing);

        // Attacking: expected damage, less what the reply is expected to cost.
        if (refuseAttack(state, moved, path, target.id) === null) {
          const mid = Math.floor(LUCK_MAX / 2);
          const battle = resolveBattle(state, moved, target, { attack: mid, counter: mid });
          const dealt = target.health - battle.defender.health;
          const riposte = moved.health - battle.attacker.health;
          const kills = battle.defender.health <= 0;
          // Its own general fights only to finish something.
          if (isGeneral(unit) && !kills) continue;
          out.push({
            command: {
              type: 'move',
              unitId: unit.id,
              path,
              facing,
              targetUnitId: target.id,
              attackKind: 'attack',
            },
            score: dealt + (kills ? 25 + (winsBy(state, unit, target) ? WIN : 0) : 0) - riposte,
          });
        }

        // Charging: a kill weighted by its odds, less the defender's free
        // attack weighted by the odds of failing. ⚠️ A certain charge ties a
        // killing attack, which costs nothing either.
        if (refuseCharge(state, moved, path, target.id) === null) {
          const p = chargeChance(state, moved, target) / 100;
          if (isGeneral(unit) && p < 1) continue;
          const mid = Math.floor(LUCK_MAX / 2);
          const repel = computeDamage(state, target, moved, mid);
          const prize = target.health + 25 + (winsBy(state, unit, target) ? WIN : 0);
          out.push({
            command: {
              type: 'move',
              unitId: unit.id,
              path,
              facing,
              targetUnitId: target.id,
              attackKind: 'charge',
            },
            score: p * prize - (1 - p) * repel,
          });
        }
      }
    }
  }
  return out;
}

interface Stats {
  games: number;
  wins: Record<string, number>;
  unfinished: number;
  turns: number[];
  actions: number[];
  damageBy: Record<string, number>;
  killsBy: Record<string, number>;
  attacks: number;
  countered: number;
  charges: number;
  chargesBy: Record<string, number>;
  chargesBroke: number;
  /**
   * Attacks by the ground the defender stood on. ⚠️ By ground rather than by
   * stars of cover, so a run before a change to the cover table and one after it
   * count the same tiles.
   */
  hitsByGround: Record<string, number>;
  wonByGeneral: number;
  healed: number;
}

function playOne(
  base: GameState,
  seed: number,
  stats: Stats,
  actionCap: number,
  first: string,
  budget: number | null,
): void {
  const random = rng(seed);
  // ⚠️ Who moves first is a *balance* question, not a fixture detail -- a whole
  // army acts before the other answers, so the opening is the alpha strike the
  // roadmap flags. Switchable so the two can be compared.
  let state: GameState = { ...base, currentTurn: first };
  let turns = 0;
  let actions = 0;

  // ⚠️ **Capped on *actions*, not turns, and that is what makes two budgets
  // comparable.** A turn is a whole roster at one budget and a single command
  // at another, so a turn limit would give one regime eight times the play of
  // the other and then report the difference as a result.
  while (!isOver(state) && actions < actionCap) {
    const options = candidates(state);
    // ⚠️ Ties broken at random, not by enumeration order. Without it both sides
    // play one fixed line and the only variation between games is the dice,
    // which makes any win rate a statement about a single game rather than a
    // distribution.
    const best = options.reduce<Scored | null>(
      (a, b) =>
        a === null || b.score > a.score || (b.score === a.score && random() < 0.5) ? b : a,
      null,
    );
    const command: Command = best ? best.command : { type: 'endTurn' };

    const validation = validateCommand(state, command, state.currentTurn);
    if (!validation.ok) {
      // The bot proposed something the rulebook refuses: a real finding, since
      // every candidate was built from the rulebook's own predicates.
      throw new Error(`bot proposed an illegal command: ${validation.reason}`);
    }

    const rolls = rollLuck(random);

    const before = state;
    const events: GameEvent[] = resolveAction(state, validation.action, rolls, budget);
    record(before, events, stats);
    state = applyEvents(state, events);
    actions++;
    if (events.some((e) => e.type === 'turnEnded')) turns++;
  }

  stats.games++;
  stats.turns.push(turns);
  stats.actions.push(actions);
  const winner = state.winner;
  if (winner === null) stats.unfinished++;
  else {
    stats.wins[winner] = (stats.wins[winner] ?? 0) + 1;
    // Won by the general when the loser fielded one and it is gone; otherwise
    // the loser's army fell.
    const loser = base.players.find((player) => player.id !== winner)?.id;
    if (loser && generalOf(base, loser) && !generalOf(state, loser)) stats.wonByGeneral++;
  }
}

/** What a resolved command says about the rules, read off the events. */
function record(before: GameState, events: GameEvent[], stats: Stats): void {
  // Folded as it goes, so a heal is measured against the health it began from
  // even when a battle in the same batch changed it.
  let shown = before;
  for (const event of events) {
    const prior = shown;
    shown = applyEvents(shown, [event]);
    if (event.type === 'unitsHealed') {
      for (const { unitId, health } of event.units) {
        stats.healed += health - (getUnit(prior, unitId)?.health ?? health);
      }
      continue;
    }
    if (event.type !== 'battleResolved') continue;
    const attacker = getUnit(before, event.attacker.unitId);
    const defender = getUnit(before, event.defender.unitId);
    if (!attacker || !defender) continue;
    const by: UnitTypeId = attacker.unitTypeId;

    if (event.kind === 'charge') {
      stats.charges++;
      stats.chargesBy[by] = (stats.chargesBy[by] ?? 0) + 1;
      if (event.defender.health <= 0) {
        stats.chargesBroke++;
        stats.killsBy[by] = (stats.killsBy[by] ?? 0) + 1;
      }
      continue;
    }

    stats.attacks++;
    const ground = before.grid[defender.position.row][defender.position.col];
    stats.hitsByGround[ground] = (stats.hitsByGround[ground] ?? 0) + 1;
    stats.damageBy[by] = (stats.damageBy[by] ?? 0) + (defender.health - event.defender.health);
    if (event.defender.health <= 0) stats.killsBy[by] = (stats.killsBy[by] ?? 0) + 1;
    if (event.answered && event.attacker.health < attacker.health) stats.countered++;
  }
}

// --- run -------------------------------------------------------------------

const games = Number(process.argv[2] ?? 200);
const mapId = process.argv[3] ?? 'classic';

/**
 * An army per side, as comma-separated rows -- `caac......,iiii......`.
 *
 * ⚠️ **Composition is the point of passing them, not deployment.** Both sides
 * run the identical policy, so any departure from an even split is the map, the
 * deployment, or the *armies* rather than the bot -- which is what makes an
 * asymmetric pair the one case these win rates are trustworthy for.
 *
 * Omit both and the default deployment applies, so the existing invocations
 * mean exactly what they meant before.
 */
const parseArmy = (arg: string | undefined) => arg?.split(',');
const blueArmy = parseArmy(process.argv[6]);
const redArmy = parseArmy(process.argv[7]) ?? blueArmy;
const deployments: Deployment[] | undefined =
  blueArmy && redArmy
    ? [
        { player: PLAYERS[0], army: blueArmy },
        { player: PLAYERS[1], army: redArmy },
      ]
    : undefined;
const ACTION_CAP = 480;

const stats: Stats = {
  games: 0,
  wins: {},
  unfinished: 0,
  turns: [],
  actions: [],
  damageBy: {},
  killsBy: {},
  attacks: 0,
  countered: 0,
  charges: 0,
  chargesBy: {},
  chargesBroke: 0,
  hitsByGround: {},
  wonByGeneral: 0,
  healed: 0,
};

const first = process.argv[4] ?? PLAYERS[0].id;
// ⚠️ **The turn budget is passed, not inherited.** `resolveAction` takes it as
// an argument for the tests' sake; the same seam lets a whole regime be
// compared here without editing `turns.ts` and rebuilding an opinion from
// memory. `all` means the whole roster, which is `ACTIONS_PER_TURN`'s `null`.
const budgetArg = process.argv[5] ?? 'all';
const budget: number | null = budgetArg === 'all' ? null : Number(budgetArg);
// One starting state for every game, which also lets `stepsBetween` keep its
// routes from one game to the next.
const base = createMatchState(getMap(mapId), deployments);
const started = Date.now();
for (let i = 0; i < games; i++) playOne(base, i + 1, stats, ACTION_CAP, first, budget);
const elapsed = Date.now() - started;

const pct = (n: number, d: number) => (d === 0 ? '  —  ' : `${((100 * n) / d).toFixed(1)}%`);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sorted = [...stats.turns].sort((a, b) => a - b);

console.log(
  `\n${stats.games} games on ${mapId}, greedy both sides, ${first} opens, ` +
    `${budgetArg} per turn, ${elapsed} ms\n` +
    (deployments
      ? `  blue ${deployments[0].army.join(',')}   red ${deployments[1].army.join(',')}\n`
      : ''),
);

console.log('outcome');
for (const [player, n] of Object.entries(stats.wins)) {
  console.log(`  ${player.padEnd(14)} ${String(n).padStart(5)}  ${pct(n, stats.games)}`);
}
console.log(
  `  ${'unfinished'.padEnd(14)} ${String(stats.unfinished).padStart(5)}  ${pct(stats.unfinished, stats.games)}  (hit the ${ACTION_CAP}-action cap)`,
);
const decided = stats.games - stats.unfinished;
console.log(
  `  won by general ${String(stats.wonByGeneral).padStart(5)}  ${pct(stats.wonByGeneral, decided)} of decided`,
);

const sortedActions = [...stats.actions].sort((a, b) => a - b);
console.log('\nmatch length');
console.log(
  `  turns    mean ${mean(stats.turns).toFixed(1)}   median ${sorted[Math.floor(sorted.length / 2)]}   min ${sorted[0]}   max ${sorted[sorted.length - 1]}`,
);
console.log(
  `  actions  mean ${mean(stats.actions).toFixed(1)}   median ${sortedActions[Math.floor(sortedActions.length / 2)]}   min ${sortedActions[0]}   max ${sortedActions[sortedActions.length - 1]}`,
);

console.log('\ndamage, kills and charges, by who dealt them');
const totalDamage = UNIT_TYPE_IDS.reduce((a, t) => a + (stats.damageBy[t] ?? 0), 0);
for (const t of UNIT_TYPE_IDS) {
  const d = stats.damageBy[t] ?? 0;
  console.log(
    `  ${t.padEnd(10)} ${String(d).padStart(7)} damage  ${pct(d, totalDamage).padStart(6)} of all   ${String(stats.killsBy[t] ?? 0).padStart(4)} kills   ${String(stats.chargesBy[t] ?? 0).padStart(4)} charges`,
  );
}

console.log('\ndid the mechanics fire at all');
console.log(`  attacks made           ${stats.attacks}`);
console.log(`  ...answered            ${stats.countered}  ${pct(stats.countered, stats.attacks)}`);
console.log("  ...by the defender's ground");
for (const [ground, n] of Object.entries(stats.hitsByGround).sort(([, a], [, b]) => b - a)) {
  console.log(`       ${ground.padEnd(17)}${String(n).padStart(5)}  ${pct(n, stats.attacks)}`);
}
console.log(`  health healed          ${stats.healed}`);
console.log(`  charges made           ${stats.charges}`);
console.log(
  `  ...broke through       ${stats.chargesBroke}  ${pct(stats.chargesBroke, stats.charges)}`,
);
console.log();
