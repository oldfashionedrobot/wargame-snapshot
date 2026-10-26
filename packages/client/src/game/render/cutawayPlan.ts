import { band, getUnitType } from '@wargame/shared';
import type { AttackKind, UnitTypeId } from '@wargame/shared';
import { BODY } from './figures';
import type { Body, Motion, Role } from './figures';

/**
 * What a battle's cutaway shows, worked out from the battle alone: which
 * figures stand, which fall, and what each does when. Pure, so it is the one
 * part of the cutaway a test can reach; `cutaway.ts` plays it.
 *
 * ⚠️ **Each band of health is a figure** -- `band`, the health ring's own count
 * -- one figure a band, or one for two where an ensemble has five.
 */

/** The timings, in milliseconds of animation time, and the speed of a run. */
export const TIMING = {
  /** Everyone standing, before anything happens. */
  open: 400,
  /** Between one figure's beat and the next's, so a rank never moves as one. */
  stagger: 55,
  /** Presenting before a volley. */
  present: 350,
  /** A mounted ensemble's ride up to the enemy's front rank. */
  advance: 650,
  /** From a strike to the blow landing: the first flinch and the first fall. */
  impact: 220,
  /** Between one fall and the next. */
  falls: 110,
  /** From the last of the blow to the answer. */
  pause: 350,
  /** From the gun firing to its gunners ramming. */
  reload: 450,
  /** On the result, before the cutaway closes. */
  close: 800,
  /** How fast a charge or a flight goes, in stage units a second. */
  speed: { foot: 6, mounted: 10 } as Partial<Record<Body, number>>,
} as const;

/**
 * The stage, in figure units -- a man stands about one tall. Each side has a
 * half of one continuous ground, the seam between them at zero, and faces it.
 */
export const STAGE = {
  /** From the seam to each ensemble's centre. */
  home: 3.6,
  /**
   * Between the two front ranks' centres when the lines meet -- close enough
   * that a horse's head is in among the men it rides at.
   */
  reach: 0.7,
  /** How far a runner goes past its far edge, to be off the stage. */
  beyond: 9.5,
} as const;

export type Side = 'attacker' | 'defender';

/** What a figure is asked to do; its body says which animation that is. */
export type Beat =
  'face' | 'ready' | 'advance' | 'strike' | 'reload' | 'run' | 'flee' | 'flinch' | 'fall';

/**
 * Which animation answers each beat, by body. ⚠️ **A table, not a branch**: a
 * beat a body has no animation for is a beat it sits out -- the gun does not
 * flinch, the crew do not strike, only gunners reload.
 */
export const BEATS: Record<Body, Partial<Record<Beat, Motion>>> = {
  foot: {
    face: 'stand',
    ready: 'present',
    advance: 'walk',
    strike: 'fire',
    run: 'charge',
    flee: 'flee',
    flinch: 'hit',
    fall: 'fall',
  },
  mounted: {
    face: 'stand',
    advance: 'gallop',
    strike: 'cut',
    run: 'gallop',
    flee: 'gallop',
    flinch: 'hit',
    fall: 'fall',
  },
  gunner: { face: 'stand', reload: 'ram', flinch: 'hit', fall: 'fall' },
  crew: { face: 'stand', flinch: 'hit', fall: 'fall' },
  gun: { face: 'stand', strike: 'fire', fall: 'fall' },
};

/** Beats played through once and held there; the rest loop. */
export const ONCE: ReadonlySet<Beat> = new Set(['strike', 'reload', 'flinch', 'fall']);

/** One figure of an ensemble, where it stands relative to its side's home. */
export interface Member {
  role: Role;
  /** Toward the enemy. */
  forward: number;
  /** Along the line, across the stage. */
  across: number;
}

export type Cue =
  | { at: number; side: Side; member: number; beat: Beat }
  /** Moves a figure `by` toward the enemy -- away, if negative -- over `over`. */
  | { at: number; side: Side; member: number; by: number; over: number };

export interface Plan {
  attacker: Member[];
  defender: Member[];
  cues: Cue[];
  /** When each side's blow lands on it, or null if none does: its health bar falls then. */
  hits: Record<Side, number | null>;
  /** When the cutaway closes. */
  length: number;
}

export interface Fighter {
  unitTypeId: UnitTypeId;
  before: number;
  after: number;
}

export interface Battle {
  kind: AttackKind;
  answered: boolean;
  attacker: Fighter;
  defender: Fighter;
}

/**
 * Two ranks of five, centre first and then outward, the ranks alternating --
 * so a weakened unit stands as a block and its losses come off the flanks.
 * Nudged off the grid by hand, so no two stand quite in line.
 */
function ranks(role: Role, depth: number, spacing: number): Member[] {
  const order = [0, 0, -1, 1, 1, -1, -2, 2, 2, -2];
  const nudge = [0.04, -0.06, -0.03, 0.05, 0.06, -0.02, -0.05, 0.03, 0.02, -0.04];
  return order.map((place, i) => ({
    role,
    forward: (i % 2 === 0 ? depth : -depth) + nudge[i],
    across: place * spacing + nudge[(i + 3) % 10],
  }));
}

/**
 * Every member an ensemble can have, in the order they are kept: the last
 * listed falls first. The gun and the general are kept to the end.
 */
const ENSEMBLE: Record<UnitTypeId, Member[]> = {
  infantry: ranks('infantry', 0.4, 0.6),
  cavalry: ranks('cavalry', 0.8, 0.7),
  general: [
    { role: 'general', forward: 0.6, across: 0 },
    { role: 'cavalry', forward: -0.8, across: -0.45 },
    { role: 'cavalry', forward: -0.75, across: 0.45 },
    { role: 'cavalry', forward: -0.85, across: -1.3 },
    { role: 'cavalry', forward: -0.8, across: 1.3 },
  ],
  artillery: [
    { role: 'gun', forward: 0, across: 0 },
    { role: 'gunner', forward: 0.8, across: -0.8 },
    { role: 'gunner', forward: 0.75, across: 0.8 },
    { role: 'crew', forward: -1.2, across: 0.05 },
    { role: 'crew', forward: -1.15, across: -0.7 },
    { role: 'crew', forward: -1.25, across: 0.7 },
  ],
};

/** How many of an ensemble stand at this health. */
export function standing(unitTypeId: UnitTypeId, health: number): number {
  const bands = band(Math.max(0, health));
  switch (unitTypeId) {
    case 'infantry':
    case 'cavalry':
      return bands;
    case 'general':
      return Math.ceil(bands / 2);
    case 'artillery':
      // The gun stands while the unit does; its crew go one for two bands.
      return bands > 0 ? 1 + Math.ceil(bands / 2) : 0;
  }
}

/** The plan for one battle. */
export function planBattle(battle: Battle): Plan {
  const cues: Cue[] = [];
  const members = {
    attacker: ENSEMBLE[battle.attacker.unitTypeId].slice(
      0,
      standing(battle.attacker.unitTypeId, battle.attacker.before),
    ),
    defender: ENSEMBLE[battle.defender.unitTypeId].slice(
      0,
      standing(battle.defender.unitTypeId, battle.defender.before),
    ),
  };
  // Who survives: the first this many of each side; the rest fall.
  const kept = {
    attacker: standing(battle.attacker.unitTypeId, battle.attacker.after),
    defender: standing(battle.defender.unitTypeId, battle.defender.after),
  };
  const melee = (side: Side) => getUnitType(battle[side].unitTypeId).melee;
  const front = (side: Side) => Math.max(...members[side].map((m) => m.forward));
  const speed = (side: Side) => TIMING.speed[BODY[members[side][0].role]] ?? 1;
  const all = (side: Side) => members[side].map((_, i) => i);
  const survivors = (side: Side) => all(side).filter((i) => i < kept[side]);

  // How far one side goes to meet the other, front rank to front rank.
  const gap = 2 * STAGE.home - front('attacker') - front('defender') - STAGE.reach;
  // Once a side has ridden or run into the other, nobody need close again.
  let closed = false;
  const approach = (side: Side) => (melee(side) ? (closed ? 0 : TIMING.advance) : TIMING.present);

  const hits: Record<Side, number | null> = { attacker: null, defender: null };

  const beat = (side: Side, member: number, at: number, b: Beat) =>
    cues.push({ at, side, member, beat: b });
  const move = (side: Side, member: number, at: number, by: number, over: number) =>
    cues.push({ at, side, member, by, over });

  /**
   * One side's blow, timed so it lands at `lands`: a mounted ensemble rides
   * right up to the other's front rank, or cuts where it stands if the lines
   * have already met; foot present; a gun fires and is rammed. Staggered, so a
   * volley rolls along the line.
   */
  const strike = (side: Side, who: number[], lands: number) => {
    const at = lands - TIMING.impact;
    const rides = melee(side) && !closed;
    for (const [k, i] of who.entries()) {
      const s = k * TIMING.stagger;
      if (rides) {
        beat(side, i, at - TIMING.advance + s, 'advance');
        move(side, i, at - TIMING.advance + s, gap, TIMING.advance);
      } else if (!melee(side)) {
        beat(side, i, at - TIMING.present + s, 'ready');
      }
      beat(side, i, at + s, 'strike');
      beat(side, i, at + TIMING.reload + s, 'reload');
    }
    if (rides) closed = true;
  };

  /**
   * A blow taken at `at`: the losers fall one after another and the rest
   * flinch. Returns when the last of it is over.
   */
  const take = (side: Side, at: number, losers: number[]): number => {
    hits[side] = at;
    let end = at;
    for (const i of all(side)) {
      const fall = losers.indexOf(i);
      const when = fall >= 0 ? at + fall * TIMING.falls : at + i * TIMING.stagger;
      beat(side, i, when, fall >= 0 ? 'fall' : 'flinch');
      end = Math.max(end, when);
    }
    return end;
  };

  // The tail of the keeping order falls, last-kept first.
  const losers = (side: Side) =>
    all(side)
      .filter((i) => i >= kept[side])
      .reverse();

  /**
   * A side's survivors turn about at `at` and go `distance` back toward home,
   * turning to face the enemy again once there if they `face`.
   */
  const withdraw = (side: Side, at: number, distance: number, face: boolean) => {
    const over = distance / (speed(side) / 1000);
    for (const [k, i] of survivors(side).entries()) {
      const start = at + k * TIMING.stagger;
      beat(side, i, start, 'flee');
      move(side, i, start, -distance, over);
      if (face) beat(side, i, start + over, 'face');
    }
  };

  let end: number;
  if (battle.kind === 'attack') {
    const lands = TIMING.open + approach('attacker') + TIMING.impact;
    strike('attacker', all('attacker'), lands);
    end = take('defender', lands, losers('defender'));
    if (battle.answered) {
      const answer = end + TIMING.pause + approach('defender') + TIMING.impact;
      strike('defender', survivors('defender'), answer);
      end = take('attacker', answer, losers('attacker'));
    }
    // A mounted attack rides back to where it stood once the blows are
    // exchanged, rather than staying among the enemy; there it turns to face
    // them again.
    if (melee('attacker')) withdraw('attacker', end + TIMING.pause, gap, true);
  } else {
    // A charge: the whole ensemble runs at the enemy.
    const runner = 'attacker';
    const pace = speed(runner) / 1000;
    for (const [k, i] of all(runner).entries()) {
      beat(runner, i, TIMING.open + k * TIMING.stagger, 'run');
    }
    if (!battle.answered) {
      // Through, killing all of them as it passes, and off the back of their
      // ground.
      const contact = TIMING.open + gap / pace;
      const by = 2 * STAGE.home + STAGE.beyond;
      for (const [k, i] of all(runner).entries()) {
        move(runner, i, TIMING.open + k * TIMING.stagger, by, by / pace);
      }
      end = take('defender', contact, losers('defender'));
    } else {
      // Met by a free attack as it reaches their line: it stops there, its
      // losses fall, and the rest turn and run back off their own ground.
      const by = gap;
      const stop = TIMING.open + by / pace;
      for (const [k, i] of all(runner).entries()) {
        move(runner, i, TIMING.open + k * TIMING.stagger, by, by / pace);
      }
      closed = true;
      strike('defender', survivors('defender'), stop);
      end = take(runner, stop, losers(runner));
      withdraw(runner, end + TIMING.pause, by + STAGE.beyond, false);
    }
  }

  // The last thing to finish, a beat or the end of a run.
  const last = Math.max(end, ...cues.map((cue) => cue.at + ('over' in cue ? cue.over : 0)));
  cues.sort((a, b) => a.at - b.at);
  return { ...members, cues, hits, length: last + TIMING.close };
}
