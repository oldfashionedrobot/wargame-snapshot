import { attackSide, isWithinGrid, tileDistance } from './coordinate';
import { terrainAdmits } from './movement';
import { BASE_DAMAGE, CHARGE_CHANCE_AT_FULL, CHARGE_FACING, LUCK_MAX } from './data/combat';
import { clampHealth, getUnitType, MAX_HEALTH } from './data/unitTypes';
import { defenseAt, getTileAt, getUnit, inContact } from './queries';
import type { BattleResolvedEvent, Coordinate, GameState, Unit } from './types';

/** How many ten-point bands of health a unit has left: 1 through 10, never 0. */
export const BANDS = 10;

/**
 * The health term the formula reads: AW's displayed 1-10, `ceil(health / 10)`.
 *
 * ⚠️ **This is the whole reason a living unit can still fight.** Health is
 * stored and shown as 0-100 here -- displaying 1-10 was a GBA screen
 * constraint rather than a rule worth keeping -- but the
 * *formula* reads the band, exactly as AW's does. Feed it raw health instead
 * and a unit on 1 point attacks at 1% rather than 10%, which floors to nothing:
 * measured, a cavalry unit at 4 health or less dealt **zero** to infantry in
 * forest even on a maximum roll. Two wounded units could then be permanently
 * unable to kill each other, and only a kill ends a match.
 *
 * ⚠️ AW has no minimum-damage rule and does not need one; this is what it has
 * instead. Zero is still reachable at the extremes, which is faithful -- it is
 * just no longer a predictable band.
 *
 * The cost is deliberate and worth naming: a unit at 91 health and one at 100
 * fight identically while the bar shows two different numbers. That is the
 * price of AW's arithmetic, paid without AW's rounded display to hide it.
 *
 * ⚠️ **Exported because the board's health ring draws one segment per band**,
 * and its claim -- that the display cannot promise precision the rules lack --
 * is only true while the two agree. It computed `ceil(health / 10)` itself once,
 * in another package, in a different spelling; that made the claim a
 * coincidence rather than a consequence.
 */
export function band(health: number): number {
  return Math.ceil(health / BANDS);
}

/**
 * What `attacker` takes off `defender`, given a luck roll in `[0, LUCK_MAX]`.
 *
 * ```
 * damage = floor(floor((base + luck) × attackerBand/10) × (100 − stars×defenderBand)/100)
 * ```
 *
 * ⚠️ **Both HP terms read the band, never the raw value.** One rule rather than
 * two: it is what keeps a wounded attacker able to fight at all, and applying it
 * to only one side would be half of AW's formula with no principle saying which
 * half. `baseDamage` itself needs no rescaling, because it is a percentage of a
 * full target in both schemes -- which is what lets AW's matchup numbers
 * transfer unchanged.
 *
 * ⚠️ **Luck joins the base before anything scales it**, which is Advance Wars'
 * order in every game in the series: luck is added to the attack value, and
 * that is then multiplied by the attacker's band and cut by the defender's
 * cover. So **a wounded unit's luck shrinks with it** -- one on its last band
 * cannot luck its way into an extra tenth -- and cover takes its share of luck
 * the way it takes its share of everything else. The full band of luck belongs
 * to a full-strength unit firing onto ground with no cover.
 *
 * Three behaviours fall out rather than needing rules:
 *
 * - **A wounded attacker hits softer**, by band.
 * - **A wounded defender loses its cover**, because the terrain term scales by
 *   *defender* band. Hills protect a full unit far more than a nearly-dead
 *   one, which stops damaged units turtling on good ground.
 * - **Striking first compounds.** You hit them, they are weaker, and their
 *   counter is weaker for it -- most of AW's exchange calculus, for free.
 *
 * Pure, and the roll is an input, which is what lets the tuning harness run the
 * whole matchup grid with no server and no browser.
 *
 * **Where this comes from.** AW's own formula, its luck behaviour, and its
 * truncation points are documented across these:
 *
 * - https://advancewars.fandom.com/wiki/Damage_Formula -- the formula per game,
 *   AW1 through Days of Ruin, each adding luck before the HP multiply.
 * - https://awbw.fandom.com/wiki/Damage_Formula -- the formula in AW's own units
 *   (HP 1-10), which is what the rescale note above is about.
 * - https://www.warsworldnews.com/wp/aw/game-aw/battle-mechanics/ -- terrain
 *   stars and the exchange model.
 * - https://advancewars.fandom.com/wiki/Luck -- luck added before the HP
 *   multiply, and the range shrinking by a point for every HP lost.
 * - https://awbw.fandom.com/wiki/Terrain -- the terrain stars these are scaled
 *   against.
 * - https://advancewars.fandom.com/wiki/Indirect_Combat -- minimum range, and
 *   why an indirect unit is not answered at all.
 * - https://warswiki.org/wiki/Damage/Advance_Wars_2_chart -- the base damage
 *   matrix the spread of `BASE_DAMAGE` was taken from.
 */
export function computeDamage(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  roll: number,
): number {
  const base = BASE_DAMAGE[attacker.unitTypeId][defender.unitTypeId];

  const defense = defenseAt(state, defender.position);
  // Cover is worth less the less there is left to cover: a star takes a point
  // off per band of the defender's health, Advance Wars' scale.
  //
  // ⚠️ **No clamp is needed** while cover stays under a whole hit, and the *no
  // living attacker is harmless* sweep in `combat.test.ts` fails well before it
  // could reach one -- so that sweep is the limit on stars.
  const cover = defense * band(defender.health);

  // ⚠️ **Luck goes in with the base**, so the attacker's band and the
  // defender's cover scale it like the rest -- AW's order. That also makes a
  // dead attacker harmless with no guard of its own: `band(0)` is 0, and zeroes
  // the luck along with everything else.
  //
  // ⚠️ Floored in sequence rather than folded: `floor(a × b × c)` and
  // `floor(floor(a × b) × c)` are different numbers, and the second is AW's.
  const scaled = Math.floor(((base + roll) * band(attacker.health)) / BANDS);
  return Math.floor((scaled * (100 - cover)) / 100);
}

/**
 * Why a unit may not attack at all from the route it took, or `null`.
 *
 * ⚠️ **The one place the *turn* rule lives**, asked by both attacks and by both
 * sides of the wire: `validateMove` refuses the command with it, and the panel
 * asks it before offering a row. A rule about a turn cannot be derived from a
 * distance, so it cannot live in `outsideRange` with the rest.
 *
 * ⚠️ **Two causes, one consequence: move or attack, not both.** A `slow` unit
 * is always under it. Any other unit is under it when it *starts* in contact --
 * asked of the path's first tile, because where a unit ended up does not say
 * where it began. A unit that starts in the open moves and attacks as it always
 * has, including moving *into* contact and attacking on arrival.
 *
 * ⚠️ **Turning is not moving.** A single-element path is a turn in place, so a
 * gun may pivot onto a target and fire, and a unit in contact may turn to face
 * whoever it is fighting and strike.
 */
function refuseMovingAttack(state: GameState, attacker: Unit, path: Coordinate[]): string | null {
  if (path.length <= 1) return null;
  if (getUnitType(attacker.unitTypeId).slow) {
    return `${attacker.unitTypeId} cannot move and attack in one turn`;
  }
  if (inContact(state, attacker, path[0])) {
    return 'a unit that starts in contact can move or attack, not both';
  }
  return null;
}

/**
 * The checks every attack and charge opens with: the target exists, is an
 * enemy -- which also refuses a unit itself -- and the turn allows attacking.
 * Returns the target, or why not.
 */
function refuseTarget(
  state: GameState,
  attacker: Unit,
  path: Coordinate[],
  targetUnitId: string,
): Unit | string {
  const target = getUnit(state, targetUnitId);
  if (!target) return 'target not found';
  if (target.owner === attacker.owner) return 'that unit is yours';
  return refuseMovingAttack(state, attacker, path) ?? target;
}

export function refuseAttack(
  state: GameState,
  attacker: Unit,
  path: Coordinate[],
  targetUnitId: string,
): string | null {
  const target = refuseTarget(state, attacker, path, targetUnitId);
  if (typeof target === 'string') return target;

  const off = outsideRange(attacker, path[path.length - 1], target.position);
  if (off === 'near') return 'target is too close';
  if (off === 'far') return 'target is out of range';
  return null;
}

/**
 * What the server rolls for one resolution: a luck roll for the attack and one
 * for the counter, each in `[0, LUCK_MAX]`, and a charge roll in `[0, 99]`.
 *
 * ⚠️ **Named, not a tuple** -- `rolls.attack` says what it is where `rolls[0]`
 * is anonymous, and an *array* would invite `rolls[2]`, which is `undefined`,
 * which is `NaN` damage: silent, and the same shape as a stored unit with no
 * health.
 *
 * ⚠️ **Every command draws all three**, whatever it turns out to need. An end
 * of turn uses none, an attack leaves the charge roll unread, and a counter
 * that never happens leaves its own -- the number of draws must never depend on
 * the rules.
 */
export interface Rolls {
  attack: number;
  counter: number;
  /** Against a charge's chance, as a percentage: it breaks through when under it. */
  charge: number;
}

/**
 * Which side of its range a distance falls off, or null if it is inside.
 *
 * ⚠️ **The one place the band is tested.** It was written twice -- once as
 * `< min || > max` for a refusal reason and once as `>= min && <= max` for the
 * counter predicate -- which is two spellings of one rule, in one file, each the
 * negation of the other. Flipping a bound to exclusive would have needed
 * remembering both, and that is how an off-by-one arrives.
 */
function outsideRange(unit: Unit, from: Coordinate, target: Coordinate): 'near' | 'far' | null {
  const { range } = getUnitType(unit.unitTypeId);
  const distance = tileDistance(from, target);
  if (distance < range.min) return 'near';
  if (distance > range.max) return 'far';
  return null;
}

/**
 * Every tile a unit standing at `from` could attack, whether or not anything
 * is there.
 *
 * ⚠️ **Reach, not targets.** The overlay draws this whole band, because a gun's
 * reach is most of what makes it a gun and lighting only occupied tiles would
 * hide it. Red therefore means *in range*, not *attackable*.
 *
 * ⚠️ Here rather than in the client, so the band is stated once. A client
 * looping over tiles with its own `>= min && <= max` would be the third
 * spelling of a rule that already had two.
 */
export function tilesInRange(
  unit: Unit,
  from: Coordinate,
  gridWidth: number,
  gridHeight: number,
): Coordinate[] {
  const { range } = getUnitType(unit.unitTypeId);
  const tiles: Coordinate[] = [];

  // Only the diamond `max` reaches, rather than the whole board: at `max: 5` on
  // a 12x12 that is 60 candidates instead of 144, and it stays proportional to
  // the range rather than to the map.
  for (let dCol = -range.max; dCol <= range.max; dCol++) {
    for (let dRow = -range.max; dRow <= range.max; dRow++) {
      const tile = { col: from.col + dCol, row: from.row + dRow };
      if (!isWithinGrid(tile, gridWidth, gridHeight)) continue;
      if (outsideRange(unit, from, tile) !== null) continue;
      tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Can `defender` answer `attacker`, standing where it attacked from?
 *
 * ⚠️ **Reach decides, apart from two flags.** AW's rule reads "both units must
 * be direct", which is equivalent to *the attacker is adjacent and the defender
 * can fight at adjacency* -- so the reach band answers it, with no category.
 * What reach cannot say is a weapon's nature: a `slow` gun never answers, and a
 * `melee` unit cannot answer a ranged attacker, though a melee attack is
 * answered by whatever it hits.
 *
 * ⚠️ **An attack from directly behind is never answered, and nothing else
 * about facing touches one** -- `computeDamage` cannot see it. Front and flank
 * both draw a full reply, so what the panel says -- "they counter attack" or
 * nothing -- is the whole of the rule rather than a rounding of it. A flanking
 * *damage* bonus on the attack itself is a different thing and was refused on
 * its own terms.
 *
 * `resolveBattle` is the one caller, and the client's forecast and the bot both
 * ask `resolveBattle`, so they follow every rule here with no copy of it.
 *
 * ⚠️ **In a head-on meeting it changes nothing**, which is the point. Deployment
 * points each army at the other, so the armies arrive front-to-front and the
 * rear has to be earned by manoeuvre. And it only ever bites where a counter was
 * possible at all: a gun firing from outside the defender's band is unanswered
 * regardless of which way anyone is looking.
 *
 * ⚠️ **Counter-battery is gone, and `slow` took it.** Two guns within reach of
 * each other used to answer each other -- a deliberate divergence from AW, on
 * the grounds that history allows it. Play disagreed. The flag reads first, so
 * the band's *too close* case is now unreachable from here: artillery is the
 * only unit with `min > 1` and it is slow. `refuseAttack` still asks both ends.
 *
 * ⚠️ **`hasActed` is not consulted.** That flag stops a unit *acting* twice in
 * its own turn; answering an attack is not acting. A spent unit still counters,
 * which is AW's behaviour -- nothing here asks what the defender has *done*,
 * only what it is and where it stands.
 *
 * ⚠️ **A charge never asks this.** One that breaks through kills, and one that
 * fails is met by a free attack from the defender, whatever this would say --
 * see `resolveCharge`.
 */
export function wouldCounter(defender: Unit, attacker: Unit): boolean {
  if (defender.health <= 0) return false;
  const type = getUnitType(defender.unitTypeId);
  // ⚠️ A gun that has to be traversed cannot be swung round in time -- see
  // `slow`. This subsumes what the range band already did at contact and goes
  // further, taking counter-battery with it.
  if (type.slow) return false;
  if (type.melee && !getUnitType(attacker.unitTypeId).melee) return false;
  const from = attacker.position;
  if (attackSide(defender.facing, defender.position, from) === 'rear') return false;
  return outsideRange(defender, defender.position, from) === null;
}

/**
 * The exchange, as one event.
 *
 * ⚠️ **`attacker` should be the unit as it is *after* moving.** Nothing in the
 * damage of a first strike reads the attacker's position -- only its health, and
 * the defender's terrain -- but a counter-attack reads the *attacker's* terrain,
 * which is the destination's. Passing the moved unit here means 9g inherits the
 * right tile instead of having to retrofit it.
 *
 * ⚠️ **The attacker's blow lands even when the counter kills it.** It struck
 * first, so its damage is already done -- the mirror of a dead defender never
 * answering. Both healths ride in one event, so the ordering is unambiguous once
 * it is said, and this is where it is said.
 *
 * ⚠️ **The counter is `computeDamage` called a second time in the other
 * direction, not a branch inside the first.** If it ever becomes a special case
 * threaded through the attack, that is the smell: an exchange is two strikes,
 * and the second is the first with the arguments swapped and the defender's
 * *reduced* health in hand.
 */
export function resolveBattle(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  rolls: Pick<Rolls, 'attack' | 'counter'>,
): BattleResolvedEvent {
  const damage = computeDamage(state, attacker, defender, rolls.attack);
  // The event says what each side *has*, so both must be numbers a rule can
  // read -- `clampHealth` owns both ends of that, rather than this owning one.
  const defenderHealth = clampHealth(defender.health - damage);

  // ⚠️ Answered on the defender's **post-damage** health, which is most of AW's
  // exchange calculus for free: striking first compounds, because a wounded
  // defender both hits softer and keeps less of its terrain cover.
  const survivor: Unit = { ...defender, health: defenderHealth };
  const answered = wouldCounter(survivor, attacker);
  const riposte = answered ? computeDamage(state, survivor, attacker, rolls.counter) : 0;
  const meterSize = chargeMeterSize(attacker);

  return {
    type: 'battleResolved',
    kind: 'attack',
    attacker: {
      unitId: attacker.id,
      health: clampHealth(attacker.health - riposte),
      // Attacking is what fills it; answering fills nothing, so only this side
      // carries one.
      chargeMeter:
        meterSize === null ? attacker.chargeMeter : Math.min(attacker.chargeMeter + 1, meterSize),
    },
    defender: { unitId: defender.id, health: defenderHealth },
    answered,
  };
}

/**
 * The damage a charge from `attacker`, standing where it charges from, is
 * certain to finish `defender` with: an attack's damage at the best roll,
 * multiplied by the side it arrives on. At or under it a charge is certain;
 * above it, `chargeChance` sets the odds.
 *
 * ```
 * charge = floor(computeDamage(state, attacker, defender, LUCK_MAX) × CHARGE_FACING[side] / 100)
 * ```
 *
 * ⚠️ **The attack formula, not a second one.** Cover and the charger's own
 * health work exactly as they do in an attack, so a head-on charge is sure of
 * what an attack only might kill, and the flank and rear finish more. The best
 * roll rather than a rolled one, because the line the odds fall from has to be
 * known before anything is rolled.
 *
 * ⚠️ **The side is read from where the attacker will be standing**, so callers
 * hand over the unit at its charging tile -- `resolveMove` and the client's
 * forecast both build it, and a charge's side is then the same for the server
 * and the panel.
 */
export function chargeDamage(state: GameState, attacker: Unit, defender: Unit): number {
  const side = attackSide(defender.facing, defender.position, attacker.position);
  return Math.floor(
    (computeDamage(state, attacker, defender, LUCK_MAX) * CHARGE_FACING[side]) / 100,
  );
}

/**
 * The chance a charge from `attacker`, standing where it charges from, breaks
 * `defender`, as a whole percentage.
 *
 * ```
 * D      = chargeDamage(state, attacker, defender)
 * end    = CHARGE_CHANCE_AT_FULL × CHARGE_FACING[side] / 100
 * pinned = 100 − (100 − end) × (health − D) / (MAX_HEALTH − D)       // above D
 * chance = health ≤ D ? 100 : max(1, floor(pinned × chargerHealth / MAX_HEALTH))
 * ```
 *
 * ⚠️ **Certain where the charge's damage would kill**, and above that a straight
 * line down to `end` at full health, which the side scales like everything else
 * about a charge. Then the whole of it is multiplied by the charger's own
 * health, so a wounded charger's gamble is a long shot -- with a cliff just over
 * its line, where certainty gives way to its scaled odds. Scaling only the end
 * would have left a unit on 20 health breaking one on 40 most of the time.
 *
 * ⚠️ **Worked in whole numbers**: hundredths of a percent until one floor at
 * the end, so no chance lands a hair under a whole number and floors a point
 * short. Where `D` reaches full health nothing is above it, so the division
 * never meets a zero.
 */
export function chargeChance(state: GameState, attacker: Unit, defender: Unit): number {
  const damage = chargeDamage(state, attacker, defender);
  if (defender.health <= damage) return 100;

  const side = attackSide(defender.facing, defender.position, attacker.position);
  const end = CHARGE_CHANCE_AT_FULL * CHARGE_FACING[side];
  const span = MAX_HEALTH - damage;
  const pinned = 10000 * span - (10000 - end) * (defender.health - damage);
  return Math.max(1, Math.floor((pinned * attacker.health) / (span * 100 * MAX_HEALTH)));
}

/** How many attacks fill this unit's meter, or `null` if it cannot charge. */
function chargeMeterSize(unit: Unit): number | null {
  return getUnitType(unit.unitTypeId).attacksToCharge;
}

/**
 * Whether this unit's charge meter is full -- what `refuseCharge` asks, and
 * what the board's counter shows.
 *
 * ⚠️ **At least full, not equal to it**, so a meter above its size -- a match
 * stored before the size came down -- is ready rather than refused until an
 * attack caps it. A meter read back without the field is never ready, since
 * `undefined >= n` is false. The `null` check is not optional: `0 >= null` is
 * true.
 */
export function chargeReady(unit: Unit): boolean {
  const size = chargeMeterSize(unit);
  return size !== null && unit.chargeMeter >= size;
}

/**
 * Why this charge is refused, or `null` if it is legal.
 *
 * ⚠️ **Offered whatever its odds**, which run down to 1% and never to nothing:
 * how strong the target is decides the chance, not whether the charge may be
 * tried. `chargeChance` is what the player weighs.
 *
 * ⚠️ **Contact, not a range band.** `refuseAttack` measures the attacker's
 * `range`, and infantry reaches two -- so reusing it would permit a "charge"
 * from two tiles off. Cavalry's `{1,1}` coincides with contact only by accident.
 *
 * ⚠️ **And the attacker must be able to *stand* where the target is**, since a
 * charge displaces onto that tile. That is a question about terrain alone:
 * `entryCost` answers it, and also refuses the tile for being enemy-held --
 * which is exactly the tile being charged -- so the terrain half is asked
 * through `terrainAdmits` instead, which both share.
 */
export function refuseCharge(
  state: GameState,
  attacker: Unit,
  path: Coordinate[],
  targetUnitId: string,
): string | null {
  const target = refuseTarget(state, attacker, path, targetUnitId);
  if (typeof target === 'string') return target;
  if (chargeMeterSize(attacker) === null) return `${attacker.unitTypeId} cannot charge`;
  if (!chargeReady(attacker)) return 'the charge meter is not full';
  const { movementType } = getUnitType(attacker.unitTypeId);

  const from = path[path.length - 1];
  if (tileDistance(from, target.position) !== 1) return 'a charge has to reach them';

  const tile = getTileAt(state, target.position);
  if (!tile || !terrainAdmits(tile, movementType)) {
    return `${movementType} cannot cross ${tile ?? 'that'}`;
  }
  return null;
}

/**
 * One charge, resolved: it breaks through when the charge roll is under
 * `chargeChance`, and the meter is spent either way.
 *
 * ⚠️ **Breaking through is health zero, not "it dies"**, which is what lets a
 * charge be an ordinary `battleResolved` with no special case in the reducer --
 * the same `health <= 0` filter removes it. The charger is untouched.
 *
 * ⚠️ **A failed charge is met by a free attack**: the defender's own
 * `computeDamage` on the charger, with the counter roll, whatever the counter
 * rule would say -- a gun, a melee unit and a defender charged from behind all
 * hit back. It is the defence every unit has, and it can kill the charger. The
 * target is unhurt, and `answered` says it repelled the charge.
 *
 * `attacker` is the unit at its charging tile, as `resolveMove` builds it, so
 * the chance reads the side it is charged from and the free attack reads the
 * charger's own ground.
 */
export function resolveCharge(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  rolls: Rolls,
): BattleResolvedEvent {
  const broke = rolls.charge < chargeChance(state, attacker, defender);
  const repel = broke ? 0 : computeDamage(state, defender, attacker, rolls.counter);
  return {
    type: 'battleResolved',
    kind: 'charge',
    attacker: {
      unitId: attacker.id,
      health: clampHealth(attacker.health - repel),
      chargeMeter: 0,
    },
    defender: { unitId: defender.id, health: broke ? 0 : defender.health },
    answered: !broke,
  };
}
