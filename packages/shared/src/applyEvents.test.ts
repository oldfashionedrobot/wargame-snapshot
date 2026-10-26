import { describe, expect, it } from 'bun:test';
import { resolveAction, validateCommand } from './action';
import { applyEvents } from './applyEvents';
import { fullMeter, makeState, route, unitAt } from './testing';
import type {
  AttackKind,
  Command,
  Coordinate,
  Facing,
  GameEvent,
  GameState,
  PlayerId,
} from './types';

const pos = (col: number, row: number) => ({ col, row });

const moved = (
  unitId: string,
  from: [number, number],
  to: [number, number],
  facing: Facing = 'north',
): GameEvent => ({
  type: 'unitMoved',
  unitId,
  path: route(pos(from[0], from[1]), pos(to[0], to[1])),
  facing,
});

/** A move command whose path is a walkable route rather than two endpoints. */
const move = (unitId: string, from: Coordinate, to: Coordinate): Command => ({
  type: 'move',
  unitId,
  path: route(from, to),
  facing: 'north',
});

/** The attacker's third entry is the charge meter it ends on, empty unless given. */
const battle = (
  attacker: [string, number, number?],
  defender: [string, number],
  answered = false,
  kind: AttackKind = 'attack',
): GameEvent => ({
  type: 'battleResolved',
  kind,
  attacker: { unitId: attacker[0], health: attacker[1], chargeMeter: attacker[2] ?? 0 },
  defender: { unitId: defender[0], health: defender[1] },
  answered,
});

describe('applyEvents, battleResolved', () => {
  const state = makeState(8, [
    { id: 'b1', col: 0, row: 0 },
    { id: 'b2', col: 1, row: 0 },
    { id: 'r1', col: 2, row: 0, owner: 'red' },
  ]);

  it('writes both healths and leaves everyone else alone', () => {
    const next = applyEvents(state, [battle(['b1', 91], ['r1', 44], true)]);
    expect(unitAt(next, 'b1').health).toBe(91);
    expect(unitAt(next, 'r1').health).toBe(44);
    expect(unitAt(next, 'b2').health).toBe(unitAt(state, 'b2').health);
  });

  // Only attacking changes a meter, so only the attacker's side carries one.
  it('writes the attacker’s charge meter and leaves the defender’s alone', () => {
    const filling = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'cavalry' },
      { id: 'r1', col: 2, row: 0, owner: 'red', unitTypeId: 'cavalry', chargeMeter: 2 },
    ]);
    const next = applyEvents(filling, [battle(['b1', 90, 1], ['r1', 40], true)]);
    expect(unitAt(next, 'b1').chargeMeter).toBe(1);
    expect(unitAt(next, 'r1').chargeMeter).toBe(2);
  });

  // ⚠️ The rule stated once: zero health leaves the board. It is why there is no
  // `unitDied` event -- a second event carrying the same fact could disagree
  // with the number beside it.
  it('removes a unit the battle took to zero', () => {
    const next = applyEvents(state, [battle(['b1', 100], ['r1', 0])]);
    expect(next.units.map((unit) => unit.id)).toEqual(['b1', 'b2']);
  });

  it('removes the attacker too, when a counter kills it', () => {
    const next = applyEvents(state, [battle(['b1', 0], ['r1', 70], true)]);
    expect(next.units.map((unit) => unit.id)).toEqual(['b2', 'r1']);
  });

  // Invariant 9: absolute values, so at-least-once delivery is safe and a
  // replaying client needs no exactly-once bookkeeping.
  it('is a no-op applied twice, whether or not anyone died', () => {
    const survived = battle(['b1', 80], ['r1', 30], true);
    expect(applyEvents(state, [survived, survived])).toEqual(applyEvents(state, [survived]));

    const fatal = battle(['b1', 100], ['r1', 0]);
    expect(applyEvents(state, [fatal, fatal])).toEqual(applyEvents(state, [fatal]));
  });

  // Independently applicable: it makes sense against the state immediately
  // before it, with no knowledge of siblings -- which is what lets a log replay
  // to any point and a client fold as it animates.
  it('applies against a state where the attacker has already moved', () => {
    const afterMove = applyEvents(state, [moved('b1', [0, 0], [0, 2])]);
    const next = applyEvents(afterMove, [battle(['b1', 100], ['r1', 55])]);
    expect(unitAt(next, 'b1').position).toEqual({ col: 0, row: 2 });
    expect(unitAt(next, 'r1').health).toBe(55);
  });

  // ⚠️ The breadth I documented in the reducer, asserted rather than asserted
  // *about*: the filter removes anyone at zero, not only the two participants.
  // Unreachable in play -- nothing else can be sitting at zero -- but it is what
  // keeps the rule "zero leaves the board" one statement instead of a special
  // case, and what makes applying the event twice a no-op.
  it('removes any unit at zero, not only the two it names', () => {
    const withCorpse = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'ghost', col: 5, row: 5, health: 0 },
      { id: 'r1', col: 2, row: 0, owner: 'red' },
    ]);
    const next = applyEvents(withCorpse, [battle(['b1', 90], ['r1', 40])]);
    expect(next.units.map((unit) => unit.id)).toEqual(['b1', 'r1']);
  });

  it('carries kind and answered without either touching state', () => {
    const shot = applyEvents(state, [battle(['b1', 90], ['r1', 40], true, 'attack')]);
    const charge = applyEvents(state, [battle(['b1', 90], ['r1', 40], false, 'charge')]);
    expect(shot).toEqual(charge);
  });
});

describe('applyEvents', () => {
  const state = makeState(8, [
    { id: 'b1', col: 0, row: 0 },
    { id: 'r1', col: 7, row: 7, owner: 'red', hasActed: true },
  ]);

  it('applies unitMoved: the last tile of the path, and the unit is spent', () => {
    const next = applyEvents(state, [moved('b1', [0, 0], [2, 0])]);
    expect(unitAt(next, 'b1').position).toEqual({ col: 2, row: 0 });
    expect(unitAt(next, 'b1').hasActed).toBe(true);
  });

  // Facing is carried, not derived. The player picks it, so it need not agree
  // with the direction of travel -- which is exactly what a derivation could
  // not express.
  it('faces the unit where the event says, not where it walked', () => {
    const next = applyEvents(state, [moved('b1', [0, 0], [2, 0], 'south')]);
    expect(unitAt(next, 'b1').position).toEqual({ col: 2, row: 0 });
    expect(unitAt(next, 'b1').facing).toBe('south'); // it travelled east
  });

  it('turns a unit that did not go anywhere', () => {
    const next = applyEvents(state, [
      { type: 'unitMoved', unitId: 'b1', path: [pos(0, 0)], facing: 'west' },
    ]);
    expect(unitAt(next, 'b1').position).toEqual({ col: 0, row: 0 });
    expect(unitAt(next, 'b1').facing).toBe('west');
    expect(unitAt(next, 'b1').hasActed).toBe(true); // turning in place spends the turn
  });

  it('applies turnEnded: rotates, and refreshes the incoming player only', () => {
    const spent = applyEvents(state, [moved('b1', [0, 0], [2, 0])]);
    const next = applyEvents(spent, [{ type: 'turnEnded', nextPlayer: 'red' }]);
    expect(next.currentTurn).toBe('red');
    expect(unitAt(next, 'r1').hasActed).toBe(false);
    expect(unitAt(next, 'b1').hasActed).toBe(true);
  });

  // ⚠️ Idempotence alone cannot tell an applied heal from a dropped one: a
  // reducer that ignores the event is idempotent too.
  it('applies unitsHealed: writes each named health and leaves the rest', () => {
    const wounded = makeState(8, [
      { id: 'b1', col: 0, row: 0, health: 40 },
      { id: 'b2', col: 1, row: 0, health: 40 },
      { id: 'r1', col: 7, row: 7, owner: 'red', health: 40 },
    ]);
    const healed = applyEvents(wounded, [
      {
        type: 'unitsHealed',
        units: [
          { unitId: 'b1', health: 70 },
          { unitId: 'r1', health: 55 },
        ],
      },
    ]);
    expect(unitAt(healed, 'b1').health).toBe(70);
    expect(unitAt(healed, 'r1').health).toBe(55);
    expect(unitAt(healed, 'b2').health).toBe(40);
  });

  it('does not mutate the state it was given', () => {
    const before = JSON.stringify(state);
    applyEvents(state, [moved('b1', [0, 0], [2, 0])]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('refuses an unknown event rather than silently desyncing a replay', () => {
    const bogus = { type: 'unitVanished', unitId: 'b1' } as unknown as GameEvent;
    expect(() => applyEvents(state, [bogus])).toThrow('unknown event type: unitVanished');
  });
});

// Rule 2: events carry absolute values, not deltas. This is the property that
// makes at-least-once delivery safe, so a replaying client needs no exact-once
// bookkeeping. Any future event that fails this test is a delta in disguise.
describe('every event is idempotent', () => {
  const state = makeState(8, [
    { id: 'b1', col: 0, row: 0 },
    { id: 'r1', col: 7, row: 7, owner: 'red', hasActed: true },
  ]);

  const cases: [string, GameEvent][] = [
    ['unitMoved', moved('b1', [0, 0], [2, 0])],
    ['turnEnded', { type: 'turnEnded', nextPlayer: 'red' }],
    ['unitsHealed', { type: 'unitsHealed', units: [{ unitId: 'b1', health: 70 }] }],
    ['battleResolved', battle(['b1', 80], ['r1', 40], true)],
    ['gameEnded', { type: 'gameEnded', winner: 'blue' }],
  ];

  for (const [name, event] of cases) {
    it(`${name} applied twice equals once`, () => {
      const once = applyEvents(state, [event]);
      const twice = applyEvents(once, [event]);
      expect(twice).toEqual(once);
    });
  }
});

describe('applyEvents, gameEnded', () => {
  const state = makeState(8, [
    { id: 'b1', col: 0, row: 0 },
    { id: 'r1', col: 7, row: 7, owner: 'red' },
  ]);
  const ended: GameEvent = { type: 'gameEnded', winner: 'blue' };

  it('records the winner', () => {
    expect(applyEvents(state, [ended]).winner).toBe('blue');
  });

  // ⚠️ The whole reason the marker is additive. `getCurrentPlayer` throws when
  // `currentTurn` names nobody, and the client's turn label calls it every
  // render -- so a reducer that cleared it here would crash the board at the
  // exact moment it should be showing a result.
  it('leaves currentTurn intact', () => {
    expect(applyEvents(state, [ended]).currentTurn).toBe(state.currentTurn);
  });

  // It is a marker, not a sweep: the board is left exactly as the battle that
  // produced it left the board.
  it('removes nothing and refreshes nothing', () => {
    const after = applyEvents(state, [ended]);
    expect(after.units).toEqual(state.units);
    expect(after.grid).toEqual(state.grid);
  });
});

// Idempotent is not commutative. Ordering comes from (seq, index) and is not
// negotiable -- this test exists so nobody concludes otherwise from the above.
describe('order still matters', () => {
  it('two moves of the same unit do not commute', () => {
    const state = makeState(8, [{ id: 'b1', col: 0, row: 0 }]);
    const a = moved('b1', [0, 0], [1, 0]);
    const b = moved('b1', [1, 0], [2, 0]);
    expect(unitAt(applyEvents(state, [a, b]), 'b1').position).toEqual({ col: 2, row: 0 });
    expect(unitAt(applyEvents(state, [b, a]), 'b1').position).toEqual({ col: 1, row: 0 });
  });
});

/**
 * A multi-turn script driven exactly as the server drives it: validate,
 * resolve, fold.
 *
 * ⚠️ It does **not** prove `initial + log === current`. `live` is built by
 * folding the same events in the same order, so that comparison holds for any
 * reducer, including one that ignores its events entirely. The real property
 * -- the *persisted* checkpoint equalling a fold of the *persisted* log, two
 * independently-written things -- is `match.test.ts`'s, because only the
 * server has two paths to compare.
 *
 * What this does catch is a script that stops validating or resolving part
 * way through, which is why every step asserts acceptance.
 */
describe('a full turn cycle validates, resolves and folds', () => {
  const twoEach = () =>
    makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'b2', col: 1, row: 0 },
      { id: 'r1', col: 7, row: 7, owner: 'red' },
      { id: 'r2', col: 6, row: 7, owner: 'red' },
    ]);

  /**
   * Plays a script exactly the way the server does -- validate, resolve, fold
   * -- at an explicit budget.
   *
   * ⚠️ **The budget is passed, never inherited.** `ACTIONS_PER_TURN` is a dial;
   * a script that reads it is a script that stops validating the day it moves,
   * and it would fail as a *rejected command* rather than as a wrong answer,
   * which is the confusing way round.
   */
  const play = (initial: GameState, script: [Command, PlayerId][], budget: number | null) => {
    let live: GameState = initial;
    const log: GameEvent[] = [];
    for (const [command, actor] of script) {
      const validation = validateCommand(live, command, actor);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return { live, log };
      // Rolls fixed at zero, so a script with attacks in it resolves the same
      // every run.
      const events = resolveAction(
        live,
        validation.action,
        { attack: 0, counter: 0, charge: 0 },
        budget,
      );
      log.push(...events);
      live = applyEvents(live, events);
    }
    return { live, log };
  };

  // ⚠️ Written to cross both ways a turn can end. Blue's two moves spend its
  // whole roster, so the second carries a `turnEnded` with it and no button is
  // needed. Red moves once and then stops with r2 still able to act, which only
  // an explicit `endTurn` can do -- the one job the button keeps.
  it('over a multi-turn script, with the whole roster each turn', () => {
    const initial = twoEach();
    const { live, log } = play(
      initial,
      [
        [move('b1', pos(0, 0), pos(1, 2)), 'blue'],
        [move('b2', pos(1, 0), pos(2, 2)), 'blue'], // spends blue's last action
        [move('r1', pos(7, 7), pos(6, 5)), 'red'],
        [{ type: 'endTurn' }, 'red'], // early, with r2 unmoved
        [move('b1', pos(1, 2), pos(2, 4)), 'blue'],
        [{ type: 'endTurn' }, 'blue'],
      ],
      null,
    );

    // Six commands, seven events: five of them produce one apiece, and blue's
    // second move produces two by finishing the turn as it goes.
    expect(log).toHaveLength(7);
    expect(applyEvents(initial, log)).toEqual(live);
  });

  // ⚠️ The other regime, and the shape is inverted: *every* move carries a
  // `turnEnded`, so play alternates on each action and the button is the only
  // way to pass without moving. Same three properties -- every command
  // validates, resolution is pure, the fold agrees.
  it('over a multi-turn script, one action a turn', () => {
    const initial = twoEach();
    const { live, log } = play(
      initial,
      [
        [move('b1', pos(0, 0), pos(1, 2)), 'blue'], // ends blue's turn by itself
        [move('r1', pos(7, 7), pos(6, 5)), 'red'],
        [move('b1', pos(1, 2), pos(2, 4)), 'blue'], // the same unit, twice running
        [{ type: 'endTurn' }, 'red'], // passing without moving still needs the button
      ],
      1,
    );

    // Three moves at two events apiece, and the lone `endTurn` at one.
    expect(log).toHaveLength(7);
    expect(log.filter((event) => event.type === 'turnEnded')).toHaveLength(4);
    expect(applyEvents(initial, log)).toEqual(live);
  });

  // ⚠️ The meter is state, so it has to fold like health: attacks fill it, a
  // charge spends it, and the log replays to the same place. r1 is a gun on
  // a peak, which never answers, and b1 is wounded so its hits stay small
  // however long the meter is -- so r1 outlasts them; r2 is worn down enough
  // to break.
  it('folds a charge meter through filling it and a charge', () => {
    const initial = makeState(
      ['....', '....', '.^..', '....'],
      [
        { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', health: 20 },
        { id: 'r1', col: 1, row: 2, owner: 'red', unitTypeId: 'artillery' },
        { id: 'r2', col: 0, row: 1, owner: 'red', health: 10 },
      ],
    );
    const hit = (attackKind: AttackKind, targetUnitId: string, facing: Facing): Command => ({
      type: 'move',
      unitId: 'b1',
      path: [pos(1, 1)],
      facing,
      targetUnitId,
      attackKind,
    });
    const full = fullMeter('cavalry');
    const script: [Command, PlayerId][] = [];
    for (let i = 0; i < full; i++) {
      script.push([hit('attack', 'r1', 'north'), 'blue'], [{ type: 'endTurn' }, 'red']);
    }
    script.push([hit('charge', 'r2', 'west'), 'blue']);
    const { live, log } = play(initial, script, null);

    const meters = log.flatMap((e) =>
      e.type === 'battleResolved' ? [e.attacker.chargeMeter] : [],
    );
    expect(meters).toEqual([...Array.from({ length: full }, (_, i) => i + 1), 0]);
    expect(live.units.map((unit) => unit.id)).toEqual(['b1', 'r1']);
    expect(applyEvents(initial, log)).toEqual(live);
  });

  // Replaying a prefix of the log lands on the state that prefix describes.
  // Asserting against a stepwise fold would be circular -- both are the same
  // reduce -- so the expectations are written out independently. ⚠️ The log
  // carries every event type, so an event that stopped applying on its own
  // would show up here as a prefix landing somewhere else.
  it('replays to any point along the way, not just the end', () => {
    const initial = makeState(8, [
      { id: 'b1', col: 0, row: 0, health: 50 },
      { id: 'r1', col: 7, row: 7, owner: 'red' },
    ]);
    const log: GameEvent[] = [
      moved('b1', [0, 0], [1, 0]),
      { type: 'turnEnded', nextPlayer: 'red' },
      { type: 'unitsHealed', units: [{ unitId: 'b1', health: 70 }] },
      { type: 'turnEnded', nextPlayer: 'blue' },
      moved('b1', [1, 0], [3, 0]),
      battle(['b1', 60], ['r1', 0]),
      { type: 'gameEnded', winner: 'blue' },
    ];

    const both = ['b1', 'r1'];
    const expected = [
      { col: 1, row: 0, turn: 'blue', spent: true, health: 50, alive: both, winner: null },
      { col: 1, row: 0, turn: 'red', spent: true, health: 50, alive: both, winner: null },
      { col: 1, row: 0, turn: 'red', spent: true, health: 70, alive: both, winner: null },
      { col: 1, row: 0, turn: 'blue', spent: false, health: 70, alive: both, winner: null }, // blue's units refreshed
      { col: 3, row: 0, turn: 'blue', spent: true, health: 70, alive: both, winner: null },
      { col: 3, row: 0, turn: 'blue', spent: true, health: 60, alive: ['b1'], winner: null },
      { col: 3, row: 0, turn: 'blue', spent: true, health: 60, alive: ['b1'], winner: 'blue' },
    ];

    for (const [i, want] of expected.entries()) {
      const at = applyEvents(initial, log.slice(0, i + 1));
      expect(unitAt(at, 'b1').position).toEqual({ col: want.col, row: want.row });
      expect(at.currentTurn).toBe(want.turn);
      expect(unitAt(at, 'b1').hasActed).toBe(want.spent);
      expect(unitAt(at, 'b1').health).toBe(want.health);
      expect(at.units.map((unit) => unit.id)).toEqual(want.alive);
      expect(at.winner).toBe(want.winner);
    }
  });
});
