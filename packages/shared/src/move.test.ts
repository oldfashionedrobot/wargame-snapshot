import { describe, expect, it } from 'bun:test';
import { validateCommand } from './action';
import { resolveMove, validateMove } from './move';
import { band } from './combat';
import type { Rolls } from './combat';
import { LUCK_MAX } from './data/combat';
import { getUnitType, MAX_HEALTH } from './data/unitTypes';
import { at, fullMeter, makeState, route } from './testing';
import type { Command, Facing, MoveCommand } from './types';

// validateMove asks three separate questions -- does the unit exist, may it
// act, is the route walkable -- and only the third is validatePath's. These
// cover the first two and the handoff; validatePath has its own suite in
// movement.test.ts.

const board = makeState(6, [
  { id: 'b1', col: 0, row: 0 },
  { id: 'spent', col: 3, row: 0, hasActed: true },
  { id: 'r1', col: 5, row: 5, owner: 'red' },
]);

// ⚠️ `facing` is required and was missing here until 9f -- which compiled only
// because `shared/`'s own test files are not typechecked. It flowed through as
// undefined and the assertions never looked.
const move = (
  unitId: string,
  from: ReturnType<typeof at>,
  to: ReturnType<typeof at>,
  targetUnitId?: string,
): MoveCommand => ({
  type: 'move',
  unitId,
  path: route(from, to),
  facing: 'north',
  ...(targetUnitId === undefined ? {} : { targetUnitId }),
});

describe('validateMove', () => {
  it('accepts a walkable route for a unit that can act', () => {
    expect(validateMove(board, move('b1', at(0, 0), at(2, 0)))).toBeNull();
  });

  it('refuses a unit id that is not on the board', () => {
    expect(validateMove(board, move('ghost', at(0, 0), at(1, 0)))).toBe('unit not found');
  });

  // Two reasons, one predicate: the gate is canSelectUnit, and the message is
  // derived from it rather than re-deciding what "may act" means.
  it('distinguishes a spent unit from one that is not yours', () => {
    expect(validateMove(board, move('spent', at(3, 0), at(4, 0)))).toBe(
      'that unit has already acted',
    );
    expect(validateMove(board, move('r1', at(5, 5), at(5, 4)))).toBe('that unit is not yours');
  });

  it('hands the route to validatePath, which refuses on its own terms', () => {
    // Out of infantry's range of 3, so the failure comes from the walk.
    expect(validateMove(board, move('b1', at(0, 0), at(5, 0)))).toBe('move exceeds movement range');
  });

  // Ownership is checked before the route, so an opponent's unit is refused as
  // theirs rather than for whatever is wrong with the path.
  it('checks who may act before it checks the route', () => {
    const nonsense: MoveCommand = {
      type: 'move',
      unitId: 'r1',
      path: [at(9, 9)],
      facing: 'north',
    };
    expect(validateMove(board, nonsense)).toBe('that unit is not yours');
  });
});

// Two units on a lane, so distances are easy to read off the column.
const lane = (enemyRow: number, unitTypeId: 'infantry' | 'artillery' = 'infantry') =>
  makeState(8, [
    { id: 'b1', col: 0, row: 0, unitTypeId },
    { id: 'friend', col: 7, row: 0 },
    // ⚠️ Stated, not inherited. `b1` attacks from the south, so a defender
    // looking south is looking *at* it -- and an attack from directly behind is
    // never answered, so the fixture's own default deciding that would make
    // every counter below depend on something it does not mention.
    { id: 'r1', col: 0, row: enemyRow, owner: 'red', facing: 'south' },
  ]);

const resolved = (
  state: ReturnType<typeof lane>,
  command: MoveCommand,
  rolls: Rolls = { attack: 0, counter: 0, charge: 0 },
) => {
  const validation = validateCommand(state, command as Command, 'blue');
  if (!validation.ok) throw new Error(`expected a legal command, got: ${validation.reason}`);
  return resolveMove(state, validation.action as Parameters<typeof resolveMove>[1], rolls);
};

describe('validateMove, with a target', () => {
  // ⚠️ The pair that matters, and the reason `refuseAttack` takes the
  // destination rather than reading `unit.position`. Both enemies are two tiles
  // from *somewhere* the unit could be -- one from where it starts, one from
  // where it ends -- and only the second is a legal shot.
  it('measures range from the destination, not the origin', () => {
    // Enemy four away: out of infantry's 2 from the origin, in range after
    // walking two tiles toward it.
    const far = lane(4);
    expect(validateMove(far, move('b1', at(0, 0), at(0, 0), 'r1'))).toBe('target is out of range');
    expect(validateMove(far, move('b1', at(0, 0), at(0, 2), 'r1'))).toBeNull();
  });

  it('refuses a shot that was in range before the unit moved away', () => {
    const near = lane(2);
    expect(validateMove(near, move('b1', at(0, 0), at(0, 0), 'r1'))).toBeNull();
    expect(validateMove(near, move('b1', at(0, 0), at(3, 0), 'r1'))).toBe('target is out of range');
  });

  // A minimum range is artillery's defining weakness, and it is this predicate
  // rather than any rule naming it. ⚠️ **Every tile of the dead zone**, read
  // off the catalog: how deep it is has been retuned from play before.
  it('refuses a target standing too close for the attacker', () => {
    const { min } = getUnitType('artillery').range;
    for (let enemyRow = 1; enemyRow < min; enemyRow++) {
      const closed = lane(enemyRow, 'artillery');
      expect(validateMove(closed, move('b1', at(0, 0), at(0, 0), 'r1'))).toBe(
        'target is too close',
      );
    }
    // And the first tile past it is fine, so this is a band rather than a ban.
    expect(validateMove(lane(min, 'artillery'), move('b1', at(0, 0), at(0, 0), 'r1'))).toBeNull();
  });

  it('refuses a target that is not on the board', () => {
    expect(validateMove(lane(2), move('b1', at(0, 0), at(0, 0), 'ghost'))).toBe('target not found');
  });

  it('refuses attacking your own side, and yourself', () => {
    const state = lane(2);
    expect(validateMove(state, move('b1', at(0, 0), at(3, 0), 'friend'))).toBe(
      'that unit is yours',
    );
    expect(validateMove(state, move('b1', at(0, 0), at(0, 0), 'b1'))).toBe('that unit is yours');
  });

  // The route is checked first, so an illegal walk is reported as such rather
  // than as whatever the attack would have said from a tile it cannot reach.
  it('reports an unwalkable route before it looks at the target', () => {
    expect(validateMove(lane(2), move('b1', at(0, 0), at(0, 7), 'r1'))).not.toBe(
      'target is out of range',
    );
  });
});

describe('resolveMove', () => {
  it('emits one unitMoved carrying every step of the path', () => {
    expect(resolved(lane(6), move('b1', at(0, 0), at(2, 0)))).toEqual([
      { type: 'unitMoved', unitId: 'b1', path: [at(0, 0), at(1, 0), at(2, 0)], facing: 'north' },
    ]);
  });

  it('emits the move first, then the battle', () => {
    const events = resolved(lane(4), move('b1', at(0, 0), at(0, 2), 'r1'));
    expect(events.map((event) => event.type)).toEqual(['unitMoved', 'battleResolved']);
  });

  it('takes the damage off the defender and names both sides', () => {
    const state = lane(4);
    const [, battle] = resolved(state, move('b1', at(0, 0), at(0, 2), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');

    expect(battle.defender.unitId).toBe('r1');
    expect(battle.defender.health).toBeLessThan(MAX_HEALTH);
    expect(battle.attacker.unitId).toBe('b1');
    expect(battle.kind).toBe('attack');
  });

  // ⚠️ Clamped, because the event says what the defender *has* -- a negative
  // health is a number no rule could read, and `applyEvents` removes at zero.
  it('clamps a fatal hit to zero rather than going negative', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red', health: 4 },
    ]);
    const [, battle] = resolved(state, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.defender.health).toBe(0);
  });

  // ⚠️ Infantry reaches two tiles, so closing to two is a mutual exchange: the
  // attacker is inside the defender's band and gets answered for it.
  it('is answered when the attacker is inside the defender’s range', () => {
    const [, battle] = resolved(lane(4), move('b1', at(0, 0), at(0, 2), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.answered).toBe(true);
    expect(battle.attacker.health).toBeLessThan(MAX_HEALTH);
  });

  // ⚠️ The whole point of outranging someone. Artillery reaches five and
  // infantry reaches two, so a gun firing from four is never answered -- one
  // predicate, and no rule anywhere naming "indirect".
  it('is unanswered when the attacker outranges the defender', () => {
    const state = lane(4, 'artillery');
    const [, battle] = resolved(state, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.answered).toBe(false);
    expect(battle.attacker.health).toBe(MAX_HEALTH);
  });

  it('is unanswered when the defender did not survive it', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red', health: 3 },
    ]);
    const [, battle] = resolved(state, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.defender.health).toBe(0);
    expect(battle.answered).toBe(false);
  });

  // ⚠️ **Counter-battery is gone, and this replaced the test that pinned it.**
  // Two guns within reach used to answer each other -- a deliberate divergence
  // from AW, on the grounds that history allows it. Play disagreed: `slow` now
  // means a gun never answers at all, reached or not.
  it('never lets a gun answer, at reach or at contact', () => {
    const duel = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red', unitTypeId: 'artillery', facing: 'south' },
    ]);
    const [, counterBattery] = resolved(duel, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (counterBattery.type !== 'battleResolved') throw new Error('expected a battle');
    expect(counterBattery.answered).toBe(false);

    const reached = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 1, owner: 'red', unitTypeId: 'artillery', facing: 'south' },
    ]);
    const [, atContact] = resolved(reached, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (atContact.type !== 'battleResolved') throw new Error('expected a battle');
    expect(atContact.answered).toBe(false);
  });

  // ⚠️ The rear rule, end to end. The predicate has its own tests; this is the
  // one that proves it reaches the *event* -- `answered` is what decides whether
  // a riposte is computed at all, so an attacker still at full health is the
  // observable consequence rather than a restatement of the flag.
  it('is unanswered from directly behind, and the attacker takes nothing', () => {
    const behind = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 2, owner: 'red', facing: 'north' },
    ]);
    const [, battle] = resolved(behind, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.answered).toBe(false);
    expect(battle.attacker.health).toBe(MAX_HEALTH);
  });

  // The same shot from the same tile against the same unit, turned around: what
  // isolates the facing as the cause rather than anything else about the setup.
  it('is answered from that same tile when the defender is facing it', () => {
    const facing = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 2, owner: 'red', facing: 'south' },
    ]);
    const [, battle] = resolved(facing, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.answered).toBe(true);
    expect(battle.attacker.health).toBeLessThan(MAX_HEALTH);
  });

  // ⚠️ Front and flank are the same answer: only the rear is refused, and a
  // flanked defender replies in full. `answered` is true in both, so the
  // *health* is the evidence that nothing was taken off.
  it('answers a flanking shot in full, the same as a head-on one', () => {
    const shot = (look: 'east' | 'south') => {
      const state = makeState(8, [
        { id: 'b1', col: 0, row: 0 },
        { id: 'r1', col: 0, row: 2, owner: 'red', facing: look },
      ]);
      const [, battle] = resolved(state, move('b1', at(0, 0), at(0, 0), 'r1'));
      if (battle.type !== 'battleResolved') throw new Error('expected a battle');
      return battle;
    };
    expect(shot('east').answered).toBe(true);
    expect(shot('east').attacker.health).toBe(shot('south').attacker.health);
  });

  // *No living attacker is harmless* holds for counters too: a defender in the
  // lowest band, answering an attacker on a peak, still lands something.
  it('lands something on a flanked counter, even from the lowest band', () => {
    // Road under the defender, so no cover keeps it out of the lowest band.
    const peak = (facing: 'south' | 'west') =>
      makeState(
        ['^-', '..'],
        [
          { id: 'b1', col: 0, row: 0 },
          { id: 'r1', col: 1, row: 0, owner: 'red', health: 55, facing },
        ],
      );
    const fight = (facing: 'south' | 'west') => {
      const [, battle] = resolved(peak(facing), {
        ...move('b1', at(0, 0), at(0, 0), 'r1'),
        facing: 'east',
      });
      if (battle.type !== 'battleResolved') throw new Error('expected a battle');
      return battle;
    };
    const headOn = fight('west');
    const flanked = fight('south');
    expect(band(headOn.defender.health)).toBe(1);
    expect(headOn.attacker.health).toBeLessThan(MAX_HEALTH);
    expect(flanked.answered).toBe(true);
    expect(flanked.attacker.health).toBe(headOn.attacker.health);
  });

  // A melee unit cannot answer a ranged attacker: infantry may fire point-blank
  // into cavalry and draw nothing back, where a sabre answers a sabre.
  it('draws no answer from cavalry shot at by infantry beside it', () => {
    const board = (attacker: 'infantry' | 'cavalry') =>
      makeState(4, [
        { id: 'b1', col: 0, row: 0, unitTypeId: attacker },
        { id: 'r1', col: 0, row: 1, owner: 'red', unitTypeId: 'cavalry', facing: 'south' },
      ]);
    const fight = (attacker: 'infantry' | 'cavalry') => {
      const [, battle] = resolved(board(attacker), {
        ...move('b1', at(0, 0), at(0, 0), 'r1'),
        facing: 'north',
      });
      if (battle.type !== 'battleResolved') throw new Error('expected a battle');
      return battle;
    };
    const shot = fight('infantry');
    expect(shot.answered).toBe(false);
    expect(shot.attacker.health).toBe(MAX_HEALTH);
    expect(fight('cavalry').answered).toBe(true);
  });

  // `hasActed` stops a unit *acting* twice in its own turn; answering an attack
  // is not acting, and the predicate is purely geometric so it never asks.
  it('is answered by a defender that has already acted', () => {
    const spent = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 2, owner: 'red', hasActed: true, facing: 'south' },
    ]);
    const [, battle] = resolved(spent, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.answered).toBe(true);
  });

  // ⚠️ Most of AW's exchange calculus, and it falls out of the formula rather
  // than needing a rule: the counter is computed on the defender's *reduced*
  // health, so a harder first blow buys a softer reply. Same board, same counter
  // roll -- only the attack roll differs.
  //
  // ⚠️ **The defender's starting health is chosen, not incidental.** The reply
  // is scaled by `band()`, so a luckier blow only softens it when the extra
  // damage pushes the defender across a *band boundary* -- inside one band the
  // counter is identical and this asserts nothing. The starting health is
  // picked so the luck spread straddles one.
  //
  // ⚠️ **Anything that moves damage moves where that happens, and this test is
  // how you find out** -- it has failed for that reason before.
  it('counters on post-damage health, so striking first compounds', () => {
    const board = () =>
      makeState(8, [
        { id: 'b1', col: 0, row: 0 },
        { id: 'r1', col: 0, row: 2, owner: 'red', health: 70 },
      ]);
    const command = move('b1', at(0, 0), at(0, 0), 'r1');

    const riposte = (attack: number) => {
      const [, battle] = resolved(board(), command, { attack, counter: 0, charge: 0 });
      if (battle.type !== 'battleResolved') throw new Error('expected a battle');
      return MAX_HEALTH - battle.attacker.health;
    };

    expect(riposte(LUCK_MAX)).toBeLessThan(riposte(0));
  });

  // ⚠️ The attacker struck first, so its blow lands even when the reply kills
  // it -- the mirror of a dead defender never answering.
  it('lands the attacker’s blow even when the counter kills it', () => {
    const doomed = makeState(8, [
      { id: 'b1', col: 0, row: 0, health: 4 },
      { id: 'r1', col: 0, row: 2, owner: 'red' },
    ]);
    const [, battle] = resolved(doomed, move('b1', at(0, 0), at(0, 0), 'r1'));
    if (battle.type !== 'battleResolved') throw new Error('expected a battle');
    expect(battle.attacker.health).toBe(0);
    expect(battle.answered).toBe(true);
    expect(battle.defender.health).toBeLessThan(MAX_HEALTH);
  });

  it('passes the roll through, so a better one hurts more', () => {
    const command = move('b1', at(0, 0), at(0, 2), 'r1');
    const unlucky = resolved(lane(4), command, { attack: 0, counter: 0, charge: 0 })[1];
    const lucky = resolved(lane(4), command, { attack: LUCK_MAX, counter: 0, charge: 0 })[1];
    if (unlucky.type !== 'battleResolved' || lucky.type !== 'battleResolved') throw new Error();
    expect(lucky.defender.health).toBeLessThan(unlucky.defender.health);
  });
});

// ⚠️ **A turn rule, which is why it could not fall out of the range band.**
// `min: 3` describes a distance and says nothing about whether a gun may shoot
// in the same turn it repositioned -- so unlike every other behaviour AW spreads
// across direct-versus-indirect, this one needed a flag.
describe('validateMove, a slow unit', () => {
  const gunline = (path: [number, number][], facing: Facing = 'north') => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red' },
    ]);
    const command: MoveCommand = {
      type: 'move',
      unitId: 'b1',
      path: path.map(([col, row]) => at(col, row)),
      facing,
      targetUnitId: 'r1',
    };
    return validateMove(state, command);
  };

  it('may attack without moving', () => {
    expect(gunline([[0, 0]])).toBeNull();
  });

  // ⚠️ **Turning is not moving**, and the flag reads `path.length > 1` rather
  // than "did anything change" precisely so. A piece can be traversed a little
  // without being limbered up and hauled, so a gun may pivot onto a target and
  // fire in the same action -- which is also what keeps facing a real decision
  // for the one unit that can never answer a shot.
  it('may turn on the spot and still fire', () => {
    expect(gunline([[0, 0]], 'north')).toBeNull();
  });

  it('may not attack after moving', () => {
    expect(
      gunline([
        [0, 0],
        [1, 0],
      ]),
    ).toBe('artillery cannot move and attack in one turn');
  });

  // ⚠️ Moving alone stays legal: the flag forbids doing *both*, not moving.
  it('may still move, so long as that is all it does', () => {
    const state = makeState(8, [{ id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' }]);
    expect(
      validateMove(state, {
        type: 'move',
        unitId: 'b1',
        path: [at(0, 0), at(1, 0)],
        facing: 'north',
      }),
    ).toBeNull();
  });

  // The other side of the flag, so a fast unit is not quietly caught by it.
  it('does not stop a unit that is not slow', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 0, row: 2, owner: 'red' },
    ]);
    expect(
      validateMove(state, {
        type: 'move',
        unitId: 'b1',
        path: route(at(0, 0), at(0, 1)),
        facing: 'north',
        targetUnitId: 'r1',
      }),
    ).toBeNull();
  });
});

// ⚠️ **A unit that starts in contact moves or attacks, not both** -- the same
// refusal `slow` lives under, with a second cause. Blue foot at (1,1), red
// foot beside it at (1,2), a second red at (4,1). Blue's meter is full and the
// red beside it worn down, so a charge here is refused for the turn rule or not
// at all.
describe('validateMove, a unit in contact', () => {
  const engaged = (unitTypeId: 'infantry' | 'cavalry' = 'infantry') =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId, chargeMeter: fullMeter(unitTypeId) },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 5 },
      { id: 'r2', col: 4, row: 1, owner: 'red' },
    ]);
  const order = (
    path: [number, number][],
    extra: Partial<MoveCommand> = {},
    unitTypeId?: 'infantry' | 'cavalry',
  ) =>
    validateMove(engaged(unitTypeId), {
      type: 'move',
      unitId: 'b1',
      path: path.map(([col, row]) => at(col, row)),
      facing: 'north',
      ...extra,
    });

  it('may attack from where it stands', () => {
    expect(order([[1, 1]], { targetUnitId: 'r1' })).toBeNull();
  });

  it('may not move and then attack', () => {
    expect(
      order(
        [
          [1, 1],
          [0, 1],
        ],
        { targetUnitId: 'r1' },
      ),
    ).toBe('a unit that starts in contact can move or attack, not both');
  });

  it('may move away, so long as that is all it does', () => {
    expect(
      order([
        [1, 1],
        [1, 0],
      ]),
    ).toBeNull();
  });

  // Allowed rather than forbidden: ending beside a different enemy is already a
  // poor move, and needs no rule to say so.
  it('may withdraw into contact with another enemy', () => {
    expect(
      order([
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    ).toBeNull();
  });

  // A cavalry already in contact may charge: that is attacking from where it
  // stands.
  it('may charge from where it stands', () => {
    expect(order([[1, 1]], { targetUnitId: 'r1', attackKind: 'charge' }, 'cavalry')).toBeNull();
  });

  it('may not move and then charge', () => {
    expect(
      order(
        [
          [1, 1],
          [0, 1],
          [0, 2],
        ],
        { targetUnitId: 'r1', attackKind: 'charge' },
        'cavalry',
      ),
    ).toBe('a unit that starts in contact can move or attack, not both');
  });

  // The other side of the rule: a unit that starts in the open moves *into*
  // contact and attacks on arrival, which is how contact is ever made.
  it('does not stop a unit that starts in the open', () => {
    const state = makeState(7, [
      { id: 'b1', col: 1, row: 0 },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);
    expect(
      validateMove(state, {
        type: 'move',
        unitId: 'b1',
        path: [at(1, 0), at(1, 1)],
        facing: 'north',
        targetUnitId: 'r1',
      }),
    ).toBeNull();
  });
});

// A full-meter cavalryman charging head-on into infantry -- worn down far
// enough to break for certain, unless a test sends it into a fresh one.
describe('resolveMove, charging', () => {
  const at_ = (col: number, row: number) => ({ col, row });
  const field = (health = 10, unitTypeId: 'infantry' | 'artillery' = 'infantry') =>
    makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red', health, facing: 'south', unitTypeId },
    ]);
  const charge = (): MoveCommand => ({
    type: 'move',
    unitId: 'b1',
    path: [at_(1, 1)],
    facing: 'north',
    targetUnitId: 'r1',
    attackKind: 'charge',
  });
  // The charge roll decides it; 0 breaks through anything the charge has a
  // chance against, and 99 fails anything short of certain.
  const play = (state: ReturnType<typeof field>, roll = 0) => {
    const validation = validateCommand(state, charge() as Command, 'blue');
    if (!validation.ok) throw new Error(`expected legal, got: ${validation.reason}`);
    return resolveMove(state, validation.action as Parameters<typeof resolveMove>[1], {
      attack: LUCK_MAX,
      counter: LUCK_MAX,
      charge: roll,
    });
  };

  // ⚠️ **The order is the invariant.** The defender leaves the board when its
  // health hits zero, so displacing before the battle would put the attacker on
  // an occupied tile -- which breaks "each event makes sense against the state
  // immediately before it".
  it('breaks through as battle-then-displacement, in that order', () => {
    const events = play(field());
    expect(events.map((e) => e.type)).toEqual(['unitMoved', 'battleResolved', 'unitMoved']);
    const [, battle, displacement] = events;
    if (battle.type !== 'battleResolved' || displacement.type !== 'unitMoved')
      throw new Error('shape');
    expect(battle.defender.health).toBe(0);
    expect(displacement.path.at(-1)).toEqual(at_(1, 2));
  });

  // ⚠️ A *second* `unitMoved` for one unit in one batch, which nothing else
  // produces. It is one step, from where the charge was launched onto the tile
  // that was just vacated.
  it('displaces exactly one step, onto the tile it emptied', () => {
    const events = play(field());
    const displacement = events.at(-1);
    if (displacement?.type !== 'unitMoved') throw new Error('shape');
    expect(displacement.path).toEqual([at_(1, 1), at_(1, 2)]);
    expect(displacement.unitId).toBe('b1');
  });

  // ⚠️ **The claim that charge being contact-only is load-bearing.** The command
  // carries a facing pointing at the target, and the displacement is one step
  // onto that same tile -- so "face the target" and "face the way you travelled"
  // are necessarily the same direction, and no second decision is needed. A
  // ranged charge would break that silently, which is why it is asserted rather
  // than left as reasoning in a doc.
  it('ends facing the way it charged, on both events', () => {
    const events = play(field());
    const [approach, , displacement] = events;
    if (approach.type !== 'unitMoved' || displacement.type !== 'unitMoved')
      throw new Error('shape');
    expect(approach.facing).toBe('north');
    expect(displacement.facing).toBe('north');
  });

  it('emits no displacement when the charge is repelled', () => {
    const events = play(field(MAX_HEALTH), 99);
    expect(events.map((e) => e.type)).toEqual(['unitMoved', 'battleResolved']);
  });

  // ⚠️ A failed charge is met by a free attack whatever the counter rule says,
  // so a defender that could never have countered still repels. Artillery is
  // the case that proves it -- a battery answers nothing at all -- and charging
  // one must not be free.
  it('is repelled by artillery, which could never have countered', () => {
    const [, battle] = play(field(MAX_HEALTH, 'artillery'), 99);
    if (battle.type !== 'battleResolved') throw new Error('shape');
    expect(battle.answered).toBe(true);
    expect(battle.attacker.health).toBeLessThan(MAX_HEALTH);
    expect(battle.attacker.chargeMeter).toBe(0);
  });
});

describe('validateMove, charging', () => {
  it('refuses an attack kind with nothing to attack', () => {
    const state = makeState(7, [{ id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry' }]);
    const stray: MoveCommand = {
      type: 'move',
      unitId: 'b1',
      path: [{ col: 1, row: 1 }],
      facing: 'north',
      attackKind: 'charge',
    };
    expect(validateMove(state, stray)).toBe('an attack kind needs a target');
  });
});

describe('validateMove, attack facing', () => {
  // A gun at the origin and a target within its range of three to five.
  const aim = (col: number, row: number, facing: Facing) =>
    validateMove(
      makeState(8, [
        { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
        { id: 'r1', col, row, owner: 'red' },
      ]),
      { type: 'move', unitId: 'b1', path: [at(0, 0)], facing, targetUnitId: 'r1' },
    );

  it('accepts an attack that ends facing its target', () => {
    expect(aim(1, 3, 'north')).toBeNull();
  });

  it('refuses one that ends facing anywhere else', () => {
    for (const facing of ['east', 'south', 'west'] as const)
      expect(aim(1, 3, facing)).not.toBeNull();
  });

  // Dead on the diagonal, the row wins: the rule is facingToward's, stated once.
  it('takes the row on an exact diagonal', () => {
    expect(aim(2, 2, 'north')).toBeNull();
    expect(aim(2, 2, 'east')).not.toBeNull();
  });
});
