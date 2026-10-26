import type { UnitTypeId } from './unitTypes';

/**
 * What each attacker does to each defender, as a percentage of a **full-health**
 * target. Attacker down the side.
 *
 * ⚠️ **A charge reads it too**, at an attack's best roll times the side it
 * arrives on -- see `chargeDamage` -- so raising an entry raises what a charge
 * finishes.
 */
export const BASE_DAMAGE: Record<UnitTypeId, Record<UnitTypeId, number>> = {
  infantry: { infantry: 45, cavalry: 35, artillery: 45, general: 35 },
  cavalry: { infantry: 55, cavalry: 45, artillery: 65, general: 45 },
  artillery: { infantry: 55, cavalry: 45, artillery: 45, general: 45 },
  // The general fights, and is fought, as cavalry -- for now.
  general: { infantry: 55, cavalry: 45, artillery: 65, general: 45 },
};

/**
 * The widest the luck bonus ever gets: AW's standard range, from AW1 through
 * Dual Strike. Days of Ruin widened it to 0-10.
 *
 * ⚠️ **Added to the base before anything scales it**, as AW does -- see
 * `computeDamage`. So the full width belongs to a full-strength unit firing onto
 * ground with no cover: an attacker on half its health has about half the range,
 * one on its last band has next to none, and cover trims luck along with the
 * rest.
 *
 * ⚠️ **Never negative.** Base AW luck is a bonus only -- "bad luck" belongs to
 * particular COs -- so a table value is a *floor* on what an attack does, not
 * an average it varies around.
 *
 * No rescaling was needed from AW: the 0-9 is already in our units, because
 * `baseDamage` is a percentage in both schemes.
 */
export const LUCK_MAX = 9;

/**
 * What a charge's damage is multiplied by for the side of the target it arrives
 * on, as a percentage. Getting round a unit is what a charge is for.
 *
 * ⚠️ **On the final damage**, so a charge is `computeDamage` at `LUCK_MAX` with
 * nothing changed inside it -- see `chargeDamage`.
 *
 * ⚠️ **Multiplied, never added**, so `BASE_DAMAGE` can be retuned without
 * dragging these behind it.
 */
export const CHARGE_FACING: Record<'front' | 'flank' | 'rear', number> = {
  front: 80,
  flank: 100,
  rear: 125,
};

/**
 * A full-strength charger's chance of breaking a full-health target, as a
 * percentage, before `CHARGE_FACING` scales it by the side and the charger's
 * own health scales the lot -- see `chargeChance`, which runs a charge's odds
 * from certain at its kill line down to this at full health.
 */
export const CHARGE_CHANCE_AT_FULL = 25;
