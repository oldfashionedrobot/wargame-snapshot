import { describe, expect, it } from 'vitest';
import type { UnitTypeId } from '@wargame/shared';
import { BEATS, ONCE, STAGE, TIMING, planBattle, standing } from './cutawayPlan';
import type { Battle, Beat, Cue, Plan, Side } from './cutawayPlan';
import { MOTIONS } from './figures';
import type { Body } from './figures';

const battle = (
  kind: Battle['kind'],
  answered: boolean,
  attacker: [UnitTypeId, number, number],
  defender: [UnitTypeId, number, number],
): Battle => ({
  kind,
  answered,
  attacker: { unitTypeId: attacker[0], before: attacker[1], after: attacker[2] },
  defender: { unitTypeId: defender[0], before: defender[1], after: defender[2] },
});

const beats = (plan: Plan, side: Side, beat: Beat) =>
  plan.cues.filter(
    (cue): cue is Extract<Cue, { beat: Beat }> =>
      'beat' in cue && cue.side === side && cue.beat === beat,
  );
const moves = (plan: Plan, side: Side) =>
  plan.cues.filter((cue): cue is Extract<Cue, { by: number }> => 'by' in cue && cue.side === side);
const fallers = (plan: Plan, side: Side) => beats(plan, side, 'fall').map((cue) => cue.member);

describe('standing', () => {
  it('is a figure a band for foot and horse', () => {
    expect(standing('infantry', 100)).toBe(10);
    expect(standing('infantry', 41)).toBe(5);
    expect(standing('cavalry', 9)).toBe(1);
  });

  it('is a figure for two bands for a general and his escort', () => {
    expect(standing('general', 100)).toBe(5);
    expect(standing('general', 30)).toBe(2);
    expect(standing('general', 5)).toBe(1);
  });

  // The gun stands while the unit does; only its crew thin out.
  it('keeps the gun until the unit is gone', () => {
    expect(standing('artillery', 100)).toBe(6);
    expect(standing('artillery', 15)).toBe(2);
    expect(standing('artillery', 0)).toBe(0);
  });
});

describe('an attack', () => {
  const plan = planBattle(battle('attack', false, ['infantry', 100, 100], ['infantry', 100, 63]));

  it('fields each side as its health stands before the battle', () => {
    expect(plan.attacker).toHaveLength(10);
    expect(plan.defender).toHaveLength(10);
  });

  it('drops as many defenders as bands were lost, and the rest flinch', () => {
    expect(fallers(plan, 'defender')).toHaveLength(3);
    expect(beats(plan, 'defender', 'flinch')).toHaveLength(7);
  });

  it('takes nothing from an attacker nobody answered', () => {
    expect(fallers(plan, 'attacker')).toHaveLength(0);
    expect(beats(plan, 'defender', 'strike')).toHaveLength(0);
  });

  it('fires the whole line, one man after another', () => {
    const strikes = beats(plan, 'attacker', 'strike').map((cue) => cue.at);
    expect(strikes).toHaveLength(10);
    expect(new Set(strikes).size).toBe(10);
  });

  it('lands the blow after the volley starts', () => {
    const first = Math.min(...beats(plan, 'attacker', 'strike').map((cue) => cue.at));
    const hit = Math.min(...beats(plan, 'defender', 'fall').map((cue) => cue.at));
    expect(hit - first).toBe(TIMING.impact);
  });
});

describe('an answered attack', () => {
  const plan = planBattle(battle('attack', true, ['cavalry', 100, 72], ['cavalry', 100, 55]));

  it('answers with the survivors only', () => {
    expect(beats(plan, 'defender', 'strike')).toHaveLength(6);
  });

  it('drops the attacker’s losses after the answer lands', () => {
    expect(fallers(plan, 'attacker')).toHaveLength(2);
    const answer = Math.min(...beats(plan, 'defender', 'strike').map((cue) => cue.at));
    for (const cue of beats(plan, 'attacker', 'fall')) expect(cue.at).toBeGreaterThan(answer);
  });

  // Mounted ride right up to the line they strike, and once the lines have met
  // nobody rides again: the defenders cut where they stand.
  it('rides the attackers in until the front ranks meet, and the defenders not at all', () => {
    const rides = moves(plan, 'attacker').filter((cue) => cue.by > 0);
    expect(rides).toHaveLength(10);
    const front = (side: Side) => Math.max(...plan[side].map((member) => member.forward));
    for (const ride of rides) {
      expect(2 * STAGE.home - front('attacker') - front('defender') - ride.by).toBeCloseTo(
        STAGE.reach,
      );
    }
    expect(moves(plan, 'defender')).toHaveLength(0);
  });

  // Rather than staying among the enemy once the blows are exchanged.
  it('rides the survivors back to where they stood, to face the enemy again', () => {
    const back = moves(plan, 'attacker').filter((cue) => cue.by < 0);
    expect(back).toHaveLength(8);
    for (const ride of back) {
      expect(ride.by).toBeCloseTo(-moves(plan, 'attacker')[0].by);
    }
    expect(beats(plan, 'attacker', 'face')).toHaveLength(8);
  });
});

describe('a charge that breaks through', () => {
  const plan = planBattle(battle('charge', false, ['cavalry', 80, 80], ['infantry', 100, 0]));

  it('kills every defender and loses no one', () => {
    expect(fallers(plan, 'defender')).toHaveLength(10);
    expect(fallers(plan, 'attacker')).toHaveLength(0);
  });

  it('runs every charger through and off the back of their ground', () => {
    const runs = moves(plan, 'attacker');
    expect(runs).toHaveLength(8);
    for (const run of runs) expect(run.by).toBeGreaterThan(2 * STAGE.home);
  });

  it('closes once the last of them is off the stage', () => {
    const lastRun = Math.max(...moves(plan, 'attacker').map((cue) => cue.at + cue.over));
    expect(plan.length).toBe(lastRun + TIMING.close);
  });
});

describe('a charge that is repelled', () => {
  const plan = planBattle(battle('charge', true, ['infantry', 100, 58], ['cavalry', 100, 100]));

  it('drops the chargers’ losses and none of the defenders', () => {
    expect(fallers(plan, 'attacker')).toHaveLength(4);
    expect(fallers(plan, 'defender')).toHaveLength(0);
  });

  it('turns the rest about and runs them back off their own ground', () => {
    const flights = beats(plan, 'attacker', 'flee');
    expect(flights).toHaveLength(6);
    const back = moves(plan, 'attacker').filter((cue) => cue.by < 0);
    expect(back).toHaveLength(6);
  });

  it('runs them back together, not one after another', () => {
    const turns = beats(plan, 'attacker', 'flee').map((cue) => cue.at);
    expect(Math.max(...turns) - Math.min(...turns)).toBeCloseTo(5 * TIMING.stagger);
  });

  it('meets the chargers with a free attack as they arrive', () => {
    expect(beats(plan, 'defender', 'strike')).toHaveLength(10);
  });

  it('sends no one back when the free attack kills them all', () => {
    const wiped = planBattle(battle('charge', true, ['infantry', 30, 0], ['infantry', 100, 100]));
    expect(fallers(wiped, 'attacker')).toHaveLength(3);
    expect(beats(wiped, 'attacker', 'flee')).toHaveLength(0);
  });
});

// The health bars wait for these, so a side's falls as its blow lands.
describe('when each side is hit', () => {
  it('is the defender as the attack lands, and the attacker as the answer does', () => {
    const plan = planBattle(battle('attack', true, ['infantry', 100, 70], ['infantry', 100, 50]));
    const first = (side: Side, beat: Beat) =>
      Math.min(...beats(plan, side, beat).map((cue) => cue.at));
    expect(plan.hits.defender).toBe(first('defender', 'fall'));
    expect(plan.hits.attacker).toBe(first('attacker', 'fall'));
    expect(plan.hits.attacker!).toBeGreaterThan(plan.hits.defender!);
  });

  it('is nobody on a side no blow reaches', () => {
    const plan = planBattle(
      battle('attack', false, ['artillery', 100, 100], ['infantry', 100, 80]),
    );
    expect(plan.hits.attacker).toBeNull();
    const broke = planBattle(battle('charge', false, ['cavalry', 100, 100], ['infantry', 50, 0]));
    expect(broke.hits.attacker).toBeNull();
    const repelled = planBattle(battle('charge', true, ['cavalry', 100, 60], ['infantry', 90, 90]));
    expect(repelled.hits.defender).toBeNull();
    expect(repelled.hits.attacker).not.toBeNull();
  });
});

describe('who goes last', () => {
  it('drops the gun only when its unit is destroyed, after its crew', () => {
    const plan = planBattle(battle('attack', false, ['artillery', 100, 100], ['artillery', 40, 0]));
    const falls = beats(plan, 'defender', 'fall').sort((a, b) => a.at - b.at);
    expect(plan.defender[falls[falls.length - 1].member].role).toBe('gun');
  });

  it('keeps the gun while a crewman is left', () => {
    const plan = planBattle(
      battle('attack', false, ['artillery', 100, 100], ['artillery', 100, 12]),
    );
    expect(fallers(plan, 'defender').map((i) => plan.defender[i].role)).not.toContain('gun');
  });

  it('drops the escort before the general', () => {
    const plan = planBattle(battle('charge', false, ['cavalry', 100, 100], ['general', 100, 0]));
    const falls = beats(plan, 'defender', 'fall').sort((a, b) => a.at - b.at);
    expect(plan.defender[falls[falls.length - 1].member].role).toBe('general');
  });
});

describe('the table of beats', () => {
  it.each(Object.entries(BEATS))('names only animations the %s body has', (body, table) => {
    for (const motion of Object.values(table)) {
      expect(MOTIONS[body as Body]).toContain(motion);
    }
  });

  it('plays a fall through once and holds it', () => {
    expect(ONCE.has('fall')).toBe(true);
  });
});

describe('every plan', () => {
  const plans = [
    planBattle(battle('attack', true, ['infantry', 100, 70], ['infantry', 100, 50])),
    planBattle(battle('attack', false, ['artillery', 100, 100], ['general', 100, 80])),
    planBattle(battle('charge', false, ['general', 60, 60], ['artillery', 30, 0])),
    planBattle(battle('charge', true, ['cavalry', 100, 20], ['infantry', 90, 90])),
  ];

  it.each(plans.map((plan, i) => [i, plan] as const))('%i cues only its own members', (_, plan) => {
    for (const cue of plan.cues) {
      expect(Number.isInteger(cue.member)).toBe(true);
      expect(plan[cue.side][cue.member]).toBeDefined();
    }
  });

  it.each(plans.map((plan, i) => [i, plan] as const))('%i closes after its last cue', (_, plan) => {
    for (const cue of plan.cues) {
      expect(cue.at + ('over' in cue ? cue.over : 0)).toBeLessThan(plan.length);
    }
  });

  // No two figures start on the same frame, so a rank never reads as one copied.
  it.each(plans.map((plan, i) => [i, plan] as const))(
    '%i never moves two figures as one',
    (_, plan) => {
      const seen = new Set<string>();
      for (const cue of plan.cues) {
        if (!('beat' in cue)) continue;
        const key = `${cue.side} ${cue.beat} ${cue.at}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    },
  );
});
