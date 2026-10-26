// Static content, not runtime state: what a Cavalry *is* never changes during a
// match, so it lives here rather than being copied onto every Unit instance.
// `Unit.unitTypeId` references an entry in this catalog.

export type UnitTypeId = 'infantry' | 'cavalry' | 'artillery' | 'general';

// One movement type per unit type for now -- they're deliberately kept as
// separate axes because the movement-cost table is keyed by movement type, not
// by unit type, and later units will share rows (e.g. dragoons on 'horse').
export type MovementType = 'foot' | 'horse' | 'wheels';

export interface UnitType {
  id: UnitTypeId;
  name: string;
  /**
   * How this unit is written in an army. The legend lives here and nowhere
   * else -- `parseArmyGrid` inverts this column rather than keeping a second
   * copy that could drift, exactly as `parseTerrainGrid` does with terrain's.
   *
   * ⚠️ `.` is not among them and cannot be: it means *empty* in an army and
   * *plains* in a map. Two grids, two legends, one character that belongs to
   * both -- which is fine while nothing ever parses a row as both.
   */
  char: string;
  movementType: MovementType;
  // Movement points, not tiles: once terrain costs exist these are spent per
  // tile entered via the (movementType, tileType) table rather than 1-per-tile.
  movementRange: number;
  /**
   * How far this unit can attack, inclusive at both ends, in tiles.
   *
   * ⚠️ **Two numbers, and *almost* no category beside them.** There is no
   * direct/indirect flag: `min: 3` *describes* a gun rather than classifying it,
   * and most of what AW spreads across those categories falls out of this pair
   * -- including how far a counter reaches, which is "is the attacker inside my
   * own range" for every unit `slow` does not speak for first.
   *
   * ⚠️ **What did not fall out is `slow` and `melee`.** No number makes "may
   * not move and attack in one turn" or "cannot answer a shot" emerge: one is a
   * rule about a *turn*, the other about a *weapon*, and a sabre and a carbine
   * can both reach one tile. See both below.
   */
  range: { min: number; max: number };

  /**
   * This weapon has to be set up, and cannot be swung round.
   *
   * ⚠️ **One physical fact with two consequences, which is why it is one flag
   * and not two.** A piece that must be unlimbered, laid and traversed cannot
   * fire in the same turn it repositions, and cannot snap off a reply to
   * something that attacked it. Both rules are the same sentence about the gun.
   * Bundling unrelated behaviours behind one boolean would be the category this
   * catalog refuses; bundling consequences of one cause is what a name is for.
   *
   * ⚠️ **It came from play, not from design.** The catalog argued against it on
   * the grounds that behaviour should fall out of numbers, and that argument is
   * still right about direct-versus-indirect -- it is just not right about this,
   * because a turn is not a distance.
   *
   * ⚠️ It subsumes what `min: 3` was already doing up close: a gun could not
   * answer anything that had closed with it, because 1 and 2 are outside
   * `[3, 5]`. This removes
   * **counter-battery** as well, where two guns within reach of each other used
   * to answer each other.
   */
  slow: boolean;

  /**
   * Fights hand to hand, so it cannot answer a ranged attacker -- it strikes
   * back on its own turn. A melee attack is still answered by whatever it hits.
   */
  melee: boolean;

  /**
   * The attacks it takes to earn a charge, or `null` for a type that cannot
   * charge -- see `chargeDamage` and `chargeReady`. Every attack fills the
   * unit's meter a point, up to this; a charge needs it full and spends all of
   * it, and answering an attack fills nothing.
   *
   * ⚠️ **Required**, so a new unit type has to say. A missing row in a charge
   * table used to leave one silently unable to.
   */
  attacksToCharge: number | null;
}

/**
 * What every unit starts at and tops out at.
 *
 * ⚠️ **A constant, not a `UnitType` field, and deliberately not on `Unit`.**
 * Nothing varies it, so a per-instance copy would be the same number written
 * once per unit -- the duplication that moving `movementRange` onto the catalog
 * just removed. It lives in this file rather than beside the damage table
 * because the day some unit is tougher than another, it becomes a column of
 * `UnitType` below and the change is local.
 *
 * 100 because the damage table is read as a percentage of a full-strength
 * unit: at full health an attack scoring 55 takes 55 off, and a half-strength
 * attacker deals half of that. Choosing any other maximum would make the table
 * mean something other than what Advance Wars' numbers mean.
 */
export const MAX_HEALTH = 100;

/**
 * What a unit regains when its turn begins beside its own general: a fifth of
 * `MAX_HEALTH`, never past it -- see `resolveEndTurn`.
 */
export const GENERAL_HEALING = 20;

/**
 * A health, brought inside its bounds.
 *
 * ⚠️ **Because the bounds were being written inline, and only half of them
 * were.** `resolveBattle` clamped the bottom with a literal `Math.max(0, …)` and
 * nothing anywhere clamped the top -- so "0 to `MAX_HEALTH`" was a rule the code
 * stated in pieces and the next person to compute a health would state again,
 * possibly differently. One function is a thing nobody can write half of.
 *
 * ⚠️ **For producers, not for `applyEvents`.** Clamping in the reducer would
 * cover every writer forever, which is tempting -- but it would *silently
 * correct* a bad event rather than refusing it, and this codebase refuses
 * loudly: `getUnitType` throws, and the reducer throws on an unknown event. A
 * health out of range can only come from a resolution bug, and quietly healing
 * it buries that bug in the log for good.
 */
export function clampHealth(value: number): number {
  return Math.min(MAX_HEALTH, Math.max(0, value));
}

// A Record, so adding a UnitTypeId turns every incomplete table in data/ into a
// compile error instead of a silent runtime gap.
export const UNIT_TYPES: Record<UnitTypeId, UnitType> = {
  infantry: {
    id: 'infantry',
    name: 'Infantry',
    char: 'i',
    movementType: 'foot',
    movementRange: 3,
    // ⚠️ Reaching two tiles is what lets infantry fight a battery at all, and
    // since `slow` it is a free shot rather than a trade: two is inside this
    // band and outside the gun's, so the gun can neither fire back nor answer.
    // Closing to one buys no harder a shot -- only a charge.
    range: { min: 1, max: 2 },
    slow: false,
    melee: false,
    attacksToCharge: 3,
  },
  cavalry: {
    id: 'cavalry',
    name: 'Cavalry',
    char: 'c',
    movementType: 'horse',
    movementRange: 4,
    // ⚠️ Adjacent only, and `melee`, which is the whole shape of the unit: it is
    // shot at all the way in and can answer none of it, striking back on its own
    // turn instead. Closing is the cost, and the charge is the point.
    range: { min: 1, max: 1 },
    slow: false,
    melee: true,
    attacksToCharge: 2,
  },
  artillery: {
    id: 'artillery',
    name: 'Artillery',
    char: 'a',
    movementType: 'wheels',
    movementRange: 3,
    // ⚠️ The minimum range is the unit's defining weakness and the reason
    // cavalry has a job: a gun cannot fire at anything that has closed with it,
    // and `slow` makes the gap expensive to fix -- a gun that has been reached
    // must spend its whole turn withdrawing.
    range: { min: 2, max: 4 },
    slow: true,
    melee: false,
    attacksToCharge: null,
  },
  // ⚠️ **Cavalry in all but name for now**, to be tuned in play -- what makes it
  // a general is not here but in the rules that name it: losing it loses the
  // match, and the units beside it heal. Guns hit it as they hit cavalry, so
  // keeping it out of their reach is the game.
  general: {
    id: 'general',
    name: 'General',
    char: 'g',
    movementType: 'horse',
    movementRange: 4,
    range: { min: 1, max: 1 },
    slow: false,
    melee: true,
    attacksToCharge: 2,
  },
};

/** Every id in the catalog, for the harnesses that print a table per type. */
export const UNIT_TYPE_IDS = Object.keys(UNIT_TYPES) as UnitTypeId[];

/**
 * Throws on an id the catalog does not hold, rather than returning undefined.
 *
 * The types make that unreachable in-process, and guarantee nothing about a
 * `GameState` parsed back out of the database -- where a row written before a
 * unit type existed is exactly the case this catches. Same reasoning as
 * applyEvents refusing an unknown event: a silent undefined here surfaces as
 * NaN movement somewhere far away.
 */
export function getUnitType(id: UnitTypeId): UnitType {
  const unitType = UNIT_TYPES[id];
  if (!unitType) throw new Error(`unknown unit type: ${String(id)}`);
  return unitType;
}
