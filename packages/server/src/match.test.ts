import { beforeEach, describe, expect, it } from 'bun:test';
import { fullMeter, route } from '@wargame/shared/testing';
import type { Command, Coordinate, MatchSummary } from '@wargame/shared';
import { exploreMovement, facingToward, getUnitType, LUCK_MAX } from '@wargame/shared';
import { createDb, migrate } from './db';
import type { Database } from './db';
import type { GuestId } from './guest';
import { COMMANDS_PER_MATCH, createMatchStore, MOVED } from './match';
import type { MatchStore } from './match';
import { getMap } from './maps';
import { createMatchState, PLAYERS } from './matchState';

// Each test gets its own in-memory database: real queries, real migrations, no
// files to clean up, and no way for one test to see another's rows.
let database: Database;
let store: MatchStore;
// The raw driver, for assertions that deliberately bypass the store and read
// what actually landed in the tables.
let sql: Database['db']['$client'];

const GUEST = 'guest' as GuestId;
const JOINER = 'joiner' as GuestId;

beforeEach(async () => {
  database = await createDb(':memory:');
  await migrate(database);
  store = createMatchStore(database, GUEST);
  sql = database.db.$client;
});

// A walkable route, not two endpoints -- validatePath walks every step in 6c,
// so an endpoint pair describes a move no client can make.
const move = (unitId: string, to: [number, number], from: [number, number]): Command => ({
  type: 'move',
  facing: 'north',
  unitId,
  path: route({ col: from[0], row: from[1] }, { col: to[0], row: to[1] }),
});

/**
/**
 * A unit that can legally step one tile toward the enemy, and where that step
 * lands -- asked of the rulebook rather than assumed.
 *
 * ⚠️ **Hardcoding this has now broken three times**: once when the army left
 * the maps, once when the boards were resized, and once when a formation grew
 * a second rank and put a friend on the square the back rank would have walked
 * into. Which unit sits on the end, and whether anything stands behind it, are
 * both properties of a dial that becomes a player's choice -- so the only
 * durable question is *who can move one tile forward*, and `exploreMovement` is
 * what answers it.
 *
 * ⚠️ One tile rather than a unit's whole range, deliberately: these are tests
 * about the store, and a route costing more than a gun carriage has would be a
 * movement test failing in the wrong file.
 */
const stepper = (owner: string, forward: 1 | -1) => {
  const state = createMatchState(getMap('classic'));
  for (const unit of state.units) {
    if (unit.owner !== owner) continue;
    const { movementRange, movementType } = getUnitType(unit.unitTypeId);
    const { reachable } = exploreMovement(state, unit, movementRange, movementType);
    const to: Coordinate = { col: unit.position.col, row: unit.position.row + forward };
    if (!reachable.some((tile) => tile.col === to.col && tile.row === to.row)) continue;
    return {
      id: unit.id,
      from: [unit.position.col, unit.position.row] as [number, number],
      to: [to.col, to.row] as [number, number],
    };
  }
  throw new Error(`no ${owner} unit can step one tile forward on the starting board`);
};

// A submit's answer as the rules gave it -- neither missing nor lost to a race.
const ruled = (result: Awaited<ReturnType<MatchStore['submit']>>) => {
  if (result === null || result === MOVED) throw new Error(`expected the rules' answer: ${result}`);
  return result;
};

// The waiting game `joiner` has joined, as the joiner sees it.
const joined = async (waiting: MatchSummary, joiner: MatchStore, name?: string) => {
  const result = await joiner.join(waiting.code!, name);
  if (!result?.ok) throw new Error(`expected to join: ${JSON.stringify(result)}`);
  return result.match;
};

// What landed in the tables, read past the store.
const seatsOf = async (matchId: string) =>
  (
    await sql.execute({
      sql: 'SELECT number, occupant, color FROM seats WHERE match_id = ? ORDER BY number',
      args: [matchId],
    })
  ).rows.map(({ number, occupant, color }) => ({ number, occupant, color }));
const users = async () =>
  (await sql.execute('SELECT id, name FROM users')).rows.map(({ id, name }) => ({ id, name }));

// Seat 1 and seat 2, read rather than written out: they are the list's to name.
const [BLUE, RED] = PLAYERS.map((player) => player.id);
const BLUE_MOVER = stepper(BLUE, 1);
const RED_MOVER = stepper(RED, -1);

describe('create', () => {
  it('returns a summary at seq 0 with the starting player', async () => {
    const match = await store.create();
    expect(match.seq).toBe(0);
    expect(match.currentTurn).toBe(BLUE);
    expect(match.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(match.createdAt).toBeGreaterThan(0);
  });

  it('starts with no winner, in the summary and in the column', async () => {
    const match = await store.create();
    expect(match.winner).toBeNull();
    const { rows } = await sql.execute({
      sql: 'SELECT winner FROM matches WHERE id = ?',
      args: [match.id],
    });
    expect(rows[0].winner).toBeNull();
  });

  it('gives each match its own id', async () => {
    const [a, b] = [await store.create(), await store.create()];
    expect(a.id).not.toBe(b.id);
  });

  it('writes initial_state and current_state identically to begin with', async () => {
    const { id } = await store.create();
    const { rows } = await sql.execute({
      sql: 'SELECT initial_state, current_state FROM matches WHERE id = ?',
      args: [id],
    });
    expect(rows[0].initial_state).toEqual(rows[0].current_state);
  });
});

describe('list', () => {
  it('is empty to begin with', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('returns newest first', async () => {
    const a = await store.create();
    // Two creates land in the same millisecond, and `created_at` is the only
    // thing the order is defined on -- so without this the timestamps are
    // equal, ties break arbitrarily, and asserting an order asserts nothing.
    // Ordering among matches created in the same millisecond is unspecified
    // and does not matter; ordering between different ones does.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const b = await store.create();

    expect(b.createdAt).toBeGreaterThan(a.createdAt);
    expect((await store.list()).map((match) => match.id)).toEqual([b.id, a.id]);
  });

  // current_turn is denormalised precisely so this does not parse a board.
  it('reflects whose turn it is without loading the game', async () => {
    const { id } = await store.create();
    await store.submit(id, { type: 'endTurn' });
    const [summary] = await store.list();
    expect(summary.currentTurn).toBe(RED);
    expect(summary.seq).toBe(1);
  });
});

describe('another guest', () => {
  let theirs: string;
  let other: MatchStore;

  beforeEach(async () => {
    theirs = (await store.create()).id;
    other = createMatchStore(database, 'another' as GuestId);
  });

  it('does not see the match in their list', async () => {
    await other.create();
    expect((await other.list()).map((match) => match.id)).not.toContain(theirs);
    expect((await store.list()).map((match) => match.id)).toEqual([theirs]);
  });

  it('finds no match by its id, as though it did not exist', async () => {
    expect(await other.snapshot(theirs)).toBeNull();
    expect(await other.since(theirs, 0)).toBeNull();
    expect(await other.submit(theirs, { type: 'endTurn' })).toBeNull();
    expect((await store.snapshot(theirs))?.seq).toBe(0);
  });
});

describe('seats', () => {
  it("seats the creator in every seat of a hot-seat game, each its player's colour", async () => {
    const { id } = await store.create();
    const { state } = (await store.snapshot(id))!;
    expect(await seatsOf(id)).toEqual(
      state.players.map((player, index) => ({
        number: index + 1,
        occupant: GUEST,
        color: player.color,
      })),
    );
  });

  // ⚠️ Never when minted: minting is unlimited, creating is not.
  it('makes a guest a user the first time it creates a game, and only then', async () => {
    expect(await users()).toEqual([]);
    await store.create();
    await store.create();
    const [user, ...more] = await users();
    expect(more).toEqual([]);
    expect(user.id).toBe(GUEST);
    expect(String(user.name).length).toBeGreaterThan(0);
  });

  // ⚠️ One rule for every mode: act as the player whose turn it is if you hold
  // that seat, otherwise as your own -- where only a surrender is accepted.
  describe('shared by two guests', () => {
    let id: string;
    let other: MatchStore;

    beforeEach(async () => {
      other = createMatchStore(database, 'another' as GuestId);
      id = (await joined(await store.create({ mode: 'remote' }), other)).id;
    });

    it('lets each reach the match and list it', async () => {
      expect((await other.snapshot(id))?.seq).toBe(0);
      expect((await other.list()).map((match) => match.id)).toEqual([id]);
    });

    it('lets each act only on its own turn', async () => {
      expect(ruled(await other.submit(id, { type: 'endTurn' })).ok).toBe(false);
      expect(ruled(await store.submit(id, { type: 'endTurn' })).ok).toBe(true);
      expect(ruled(await store.submit(id, { type: 'endTurn' })).ok).toBe(false);
      expect(ruled(await other.submit(id, { type: 'endTurn' })).ok).toBe(true);
    });

    it("lets either surrender on the other's turn, for its own side", async () => {
      const result = ruled(await other.submit(id, { type: 'surrender' }));
      expect(result.ok && result.state.winner).toBe(BLUE);
    });
  });
});

describe('a remote game', () => {
  it('waits under a code, in the seat its creator chose', async () => {
    const match = await store.create({ mode: 'remote', seat: 2 });
    expect(match.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(match).toMatchObject({ opponent: null, yourTurn: false });
    expect(await seatsOf(match.id)).toEqual([
      expect.objectContaining({ number: 1, occupant: null }),
      expect.objectContaining({ number: 2, occupant: GUEST }),
    ]);
    expect(await store.snapshot(match.id)).toMatchObject({ you: [2], code: match.code });
    expect(await store.since(match.id, 0)).toMatchObject({ code: match.code });
  });

  // Its state is built at creation; without this the creator plays alone.
  it('takes no commands while it waits, a surrender included', async () => {
    const { id } = await store.create({ mode: 'remote' });
    expect(ruled(await store.submit(id, { type: 'endTurn' })).ok).toBe(false);
    expect(ruled(await store.submit(id, { type: 'surrender' })).ok).toBe(false);
    expect((await store.snapshot(id))?.seq).toBe(0);
  });

  it('draws again for a code a waiting game already has', async () => {
    const draws = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    const drawing = createMatchStore(database, GUEST, { drawCode: () => draws.shift()! });
    expect((await drawing.create({ mode: 'remote' })).code).toBe('AAAAAA');
    expect((await drawing.create({ mode: 'remote' })).code).toBe('BBBBBB');
  });
});

describe('joining', () => {
  let joiner: MatchStore;
  let waiting: MatchSummary;

  beforeEach(async () => {
    joiner = createMatchStore(database, JOINER);
    waiting = await store.create({ mode: 'remote', name: 'Creator' });
  });

  it('fills the empty seat, drops the code, and starts the game for both', async () => {
    const match = await joined(waiting, joiner, 'Joiner');
    expect(match).toMatchObject({ code: null, opponent: 'Creator', yourTurn: false });
    expect(await seatsOf(waiting.id)).toEqual([
      expect.objectContaining({ number: 1, occupant: GUEST }),
      expect.objectContaining({ number: 2, occupant: JOINER }),
    ]);
    expect(await joiner.snapshot(waiting.id)).toMatchObject({ you: [2], code: null });
    // ⚠️ How the creator learns of it: a join moves no seq.
    expect(await store.since(waiting.id, 0)).toEqual({ seq: 0, events: [], code: null });
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: waiting.id, opponent: 'Joiner', yourTurn: true }),
    ]);
    expect(ruled(await store.submit(waiting.id, { type: 'endTurn' })).ok).toBe(true);
  });

  it('makes the joiner a user, under the name it sent', async () => {
    await joined(waiting, joiner, 'Joiner');
    expect(await users()).toContainEqual(expect.objectContaining({ id: JOINER, name: 'Joiner' }));
  });

  it("refuses the creator's own game, rather than making it hot-seat", async () => {
    const result = await store.join(waiting.code!);
    expect(result?.ok).toBe(false);
    expect(await seatsOf(waiting.id)).toContainEqual(expect.objectContaining({ occupant: null }));
  });

  it('finds nothing under a code once its game has started, or was cancelled', async () => {
    await joined(waiting, joiner);
    expect(await createMatchStore(database, 'late' as GuestId).join(waiting.code!)).toBeNull();

    const cancelled = await store.create({ mode: 'remote' });
    await store.cancel(cancelled.id);
    expect(await joiner.join(cancelled.code!)).toBeNull();
  });

  // Another join took the seat between this one's read and its write -- put
  // here directly, with the code left in place, since two real joins
  // interleave by luck.
  it('loses a race cleanly, changing nothing', async () => {
    await sql.execute({
      sql: "UPDATE seats SET occupant = 'rival' WHERE match_id = ? AND number = 2",
      args: [waiting.id],
    });
    const result = await joiner.join(waiting.code!, 'Joiner');
    expect(result?.ok).toBe(false);
    expect(await seatsOf(waiting.id)).toContainEqual(
      expect.objectContaining({ number: 2, occupant: 'rival' }),
    );
    expect((await store.snapshot(waiting.id))?.code).toBe(waiting.code);
    expect(await users()).not.toContainEqual(expect.objectContaining({ id: JOINER }));
  });
});

describe('cancelling', () => {
  it('archives a waiting game, which leaves the list', async () => {
    const { id } = await store.create({ mode: 'remote' });
    expect(await store.cancel(id)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.snapshot(id)).toBeNull();
  });

  it('refuses a game that has started, hot-seat included', async () => {
    const remote = await joined(
      await store.create({ mode: 'remote' }),
      createMatchStore(database, JOINER),
    );
    expect(await store.cancel(remote.id)).toBe(false);
    expect(await store.cancel((await store.create()).id)).toBe(false);
  });

  it('is only for the one waiting in it', async () => {
    const { id } = await store.create({ mode: 'remote' });
    expect(await createMatchStore(database, JOINER).cancel(id)).toBeNull();
    expect((await store.snapshot(id))?.code).not.toBeNull();
  });
});

describe('names', () => {
  it('keeps the name a guest sends until it sends another', async () => {
    await store.create({ name: 'Ada' });
    await store.create();
    expect(await store.name()).toBe('Ada');
    await store.create({ name: 'Grace' });
    expect(await store.name()).toBe('Grace');
  });

  it('suggests one to a guest with none, and writes nothing', async () => {
    expect(await store.name()).not.toBe('');
    expect(await users()).toEqual([]);
  });
});

describe('the clock', () => {
  const FIVE_MINUTES = 5 * 60_000;
  let at: number;
  let timed: MatchStore;
  beforeEach(() => {
    at = 1_000_000;
    timed = createMatchStore(database, GUEST, { now: () => at });
  });

  const deadlineOf = async (id: string) =>
    (await sql.execute({ sql: 'SELECT deadline FROM matches WHERE id = ?', args: [id] })).rows[0]
      .deadline;
  const remainingOf = async (id: string) =>
    (
      await sql.execute({
        sql: 'SELECT clock_remaining_ms FROM seats WHERE match_id = ? ORDER BY number',
        args: [id],
      })
    ).rows.map((row) => row.clock_remaining_ms);
  const endedBy = async (id: string) =>
    (await sql.execute({ sql: 'SELECT ended_by FROM matches WHERE id = ?', args: [id] })).rows[0]
      .ended_by;

  it("starts a hot-seat game's clock at creation, and counts only the mover's down", async () => {
    const { id } = await timed.create({ clock: 5 });
    expect(await deadlineOf(id)).toBe(at + FIVE_MINUTES);
    at += 60_000;
    expect((await timed.snapshot(id))?.clocks).toEqual([FIVE_MINUTES - 60_000, FIVE_MINUTES]);
  });

  it('keeps what the mover had left at the end of its turn, and starts the next', async () => {
    const { id } = await timed.create({ clock: 5 });
    at += 90_000;
    const result = ruled(await timed.submit(id, { type: 'endTurn' }));
    expect(result.ok && result.clocks).toEqual([FIVE_MINUTES - 90_000, FIVE_MINUTES]);
    expect(await remainingOf(id)).toEqual([FIVE_MINUTES - 90_000, FIVE_MINUTES]);
    expect(await deadlineOf(id)).toBe(at + FIVE_MINUTES);

    at += 30_000;
    ruled(await timed.submit(id, { type: 'endTurn' }));
    expect(await remainingOf(id)).toEqual([FIVE_MINUTES - 90_000, FIVE_MINUTES - 30_000]);
    expect(await deadlineOf(id)).toBe(at + FIVE_MINUTES - 90_000);
  });

  // ⚠️ Whether a move ends the turn is the turn budget's to say, so this holds
  // the clock to the turn rather than to an assumption about the budget.
  it('moves only when the turn changes, never within one', async () => {
    const { id } = await timed.create({ clock: 5 });
    const before = await deadlineOf(id);
    at += 10_000;
    const result = ruled(
      await timed.submit(id, move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from)),
    );
    if (!result.ok) throw new Error(result.reason);
    const turned = result.state.currentTurn !== BLUE;
    expect((await deadlineOf(id)) !== before).toBe(turned);
    expect((await remainingOf(id))[0] !== FIVE_MINUTES).toBe(turned);
  });

  it('waits for the join to start a remote game, and counts nothing before', async () => {
    const waiting = await timed.create({ mode: 'remote', clock: 5 });
    expect(await deadlineOf(waiting.id)).toBeNull();
    at += 10 * 60_000;
    expect((await timed.snapshot(waiting.id))?.clocks).toEqual([FIVE_MINUTES, FIVE_MINUTES]);

    await joined(waiting, createMatchStore(database, JOINER, { now: () => at }));
    expect(await deadlineOf(waiting.id)).toBe(at + FIVE_MINUTES);
  });

  it('starts none for a join that loses its race', async () => {
    const waiting = await timed.create({ mode: 'remote', clock: 5 });
    await sql.execute({
      sql: "UPDATE seats SET occupant = 'rival' WHERE match_id = ? AND number = 2",
      args: [waiting.id],
    });
    await createMatchStore(database, JOINER, { now: () => at }).join(waiting.code!);
    expect(await deadlineOf(waiting.id)).toBeNull();
  });

  // ⚠️ Nothing runs between requests: the first one to look resolves it.
  it("settles a clock that ran out on the next look, as the mover's surrender", async () => {
    const { id } = await timed.create({ clock: 5 });
    at += FIVE_MINUTES;
    const answer = await timed.since(id, 0);
    expect(answer?.events).toContainEqual({ type: 'gameEnded', winner: RED });
    expect(answer?.state?.winner).toBe(RED);
    expect(answer?.clocks).toEqual([0, FIVE_MINUTES]);
    expect(await endedBy(id)).toBe('clock');
    expect(await deadlineOf(id)).toBeNull();
    const { rows } = await sql.execute({
      sql: 'SELECT actor, action FROM resolutions WHERE match_id = ?',
      args: [id],
    });
    expect(rows.map((row) => [row.actor, JSON.parse(String(row.action)).type])).toEqual([
      [BLUE, 'surrender'],
    ]);
  });

  it('lets a command that arrives after the deadline find the game already lost', async () => {
    const { id } = await timed.create({ clock: 5 });
    at += FIVE_MINUTES + 1;
    expect(ruled(await timed.submit(id, { type: 'endTurn' }))).toEqual({
      ok: false,
      reason: 'the game is over',
    });
    expect((await timed.snapshot(id))?.state.winner).toBe(RED);
  });

  // Both players poll; whichever writes second reads what the first wrote.
  it('settles once when two looks race for it', async () => {
    const { id } = await timed.create({ clock: 5 });
    at += FIVE_MINUTES;
    const other = createMatchStore(database, GUEST, { now: () => at });
    const answers = await Promise.all([timed.since(id, 0), other.since(id, 0)]);
    for (const answer of answers) expect(answer?.state?.winner).toBe(RED);
    const { rows } = await sql.execute({
      sql: 'SELECT COUNT(*) n FROM resolutions WHERE match_id = ?',
      args: [id],
    });
    expect(rows[0].n).toBe(1);
  });

  it("shows a run-out clock as nobody's turn in the list, writing nothing", async () => {
    const { id } = await timed.create({ clock: 5 });
    at += FIVE_MINUTES;
    expect(await timed.list()).toEqual([expect.objectContaining({ id, yourTurn: false })]);
    expect(await deadlineOf(id)).not.toBeNull();
  });

  it('leaves a game with no clock waiting for as long as it takes', async () => {
    const { id } = await timed.create();
    at += 365 * 24 * 60 * 60_000;
    expect(await timed.since(id, 0)).toEqual({ seq: 0, events: [], code: null });
    expect((await timed.snapshot(id))?.clocks).toBeNull();
  });
});

describe('how a game ended', () => {
  it('is a surrender when one is given, and nothing before the game is over', async () => {
    const { id } = await store.create();
    ruled(await store.submit(id, { type: 'endTurn' }));
    const endedBy = async () =>
      (await sql.execute({ sql: 'SELECT ended_by FROM matches WHERE id = ?', args: [id] })).rows[0]
        .ended_by;
    expect(await endedBy()).toBeNull();
    ruled(await store.submit(id, { type: 'surrender' }));
    expect(await endedBy()).toBe('surrender');
    expect((await store.snapshot(id))?.endedBy).toBe('surrender');
  });
});

describe('a write that loses a race', () => {
  // Another write claimed the next seq between this one's read and its write
  // -- put here directly, since two real requests interleave by luck.
  it('answers MOVED, and lands nothing', async () => {
    const { id } = await store.create();
    await sql.execute({
      sql: "INSERT INTO resolutions (match_id, seq, actor, action, events, created_at) VALUES (?, 1, ?, '{}', '[]', 0)",
      args: [id, BLUE],
    });

    expect(await store.submit(id, { type: 'endTurn' })).toBe(MOVED);
    expect((await store.snapshot(id))?.seq).toBe(0);
  });
});

describe('the cap on commands', () => {
  // Put at the cap's edge directly: a thousand real commands would only be a
  // slower way to set one column.
  it('takes the last command it allows, then refuses and writes nothing', async () => {
    const { id } = await store.create();
    await sql.execute({
      sql: 'UPDATE matches SET current_seq = ? WHERE id = ?',
      args: [COMMANDS_PER_MATCH - 1, id],
    });

    expect(ruled(await store.submit(id, { type: 'endTurn' }))?.ok).toBe(true);
    // Legal by the rules -- it is red's turn now -- so only the cap refuses it.
    expect(ruled(await store.submit(id, { type: 'endTurn' }))?.ok).toBe(false);
    expect((await store.snapshot(id))?.seq).toBe(COMMANDS_PER_MATCH);
  });

  // ⚠️ Or a game that used every command could never be ended, and would sit
  // among its players' unfinished games for good.
  it('still takes a surrender, which ends the game', async () => {
    const { id } = await store.create();
    await sql.execute({
      sql: 'UPDATE matches SET current_seq = ? WHERE id = ?',
      args: [COMMANDS_PER_MATCH, id],
    });

    const result = ruled(await store.submit(id, { type: 'surrender' }));
    expect(result.ok && result.state.winner).toBe(RED);
    expect(await store.unfinished()).toBe(0);
  });
});

describe('archive', () => {
  it('takes a match off the list and out of the unfinished count', async () => {
    const kept = await store.create();
    const { id } = await store.create();
    expect(await store.unfinished()).toBe(2);

    expect(await store.archive(id)).toBe(true);
    expect((await store.list()).map((match) => match.id)).toEqual([kept.id]);
    expect(await store.unfinished()).toBe(1);
  });

  // Final: there is no unarchive, so an archived match is answered the way a
  // missing one is, commands included.
  it('leaves the match missing to its players too', async () => {
    const { id } = await store.create();
    await store.archive(id);
    expect(await store.snapshot(id)).toBeNull();
    expect(await store.since(id, 0)).toBeNull();
    expect(await store.submit(id, { type: 'endTurn' })).toBeNull();
    expect(await store.archive(id)).toBe(false);
  });

  // A soft delete: the game is tuning evidence, so the row and its log stay.
  it('keeps the row and its log', async () => {
    const { id } = await store.create();
    await store.submit(id, { type: 'endTurn' });
    await store.archive(id);
    const { rows } = await sql.execute({
      sql: 'SELECT archived_at, (SELECT COUNT(*) FROM resolutions WHERE match_id = ?) logged FROM matches WHERE id = ?',
      args: [id, id],
    });
    expect(rows[0].archived_at).toBeGreaterThan(0);
    expect(rows[0].logged).toBe(1);
  });

  it('archives nothing that is not there, or is not yours', async () => {
    const { id } = await store.create();
    expect(await store.archive('nope')).toBe(false);
    expect(await createMatchStore(database, 'another' as GuestId).archive(id)).toBe(false);
    expect((await store.snapshot(id))?.seq).toBe(0);
  });
});

describe('snapshot', () => {
  it('returns the state and its seq', async () => {
    const { id } = await store.create();
    const snap = await store.snapshot(id);
    expect(snap?.seq).toBe(0);
    expect(snap).toMatchObject({ you: [1, 2], code: null });
    expect(snap?.state.currentTurn).toBe(BLUE);
    // Not a unit count -- that changes whenever the starting roster is tuned,
    // and says nothing about whether snapshot returns the board.
    expect(snap?.state.units.some((unit) => unit.owner === BLUE)).toBe(true);
    expect(snap?.state.units.some((unit) => unit.owner === RED)).toBe(true);
  });

  it('is null for a match that does not exist', async () => {
    expect(await store.snapshot('nope')).toBeNull();
  });
});

describe('since', () => {
  // ⚠️ The common case at poll interval, and the board is what it skips --
  // so a board that would not even parse is no obstacle to it.
  it('answers a caught-up poll without reading the board', async () => {
    const { id } = await store.create();
    await sql.execute({
      sql: "UPDATE matches SET current_state = 'not a board' WHERE id = ?",
      args: [id],
    });
    expect(await store.since(id, 0)).toEqual({ seq: 0, events: [], code: null });
  });

  // ⚠️ **Whose turn it is after the move is `ACTIONS_PER_TURN`'s business, not
  // this test's** -- at a budget of one the move ends the turn by itself, and at
  // no cap it does not. So the second command is addressed to whoever is
  // actually up. This test is about the cursor and the state riding along with
  // the events; asserting a turn rule here would only make it break when the
  // game is tuned.
  it('returns everything after the cursor, with the current state', async () => {
    const { id } = await store.create();
    await store.submit(id, move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from));
    const mid = await store.snapshot(id);
    await store.submit(id, { type: 'endTurn' });

    const all = await store.since(id, 0);
    expect(all?.seq).toBe(2);
    expect(all?.events[0].type).toBe('unitMoved');
    expect(all?.events.at(-1)?.type).toBe('turnEnded');
    // The state travels with the events and is the one they produced: an
    // explicit endTurn always hands play to somebody else.
    expect(all?.state?.currentTurn).not.toBe(mid!.state.currentTurn);
  });

  it('returns nothing new when the caller is already current', async () => {
    const { id } = await store.create();
    await store.submit(id, { type: 'endTurn' });
    const caught = await store.since(id, 1);
    expect(caught?.seq).toBe(1);
    expect(caught?.events).toEqual([]);
    // And no board: the caller already holds this state, so sending it again
    // is a full grid parsed and thrown away on every idle poll.
    expect(caught?.state).toBeUndefined();
  });

  it('is null for a match that does not exist', async () => {
    expect(await store.since('nope', 0)).toBeNull();
  });
});

describe('submit', () => {
  it('advances seq and returns the resulting state', async () => {
    const { id } = await store.create();
    const result = ruled(
      await store.submit(id, move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from)),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seq).toBe(1);
    // The move landed. Whether a `turnEnded` follows it is the turn budget's
    // business -- see `ACTIONS_PER_TURN` -- and not what this test is about.
    expect(result.events[0].type).toBe('unitMoved');
    expect(result.state.units.find((u) => u.id === BLUE_MOVER.id)?.position).toEqual({
      col: BLUE_MOVER.to[0],
      row: BLUE_MOVER.to[1],
    });
  });

  it('refuses a command the rulebook rejects, and writes nothing', async () => {
    const { id } = await store.create();
    const result = ruled(
      await store.submit(id, move(BLUE_MOVER.id, RED_MOVER.from, BLUE_MOVER.from)),
    );
    // The refusal, not its wording: the reason belongs to shared/'s rulebook
    // and changes when the rules get more specific, which says nothing about
    // whether the store wrote anything.
    expect(result.ok).toBe(false);
    // seq did not move, and no row was logged
    expect((await store.snapshot(id))?.seq).toBe(0);
    expect((await store.since(id, 0))?.events).toEqual([]);
  });

  // null, not a rejection: `ok: false` is reserved for a well-formed command
  // the rules refused, which is what lets http.ts map the two to 404 and 422.
  it('returns null for a match that does not exist', async () => {
    expect(await store.submit('nope', { type: 'endTurn' })).toBeNull();
  });

  // Stored on the row; never sent to either player.
  describe('the rolls', () => {
    const attack = async (attackKind: 'attack' | 'charge') => {
      const { id } = await store.create();
      const base = createMatchState(
        getMap('classic'),
        [
          { player: PLAYERS[0], army: ['c'] },
          { player: PLAYERS[1], army: ['i'] },
        ],
        { width: 1, depth: 1 },
      );
      // A full meter and a worn-down target, so a charge is legal and certain;
      // an attack ignores both.
      const blue = {
        ...base.units.find((u) => u.owner === BLUE)!,
        position: { col: 5, row: 0 },
        chargeMeter: fullMeter('cavalry'),
      };
      const red = {
        ...base.units.find((u) => u.owner === RED)!,
        position: { col: 5, row: 1 },
        health: 5,
      };
      const fight = { ...base, units: [blue, red] };
      await sql.execute({
        sql: 'UPDATE matches SET initial_state = ?, current_state = ? WHERE id = ?',
        args: [JSON.stringify(fight), JSON.stringify(fight), id],
      });
      const command: Command = {
        type: 'move',
        unitId: blue.id,
        path: [blue.position],
        facing: facingToward(blue.position, red.position, blue.facing),
        targetUnitId: red.id,
        attackKind,
      };
      const result = ruled(await store.submit(id, command));
      expect(result.ok).toBe(true);
      expect(result.ok && result.events.map((e) => e.type)).toContain('battleResolved');
      const { rows } = await sql.execute({
        sql: 'SELECT rolls FROM resolutions WHERE match_id = ?',
        args: [id],
      });
      const sent = JSON.stringify([result, await store.since(id, 0)]);
      return { rolls: JSON.parse(rows[0].rolls as string), sent };
    };
    const leaked = /"(attack|counter|charge|rolls)":/;

    // ⚠️ The same three for either kind, whichever it reads: the number of
    // draws never depends on what the rules will do with them.
    for (const kind of ['attack', 'charge'] as const) {
      it(`keeps the rolls ${kind === 'attack' ? 'an attack' : 'a charge'} was handed`, async () => {
        const { rolls, sent } = await attack(kind);
        expect(Object.keys(rolls).sort()).toEqual(['attack', 'charge', 'counter']);
        for (const roll of [rolls.attack, rolls.counter]) {
          expect(roll).toBeGreaterThanOrEqual(0);
          expect(roll).toBeLessThanOrEqual(LUCK_MAX);
        }
        expect(rolls.charge).toBeGreaterThanOrEqual(0);
        expect(rolls.charge).toBeLessThanOrEqual(99);
        expect(sent).not.toMatch(leaked);
      });
    }
  });

  it('stamps the actor whose turn it is, ignoring any the client supplied', async () => {
    const { id } = await store.create();
    // Deliberately malformed: a client cannot construct this, which is the
    // point -- `actor` exists only on Action. Cast through unknown to build it.
    const smuggled = {
      ...move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from),
      actor: RED,
    } as unknown as Command;
    expect(ruled(await store.submit(id, smuggled))?.ok).toBe(true);
    const { rows } = await sql.execute({
      sql: 'SELECT actor, action FROM resolutions WHERE match_id = ?',
      args: [id],
    });
    expect(rows[0].actor).toBe(BLUE);
    expect(JSON.parse(rows[0].action as string).actor).toBe(BLUE);
  });
});

describe('storage guarantees', () => {
  // An impossible-today condition -- the client's in-flight guard prevents it --
  // and impossible conditions should be loud rather than silently overwrite.
  it('refuses two resolutions claiming the same seq', async () => {
    const { id } = await store.create();
    await store.submit(id, move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from));
    const duplicate = sql.execute({
      sql: `INSERT INTO resolutions (match_id, seq, actor, action, events, created_at)
            VALUES (?, 1, ?, '{}', '[]', 0)`,
      args: [id, BLUE],
    });
    await expect(duplicate).rejects.toThrow(/UNIQUE|PRIMARY|constraint/i);
  });

  it('cascades resolutions away when a match is deleted', async () => {
    const { id } = await store.create();
    await store.submit(id, { type: 'endTurn' });
    await sql.execute({ sql: 'DELETE FROM matches WHERE id = ?', args: [id] });
    const { rows } = await sql.execute('SELECT COUNT(*) c FROM resolutions');
    expect(Number(rows[0].c)).toBe(0);
  });

  /**
   * submit guards its UPDATE with `WHERE current_seq = <the seq it read>`, and
   * throws if that matched nothing. The throw itself cannot be reached from
   * the public API -- verified by trying: twenty interleave attempts, moving
   * the row between submit's read and its write, fired it zero times, because
   * libSQL serialises on one connection so the update always queues behind the
   * batch. The log's primary key would violate first in any case.
   *
   * So this covers the mechanism the guard rests on rather than the branch:
   * that a stale `current_seq` in the WHERE really does match nothing. Without
   * it the guard would be three lines nothing has ever exercised.
   */
  it('refuses to overwrite a match row whose seq has moved', async () => {
    const { id } = await store.create();
    await store.submit(id, { type: 'endTurn' });

    const stale = await sql.execute({
      sql: 'UPDATE matches SET current_seq = 99 WHERE id = ? AND current_seq = ?',
      args: [id, 0], // 0 was the seq before that submit -- now out of date
    });
    expect(stale.rowsAffected).toBe(0);

    const current = await sql.execute({
      sql: 'UPDATE matches SET current_seq = 99 WHERE id = ? AND current_seq = ?',
      args: [id, 1],
    });
    expect(current.rowsAffected).toBe(1);
  });

  it('keeps current_state equal to folding the log from initial_state', async () => {
    const { id } = await store.create();
    await store.submit(id, move(BLUE_MOVER.id, BLUE_MOVER.to, BLUE_MOVER.from));
    await store.submit(id, { type: 'endTurn' });
    await store.submit(id, move(RED_MOVER.id, RED_MOVER.to, RED_MOVER.from));

    const { applyEvents } = await import('@wargame/shared');
    const { rows } = await sql.execute({
      sql: 'SELECT initial_state, current_state FROM matches WHERE id = ?',
      args: [id],
    });
    const log = await store.since(id, 0);
    const folded = applyEvents(JSON.parse(rows[0].initial_state as string), log!.events);
    expect(folded).toEqual(JSON.parse(rows[0].current_state as string));
  });

  // ⚠️ The same invariant across the event type that is hardest to reach. Three
  // ordinary moves above never produce a `gameEnded`, so the newest member of
  // the union was in no log this claim folded -- and this claim is the one the
  // whole event design rests on.
  //
  // ⚠️ **Both states are rewritten, not just `current_state`.** Surgery on the
  // checkpoint alone desyncs it from the anchor, and folding from an anchor that
  // never held this position would fail for that reason rather than for
  // anything about `gameEnded`. Rewriting the pair keeps them a matched
  // beginning, which is what makes the fold meaningful.
  it('still holds when the log ends in a gameEnded', async () => {
    const { id } = await store.create();
    // ⚠️ A formation of one gun, so this test owns the unit it is about. It
    // needs blue's one unit to be artillery -- range 3..5 -- and the default
    // formation is a tuning dial that has already moved the guns once.
    const base = createMatchState(
      getMap('classic'),
      PLAYERS.map((player) => ({ player, army: ['a'] })),
      { width: 1, depth: 1 },
    );
    const gun = base.units.find((unit) => unit.owner === BLUE)!;
    const target = base.units.find((unit) => unit.owner === RED)!;
    const lastStand = {
      ...base,
      units: [
        { ...gun, position: { col: 5, row: 0 } },
        { ...target, position: { col: 5, row: 3 }, health: 1 },
      ],
    };
    await sql.execute({
      sql: 'UPDATE matches SET initial_state = ?, current_state = ? WHERE id = ?',
      args: [JSON.stringify(lastStand), JSON.stringify(lastStand), id],
    });

    // Blue's gun has range 3..5, so it kills from three tiles off without
    // moving, and a one-health defender does not survive it.
    const result = ruled(
      await store.submit(id, {
        type: 'move',
        unitId: gun.id,
        path: [{ col: 5, row: 0 }],
        facing: 'north',
        targetUnitId: target.id,
      }),
    );
    expect(result.ok).toBe(true);

    const log = await store.since(id, 0);
    expect(log!.events.map((event) => event.type)).toEqual([
      'unitMoved',
      'battleResolved',
      'gameEnded',
    ]);

    const { applyEvents } = await import('@wargame/shared');
    const { rows } = await sql.execute({
      sql: 'SELECT initial_state, current_state, ended_by FROM matches WHERE id = ?',
      args: [id],
    });
    const folded = applyEvents(JSON.parse(rows[0].initial_state as string), log!.events);
    expect(folded).toEqual(JSON.parse(rows[0].current_state as string));
    // And the thing the fold had to carry across: the marker, not just the board.
    expect(folded.winner).toBe(BLUE);
    expect(rows[0].ended_by).toBe('board');
  });
});

// ⚠️ Reaching a real victory here would mean playing sixteen units to death, so
// the terminal state is written straight into the row instead. That is a
// deliberate trade: `resolveAction` emitting `gameEnded` is covered in the
// rulebook's own suite, and what is left for this layer is the plumbing --
// whether a finished match survives the column, the summary and the refusal.
describe('a finished match', () => {
  const finish = async (winner: string) => {
    const { id } = await store.create();
    const state = { ...createMatchState(getMap('classic')), winner };
    await sql.execute({
      sql: 'UPDATE matches SET current_state = ?, winner = ? WHERE id = ?',
      args: [JSON.stringify(state), winner, id],
    });
    return id;
  };

  it('reports the winner in the listing without loading the game', async () => {
    await finish(RED);
    const [summary] = await store.list();
    expect(summary.winner).toBe(RED);
    // ⚠️ And `current_turn` is untouched beside it, which is what the lobby's
    // "winner displaces the turn" rendering rests on -- the column still holds
    // a live-looking value, so a row that read it alone would look unfinished.
    expect(summary.currentTurn).toBe(BLUE);
  });

  it('is no longer counted as unfinished', async () => {
    await store.create();
    await finish(RED);
    expect(await store.unfinished()).toBe(1);
  });

  it('refuses a command that would otherwise be legal', async () => {
    const id = await finish(BLUE);
    const result = ruled(await store.submit(id, { type: 'endTurn' }));
    expect(result).toEqual({ ok: false, reason: 'the game is over' });
  });

  it('writes nothing when it refuses', async () => {
    const id = await finish(BLUE);
    await store.submit(id, { type: 'endTurn' });
    const { rows } = await sql.execute({
      sql: 'SELECT COUNT(*) c FROM resolutions WHERE match_id = ?',
      args: [id],
    });
    expect(rows[0].c).toBe(0);
  });
});
