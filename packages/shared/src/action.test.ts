import { describe, expect, it } from 'bun:test';
import { resolveAction, validateCommand } from './action';
import { applyEvents } from './applyEvents';
import { actionEndsTurn } from './turns';
import { GENERAL_HEALING } from './data/unitTypes';
import { at, makeState, route } from './testing';
import type { Command, MoveCommand } from './types';

const NO_LUCK = { attack: 0, counter: 0, charge: 0 };

// b1 starts at (0,0). A real route, not an endpoint pair -- validatePath
// walks every step in 6c, so a fixture describing a straight jump would be
// describing a move no client can make.
// ⚠️ `MoveCommand`, not `Command`. Spreading a *union* and adding `actor`
// produces something assignable to neither member, which is what the smuggled-
// actor test below needs to build.
const to = (col: number, row: number): MoveCommand => ({
  type: 'move',
  unitId: 'b1',
  path: route({ col: 0, row: 0 }, { col, row }),
  facing: 'north',
});

/** validateCommand is the only Action constructor, so tests go through it too. */
const accept = (state: ReturnType<typeof makeState>, command: Command, actor = 'blue') => {
  const validation = validateCommand(state, command, actor);
  if (!validation.ok) throw new Error(`expected acceptance, got: ${validation.reason}`);
  return validation.action;
};

describe('validateCommand', () => {
  const state = makeState(6, [{ id: 'b1', col: 0, row: 0 }]);

  // The actor check comes before anything else, so a command from the wrong
  // player is refused without the board being consulted at all.
  it('refuses an actor who is not the current player', () => {
    expect(validateCommand(state, to(1, 0), 'red')).toEqual({
      ok: false,
      reason: 'not your turn',
    });
  });

  it('refuses a unit that does not exist', () => {
    const ghost: Command = {
      type: 'move',
      unitId: 'ghost',
      path: [{ col: 0, row: 0 }],
      facing: 'north',
    };
    expect(validateCommand(state, ghost, 'blue')).toEqual({
      ok: false,
      reason: 'unit not found',
    });
  });

  it('refuses an empty path', () => {
    expect(
      validateCommand(state, { type: 'move', unitId: 'b1', path: [], facing: 'north' }, 'blue'),
    ).toEqual({
      ok: false,
      reason: 'path is empty',
    });
  });

  it('refuses a destination out of range', () => {
    expect(validateCommand(state, to(5, 5), 'blue')).toEqual({
      ok: false,
      reason: 'move exceeds movement range',
    });
  });

  it('refuses a unit that has already acted', () => {
    const acted = makeState(6, [{ id: 'b1', col: 0, row: 0, hasActed: true }]);
    expect(validateCommand(acted, to(1, 0), 'blue')).toEqual({
      ok: false,
      reason: 'that unit has already acted',
    });
  });

  // Distinct from "already acted": the actor is allowed to be giving orders,
  // it is this particular unit they may not order.
  it("refuses one of the opponent's units", () => {
    const mixed = makeState(6, [
      { id: 'b1', col: 0, row: 0 },
      { id: 'r1', col: 5, row: 5, owner: 'red' },
    ]);
    const command: Command = {
      type: 'move',
      unitId: 'r1',
      path: route(at(5, 5), at(5, 4)),
      facing: 'north',
    };
    expect(validateCommand(mixed, command, 'blue')).toEqual({
      ok: false,
      reason: 'that unit is not yours',
    });
  });

  // A client that picks destinations from `reachable` and paths from `pathTo`
  // cannot produce these; anything that does is broken, hostile, or stale.
  it('refuses a path that jumps rather than walks', () => {
    const jump: Command = {
      type: 'move',
      unitId: 'b1',
      path: [at(0, 0), at(0, 2)],
      facing: 'north',
    };
    expect(validateCommand(state, jump, 'blue')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('jumps'),
    });
  });

  it('refuses a path that does not start where the unit is', () => {
    const elsewhere: Command = {
      type: 'move',
      unitId: 'b1',
      path: route(at(2, 2), at(2, 3)),
      facing: 'north',
    };
    expect(validateCommand(state, elsewhere, 'blue')).toEqual({
      ok: false,
      reason: 'path does not start at the unit',
    });
  });

  it('accepts a legal move and stamps the actor', () => {
    expect(accept(state, to(2, 0))).toMatchObject({ type: 'move', unitId: 'b1', actor: 'blue' });
  });

  it('accepts ending your own turn', () => {
    expect(accept(state, { type: 'endTurn' })).toMatchObject({ type: 'endTurn', actor: 'blue' });
  });

  // The runtime half of keeping Command and Action distinct: the actor is
  // stamped by the authority, so a client-supplied one cannot survive even if
  // it gets past parseCommand.
  it('overwrites an actor smuggled in on the command', () => {
    const smuggled = { ...to(2, 0), actor: 'red' } as Command;
    expect(accept(state, smuggled)).toMatchObject({ actor: 'blue' });
  });

  it('refuses an unknown command type rather than accepting it', () => {
    const bogus = { type: 'teleport' } as unknown as Command;
    expect(validateCommand(state, bogus, 'blue')).toEqual({
      ok: false,
      reason: 'unknown command type: teleport',
    });
  });

  it('does not mutate the state it was given', () => {
    const before = JSON.stringify(state);
    validateCommand(state, to(2, 0), 'blue');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('validateCommand, once the game is over', () => {
  // The same board twice, differing only in the marker: what isolates the
  // refusal as the cause rather than anything else about the position.
  const board = (winner: string | null) =>
    makeState(
      8,
      [
        { id: 'b1', col: 0, row: 0 },
        { id: 'r1', col: 0, row: 3, owner: 'red' },
      ],
      'blue',
      winner,
    );

  it('accepts what it would otherwise accept', () => {
    expect(validateCommand(board(null), to(2, 0), 'blue').ok).toBe(true);
  });

  it('refuses a move', () => {
    const result = validateCommand(board('blue'), to(2, 0), 'blue');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('the game is over');
  });

  // ⚠️ The point of putting it above the dispatch rather than in each
  // validator: `validateEndTurn` takes no arguments and cannot see the state at
  // all, so a rule written per-command would have had to change its signature
  // to refuse this one.
  it('refuses ending a turn, which is otherwise always legal', () => {
    const result = validateCommand(board('blue'), { type: 'endTurn' }, 'blue');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('the game is over');
  });

  // ⚠️ Sender identity still comes first. Over or not, a player who was never
  // entitled to give an order should hear why they were not, and a winner's
  // opponent asking for something should not be told the game is over as though
  // that were the only problem.
  it('still answers the wrong player with whose turn it is', () => {
    const result = validateCommand(board('blue'), to(2, 0), 'red');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not your turn');
  });
});

// ⚠️ The one command given off-turn, and the one ending the board did not
// decide -- a clock running out is the server giving it for whoever ran out.
describe('surrender', () => {
  const board = (winner: string | null = null) =>
    makeState(
      8,
      [
        { id: 'b1', col: 0, row: 0 },
        { id: 'r1', col: 0, row: 3, owner: 'red' },
      ],
      'blue',
      winner,
    );
  const surrender: Command = { type: 'surrender' };

  it("is accepted from either player, on anyone's turn", () => {
    expect(validateCommand(board(), surrender, 'blue').ok).toBe(true);
    expect(validateCommand(board(), surrender, 'red').ok).toBe(true);
  });

  it('is refused from someone who is not playing', () => {
    expect(validateCommand(board(), surrender, 'green')).toEqual({
      ok: false,
      reason: 'not a player in this game',
    });
  });

  it('is refused once the game is over', () => {
    expect(validateCommand(board('blue'), surrender, 'red')).toEqual({
      ok: false,
      reason: 'the game is over',
    });
  });

  it('ends the game, and whoever did not give up wins', () => {
    for (const [actor, winner] of [
      ['blue', 'red'],
      ['red', 'blue'],
    ]) {
      const events = resolveAction(board(), accept(board(), surrender, actor), NO_LUCK);
      expect(events).toEqual([{ type: 'gameEnded', winner }]);
      expect(applyEvents(board(), events).winner).toBe(winner);
    }
  });
});

describe('resolveAction', () => {
  const state = makeState(6, [
    { id: 'b1', col: 0, row: 0 },
    { id: 'r1', col: 5, row: 5, owner: 'red' },
  ]);

  it('emits one unitMoved carrying the whole path, for animation', () => {
    const [moved] = resolveAction(state, accept(state, to(2, 0)), NO_LUCK);
    expect(moved).toEqual({
      type: 'unitMoved',
      unitId: 'b1',
      // ⚠️ Asserted, not omitted. Leaving it out made this pass for any facing
      // at all -- invisible while these files were outside every program.
      facing: 'north',
      // Every step, not just the destination: the renderer walks these one
      // tween per tile.
      path: [
        { col: 0, row: 0 },
        { col: 1, row: 0 },
        { col: 2, row: 0 },
      ],
    });
  });

  it('ends the turn in the same breath, once the budget is spent', () => {
    // ⚠️ **Two events, not one carrying both effects.** Invariant 9 -- each is
    // independently applicable and absolute -- and the same shape a charge
    // takes, its battle then its displacement.
    //
    // ⚠️ The turn ends here because blue's whole roster in this fixture is one
    // unit, not because of any cap: `actionsAllowed` is the roster when it is
    // shorter than the budget, and with no cap at all it always is.
    const events = resolveAction(state, accept(state, to(2, 0)), NO_LUCK);
    expect(events.map((event) => event.type)).toEqual(['unitMoved', 'turnEnded']);
    expect(events[1]).toEqual({ type: 'turnEnded', nextPlayer: 'red' });
  });

  it('names the next player when a turn ends', () => {
    expect(resolveAction(state, accept(state, { type: 'endTurn' }), NO_LUCK)).toEqual([
      { type: 'turnEnded', nextPlayer: 'red' },
    ]);
  });

  // Turn order is array rotation over GameState.players, wrapping via modulo,
  // so it works for two players or four.
  it('wraps around the player list', () => {
    const reds = makeState(6, [{ id: 'r1', col: 0, row: 0, owner: 'red' }], 'red');
    expect(resolveAction(reds, accept(reds, { type: 'endTurn' }, 'red'), NO_LUCK)).toEqual([
      { type: 'turnEnded', nextPlayer: 'blue' },
    ]);
  });

  it('does not mutate the state it was given', () => {
    const before = JSON.stringify(state);
    resolveAction(state, accept(state, to(2, 0)), NO_LUCK);
    expect(JSON.stringify(state)).toBe(before);
  });

  // The mirror of validateCommand's exhaustive default. Types make it
  // unreachable in-process, and an Action read back out of the database is
  // JSON, where they guarantee nothing.
  it('refuses an unknown action type rather than returning nothing', () => {
    const bogus = { type: 'teleport', actor: 'blue' } as unknown as Parameters<
      typeof resolveAction
    >[1];
    expect(() => resolveAction(state, bogus, NO_LUCK)).toThrow('unknown action type: teleport');
  });
});

describe('resolveAction, when a resolution ends the game', () => {
  // A gun that kills in one shot, and a defender low enough to be killed by it.
  const shot = (unitId: string): MoveCommand => ({
    type: 'move',
    unitId,
    path: [at(0, 0)],
    facing: 'north',
    targetUnitId: 'r1',
  });

  const lastStand = (blueUnits: { id: string; col: number; row: number }[]) =>
    makeState(8, [
      ...blueUnits.map((u) => ({ ...u, unitTypeId: 'artillery' as const })),
      { id: 'r1', col: 0, row: 3, owner: 'red', health: 3 },
    ]);

  const kinds = (state: ReturnType<typeof makeState>, command: MoveCommand) =>
    resolveAction(state, accept(state, command), NO_LUCK).map((event) => event.type);

  it('emits gameEnded naming the side still standing', () => {
    const state = lastStand([{ id: 'b1', col: 0, row: 0 }]);
    const events = resolveAction(state, accept(state, shot('b1')), NO_LUCK);
    const ended = events.find((event) => event.type === 'gameEnded');
    expect(ended).toEqual({ type: 'gameEnded', winner: 'blue' });
  });

  // ⚠️ The assertion the early return exists for, and it only means something
  // because this turn *would* have ended: blue has one unit, so its budget is
  // one, so the shot spends the turn. Give blue a second unit and this passes
  // whether or not the suppression works.
  it('emits no turnEnded beside it, on a turn that would otherwise have ended', () => {
    const state = lastStand([{ id: 'b1', col: 0, row: 0 }]);
    expect(actionEndsTurn(state)).toBe(true);
    expect(kinds(state, shot('b1'))).toEqual(['unitMoved', 'battleResolved', 'gameEnded']);
  });

  // The other side of the same branch: a kill that leaves the loser something
  // on the board is an ordinary action, and the turn ends as it always did.
  it('ends the turn as usual when the kill was not the last unit', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red', health: 3 },
      { id: 'r2', col: 5, row: 5, owner: 'red' },
    ]);
    expect(kinds(state, shot('b1'))).toEqual(['unitMoved', 'battleResolved', 'turnEnded']);
  });

  // ⚠️ Fired at full health, so nothing dies: the fold has to be able to answer
  // "nobody yet" as readily as it names a winner, or every attack would end the
  // game as soon as one side was down to its last unit.
  it('says nothing when the shot was survived', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'r1', col: 0, row: 3, owner: 'red' },
    ]);
    expect(kinds(state, shot('b1'))).toEqual(['unitMoved', 'battleResolved', 'turnEnded']);
  });

  // ⚠️ An attacker killed by the counter loses the game for its own side, on its
  // own turn. Worth its own case because every other route here has the mover
  // winning, and "the sole survivor" is the only spelling that gets this right
  // without asking whose turn it was.
  it('names the defender when the counter killed the last attacker', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 2, health: 1 },
      { id: 'r1', col: 0, row: 3, owner: 'red', facing: 'south' },
    ]);
    const events = resolveAction(
      state,
      accept(state, {
        type: 'move',
        unitId: 'b1',
        path: [at(0, 2)],
        facing: 'north',
        targetUnitId: 'r1',
      }),
      NO_LUCK,
    );
    expect(events.find((event) => event.type === 'gameEnded')).toEqual({
      type: 'gameEnded',
      winner: 'red',
    });
  });

  // Ending a turn cannot end a game, so it does not ask -- and this is what
  // would notice if the check were ever hoisted out of the move branch without
  // a condition that could trigger on an empty action.
  it('leaves endTurn alone', () => {
    const state = lastStand([{ id: 'b1', col: 0, row: 0 }]);
    expect(resolveAction(state, accept(state, { type: 'endTurn' }), NO_LUCK)).toEqual([
      { type: 'turnEnded', nextPlayer: 'red' },
    ]);
  });
});

describe('resolveAction, with generals on the board', () => {
  // A blue gun at (0,0) and red's general within its reach, beside a wounded
  // red infantryman.
  const field = (generalHealth: number, woundedHealth: number) =>
    makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'rg', col: 0, row: 3, owner: 'red', unitTypeId: 'general', health: generalHealth },
      { id: 'r1', col: 1, row: 3, owner: 'red', health: woundedHealth },
      // Out of the gun's reach, so red keeps an army whatever happens to r1.
      { id: 'r2', col: 7, row: 7, owner: 'red' },
    ]);
  const fire = (targetUnitId: string): MoveCommand => ({
    type: 'move',
    unitId: 'b1',
    path: [at(0, 0)],
    facing: 'north',
    targetUnitId,
  });

  it('ends the match when the last soldier falls, though the general stands', () => {
    const state = makeState(8, [
      { id: 'b1', col: 0, row: 0, unitTypeId: 'artillery' },
      { id: 'rg', col: 0, row: 3, owner: 'red', unitTypeId: 'general' },
      { id: 'r1', col: 1, row: 3, owner: 'red', health: 3 },
    ]);
    const events = resolveAction(state, accept(state, fire('r1')), NO_LUCK);
    expect(events.at(-1)).toEqual({ type: 'gameEnded', winner: 'blue' });
  });

  it('ends the match when a general falls, though its army still stands', () => {
    const state = field(3, 50);
    const events = resolveAction(state, accept(state, fire('rg')), NO_LUCK);
    expect(events.at(-1)).toEqual({ type: 'gameEnded', winner: 'blue' });
  });

  // ⚠️ The heal reads the board the turn ends on: blue's last shot kills r1,
  // so r1 must not be healed -- the pre-action state still has it beside its
  // general, wounded.
  it("does not heal a unit the turn's last action killed", () => {
    const state = field(100, 3);
    const events = resolveAction(state, accept(state, fire('r1')), NO_LUCK);
    expect(events.map((e) => e.type)).toEqual(['unitMoved', 'battleResolved', 'turnEnded']);
  });

  it('heals the incoming side once the turn passes', () => {
    const state = field(100, 50);
    const events = resolveAction(state, accept(state, { type: 'endTurn' }), NO_LUCK);
    expect(events).toEqual([
      { type: 'turnEnded', nextPlayer: 'red' },
      { type: 'unitsHealed', units: [{ unitId: 'r1', health: 50 + GENERAL_HEALING }] },
    ]);
  });
});
