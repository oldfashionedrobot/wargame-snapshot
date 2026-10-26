import type { InStatement, InValue } from '@libsql/client';
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  min,
  ne,
  sql,
} from 'drizzle-orm';
import type { Query, SQL } from 'drizzle-orm';
import {
  applyEvents,
  holdsTheTurn,
  playerInSeat,
  resolveAction,
  seatOf,
  validateCommand,
} from '@wargame/shared';
import type {
  Action,
  Clocks,
  Command,
  CommandResult,
  EndedBy,
  EventsResponse,
  GameEvent,
  GameState,
  MatchMode,
  MatchSummary,
  PlayerId,
  StateResponse,
} from '@wargame/shared';
import type { Database } from './db';
import type { GuestId } from './guest';
import { drawJoinCode } from './joinCode';
import { getMap, DEFAULT_MAP_ID } from './maps';
import { createMatchState, PLAYERS } from './matchState';
import { generateName } from './names';
import { rollLuck } from './rollLuck';
import { Matches, Resolutions, Seats, Users } from './schema';

// Nothing deletes a match, so a guest's list only grows. A cap keeps the start
// screen bounded without pretending to be pagination.
const LIST_LIMIT = 50;

/**
 * The most commands a match takes. Several times the longest game the
 * simulator has played, so no real game meets it -- it is what stops a script
 * sending `endTurn` in a loop from growing one log for ever.
 */
export const COMMANDS_PER_MATCH = 1000;

/** What `submit` answers when another write reached the match first. */
export const MOVED = 'moved';

// A fresh code colliding with a waiting game's is one in a billion or so; a
// few draws is plenty, and running out is an error rather than a loop.
const CODE_DRAWS = 5;

const MINUTE = 60_000;

/** A match to create. Every field may be left out -- see `CreateMatchRequest`. */
export interface NewMatch {
  mapId?: string;
  mode?: MatchMode;
  /** The creator's seat in a remote game; the first when left out. */
  seat?: number;
  /** Already through `readName`. */
  name?: string;
  /** Minutes each player has, already checked against `CLOCK_MINUTES`. */
  clock?: number;
}

export type JoinResult = { ok: true; match: MatchSummary } | { ok: false; reason: string };

export interface StoreOptions {
  /** The server's clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Where join codes come from, so a test can make two collide. */
  drawCode?: () => string;
}

/**
 * One guest's matches: those it holds a seat in. ⚠️ **Another guest's match is
 * not here at all**, and neither is an archived one: every lookup asks for a
 * seat this guest holds and skips what was archived, so a match that exists
 * and one that is not yours come back as the same `null`, from the same query.
 */
export interface MatchStore {
  /**
   * Hot-seat seats this guest everywhere; a remote game seats it in one, and
   * waits under a code for somebody to take the other. Throws on an unknown map
   * or a seat it does not have -- callers check first, to answer 400 not 500.
   */
  create(match?: NewMatch): Promise<MatchSummary>;
  /**
   * Takes the empty seat of the game waiting under `code`, which starts it.
   * `null` when nothing waits under it; refused when the game is this guest's
   * own, or another join got there first.
   */
  join(code: string, name?: string): Promise<JoinResult | null>;
  /**
   * Archives a game still waiting -- false once it has started, `null` when
   * it is not this guest's to cancel.
   */
  cancel(matchId: string): Promise<boolean | null>;
  /** The name this guest plays under, or a suggestion for one with none. Writes nothing. */
  name(): Promise<string>;
  list(): Promise<MatchSummary[]>;
  /** How many have neither a winner nor been archived. */
  unfinished(): Promise<number>;
  /** False when there was no such match to archive, as with a `null` below. */
  archive(matchId: string): Promise<boolean>;
  /** Presence is not the store's: it is held in memory, and added by the route. */
  snapshot(matchId: string): Promise<Omit<StateResponse, 'opponentHere'> | null>;
  since(matchId: string, from: number): Promise<Omit<EventsResponse, 'opponentHere'> | null>;
  /**
   * `null` when the match is not this guest's, as with snapshot and since, and
   * `MOVED` when another write reached it first. A `CommandResult` of
   * `ok: false` then means exactly one thing: the rules refused a well-formed
   * command. Who it acts as is decided here -- see `actorFor`.
   */
  submit(matchId: string, command: Command): Promise<CommandResult | typeof MOVED | null>;
}

/**
 * The single place a request becomes a player. ⚠️ **One rule for every mode**:
 * it acts as the player whose turn it is if it holds that seat, and otherwise
 * as the first seat it holds -- where the rulebook refuses anything but a
 * surrender, as not its turn. Hot-seat holds every seat, so there it is always
 * the player whose turn it is, surrendering included.
 */
function actorFor(state: GameState, seats: number[]): PlayerId {
  if (holdsTheTurn(state, seats)) return state.currentTurn;
  const player = playerInSeat(state, seats[0]);
  if (!player) throw new Error(`seat ${seats[0]} has no player in this match`);
  return player.id;
}

// A batch that broke a key rolls back whole, so nothing of it landed: two
// writes claiming the same seq break the log's primary key, and a join code
// drawn twice breaks the index over waiting games.
const violated = (
  cause: unknown,
  constraint: 'SQLITE_CONSTRAINT_PRIMARYKEY' | 'SQLITE_CONSTRAINT_UNIQUE',
): boolean =>
  cause instanceof Error && 'extendedCode' in cause && cause.extendedCode === constraint;

// group_concat's answer -- the seat numbers as `1,2`, or null for none -- as a
// list, lowest first.
const seatList = (held: string | null | undefined): number[] =>
  held
    ? held
        .split(',')
        .map(Number)
        .sort((a, b) => a - b)
    : [];

/** A match as a request finds it: the board, and where its seats and clock stand. */
interface LoadedMatch {
  state: GameState;
  seq: number;
  code: string | null;
  deadline: number | null;
  endedBy: EndedBy | null;
  /** The seats this guest holds, lowest first. */
  seats: number[];
  /** Each seat's time left as of its last turn's end, by seat; null without a clock. */
  stored: (number | null)[];
}

/** The clocks as a client is told them at `at`: the mover's from the deadline, the rest as stored. */
function clocksAt(
  { state, deadline, stored }: Pick<LoadedMatch, 'state' | 'deadline' | 'stored'>,
  at: number,
): Clocks {
  if (stored.every((ms) => ms === null)) return null;
  const moving = deadline === null ? null : seatOf(state, state.currentTurn);
  return stored.map((ms, index) =>
    deadline !== null && index + 1 === moving ? Math.max(0, deadline - at) : (ms ?? 0),
  );
}

/**
 * What a resolution does to the clock, or `null` for nothing -- which is every
 * resolution within a turn. ⚠️ **Only a turn's end moves it**: the mover's time
 * left is the deadline less now, and the next deadline now plus the next
 * mover's time, or none once the game is over. A mover past its deadline is
 * left nothing, which is how a timeout needs no case of its own.
 */
function clockAfter(
  match: LoadedMatch,
  next: GameState,
  at: number,
): { seat: number; remaining: number; deadline: number | null } | null {
  if (match.deadline === null) return null;
  if (next.currentTurn === match.state.currentTurn && next.winner === null) return null;
  const seat = seatOf(match.state, match.state.currentTurn);
  const nextSeat = seatOf(next, next.currentTurn);
  if (seat === null || nextSeat === null) throw new Error('a clock running for nobody');
  return {
    seat,
    remaining: Math.max(0, match.deadline - at),
    deadline: next.winner === null ? at + (match.stored[nextSeat - 1] ?? 0) : null,
  };
}

/**
 * Hands a Drizzle-built statement to the raw libSQL driver.
 *
 * Needed because `client.batch` takes a transaction mode and Drizzle's own
 * `batch` does not -- see submit. Drizzle types params as `unknown[]` since it
 * is dialect-agnostic; libSQL wants `InValue[]`. Every SQLite column type
 * Drizzle emits maps into libSQL's `Value` union, so the assertion is sound --
 * but it is an assertion, and this is the one place it lives.
 */
const bind = (query: Query): InStatement => ({
  sql: query.sql,
  args: query.params as InValue[],
});

export function createMatchStore(
  { db }: Database,
  guest: GuestId,
  { now = Date.now, drawCode = drawJoinCode }: StoreOptions = {},
): MatchStore {
  // The matches this guest holds a seat in, archived ones aside -- for the
  // list and its counts.
  const mine = and(
    inArray(
      Matches.id,
      db.select({ id: Seats.matchId }).from(Seats).where(eq(Seats.occupant, guest)),
    ),
    isNull(Matches.archivedAt),
  );

  // ⚠️ **Subqueries for a match's row are built, never written in `sql`.**
  // Drizzle strips the table from every column in a one-table select's fields,
  // so a hand-written one's `matches.id` reaches SQLite as a bare `id` -- which
  // binds to the innermost table that has one. A built query keeps its tables.

  // The seats this guest holds in a match, asked in the same query as the
  // match, so finding it and checking it is yours is one read.
  const seatsHeld = sql<string | null>`${db
    .select({ held: sql`group_concat(${Seats.number})` })
    .from(Seats)
    .where(and(eq(Seats.matchId, Matches.id), eq(Seats.occupant, guest)))}`;
  // Every seat's time left, as `{ "1": ms, "2": ms }` -- keyed rather than
  // listed, so no order has to survive the aggregate.
  const seatClocks = sql<string | null>`${db
    .select({ clocks: sql`json_group_object(${Seats.number}, ${Seats.clockRemainingMs})` })
    .from(Seats)
    .where(eq(Seats.matchId, Matches.id))}`;
  // The name in a seat this guest does not hold: its opponent's, where it has one.
  const opponent = sql<string | null>`${db
    .select({ name: Users.name })
    .from(Seats)
    .innerJoin(Users, eq(Users.id, Seats.occupant))
    .where(and(eq(Seats.matchId, Matches.id), ne(Seats.occupant, guest)))
    .limit(1)}`;
  const open = (matchId: string) => and(eq(Matches.id, matchId), isNull(Matches.archivedAt));

  async function loadMatch(matchId: string): Promise<LoadedMatch | null> {
    const [row] = await db
      .select({
        state: Matches.currentState,
        seq: Matches.currentSeq,
        code: Matches.code,
        deadline: Matches.deadline,
        endedBy: Matches.endedBy,
        held: seatsHeld,
        clocks: seatClocks,
      })
      .from(Matches)
      .where(open(matchId));
    const seats = seatList(row?.held);
    if (!row || seats.length === 0) return null;
    const stored = JSON.parse(row.clocks ?? '{}') as Record<string, number | null>;
    return {
      state: row.state,
      seq: row.seq,
      code: row.code,
      deadline: row.deadline,
      endedBy: row.endedBy,
      seats,
      stored: row.state.players.map((_, index) => stored[index + 1] ?? null),
    };
  }

  const ranOut = (deadline: number | null): boolean => deadline !== null && deadline <= now();

  /**
   * The match as it stands, a clock that ran out settled first. ⚠️ **Lazily,
   * since nothing runs between requests**: whichever request looks first after
   * the deadline issues the mover's surrender, before whatever it came to do.
   * Two looking together race for it, and the one that loses reads what the
   * other wrote. Bounded, so a clock that somehow stayed run out cannot loop.
   */
  async function current(matchId: string): Promise<LoadedMatch | null> {
    for (let look = 0; look < 3; look++) {
      const match = await loadMatch(matchId);
      if (!match || !ranOut(match.deadline)) return match;
      const surrender = validateCommand(
        match.state,
        { type: 'surrender' },
        match.state.currentTurn,
      );
      if (!surrender.ok) throw new Error(`no timeout could be issued: ${surrender.reason}`);
      await commit(matchId, match, surrender.action, 'clock');
    }
    return loadMatch(matchId);
  }

  /**
   * Resolves an accepted action against the match it was accepted on, and
   * writes it -- the log, the match, and the clock where the turn changed.
   * `MOVED` when another write reached the match first.
   */
  async function commit(
    matchId: string,
    match: LoadedMatch,
    action: Action,
    cause: 'command' | 'clock',
  ): Promise<
    | {
        seq: number;
        events: GameEvent[];
        state: GameState;
        clocks: Clocks;
        endedBy: EndedBy | null;
      }
    | typeof MOVED
  > {
    const at = now();
    const rolls = rollLuck();
    const events = resolveAction(match.state, action, rolls);

    // Reducers return events, not state. Folding them here is the only way a
    // new state is ever produced, so what gets stored and what a replay of
    // the log produces are the same computation.
    const next = applyEvents(match.state, events);
    const nextSeq = match.seq + 1;
    const clock = clockAfter(match, next, at);
    // Decided once, by whatever ended it; nothing after a win changes it.
    const endedBy: EndedBy | null =
      next.winner === null || match.state.winner !== null
        ? match.endedBy
        : cause === 'clock'
          ? 'clock'
          : action.type === 'surrender'
            ? 'surrender'
            : 'board';

    // Built by Drizzle, run by the raw driver. Drizzle's own batch() cannot
    // pass a transaction mode -- it always gets libSQL's default, `deferred`,
    // which starts as a read and upgrades on first write. `write` is BEGIN
    // IMMEDIATE: the lock is taken up front, so the upgrade cannot fail
    // partway through. Deliberate, and the reason this is not db.batch().
    //
    // Atomicity here is about crashes more than races: a process dying
    // between the writes would leave the log one ahead of the materialized
    // state, and every later command would fail.
    //
    // ⚠️ **Concurrent writers lose cleanly.** Two requests claiming the same
    // seq means one violates PRIMARY KEY (match_id, seq), its batch rolls
    // back whole, and it answers `MOVED` rather than failing -- a surrender
    // beside the mover's command, two players at once, or two polls settling
    // the same timeout.
    let updated;
    try {
      [, updated] = await db.$client.batch(
        [
          db.insert(Resolutions).values({
            matchId,
            seq: nextSeq,
            actor: action.actor,
            action,
            events,
            rolls,
            createdAt: at,
          }),
          db
            .update(Matches)
            .set({
              currentState: next,
              currentSeq: nextSeq,
              currentTurn: next.currentTurn,
              // Written every time rather than only when it changes: it is a
              // copy of a field on the state being written beside it, so
              // deriving when to skip it is how the two come to disagree.
              winner: next.winner,
              ...(clock && { deadline: clock.deadline }),
              endedBy,
            })
            // Optimistic concurrency: refuse to write over a row that moved
            // since we read it.
            .where(and(eq(Matches.id, matchId), eq(Matches.currentSeq, match.seq))),
          ...(clock
            ? [
                db
                  .update(Seats)
                  .set({ clockRemainingMs: clock.remaining })
                  .where(and(eq(Seats.matchId, matchId), eq(Seats.number, clock.seat))),
              ]
            : []),
        ].map((query) => bind(query.toSQL())),
        'write',
      );
    } catch (failure) {
      if (violated(failure, 'SQLITE_CONSTRAINT_PRIMARYKEY')) return MOVED;
      throw failure;
    }

    // Unreachable while the log's primary key violates first, which is
    // exactly why it is worth asserting: an impossible condition that goes
    // unchecked is one nobody notices becoming possible.
    if (updated.rowsAffected !== 1) {
      throw new Error(`match ${matchId} moved underneath us at seq ${match.seq}`);
    }

    const stored = clock
      ? match.stored.map((ms, index) => (index + 1 === clock.seat ? clock.remaining : ms))
      : match.stored;
    const deadline = clock ? clock.deadline : match.deadline;
    return {
      seq: nextSeq,
      events,
      state: next,
      clocks: clocksAt({ state: next, deadline, stored }, at),
      endedBy,
    };
  }

  /**
   * ⚠️ **A guest becomes a row by taking a seat**: this is the statement after
   * the seat's in both batches, and conditional on it, so a join that lost its
   * race writes no name either. The name is replaced when one is sent,
   * generated for a guest with no row yet, and otherwise left alone.
   */
  function seatedUser(matchId: string, name: string | undefined) {
    const insert = db.insert(Users).select(
      db
        .select({
          id: sql<GuestId>`${guest}`.as('id'),
          name: sql<string>`${name ?? generateName()}`.as('name'),
          createdAt: sql<number>`${now()}`.as('created_at'),
        })
        .from(Seats)
        .where(and(eq(Seats.matchId, matchId), eq(Seats.occupant, guest)))
        .limit(1),
    );
    return name === undefined
      ? insert.onConflictDoNothing()
      : insert.onConflictDoUpdate({ target: Users.id, set: { name } });
  }

  // The rows a list shows, read the same way wherever one is answered.
  async function summaries(where: SQL | undefined): Promise<MatchSummary[]> {
    // No board parsing here -- current_turn is denormalised precisely so
    // listing stays cheap as matches accumulate.
    const rows = await db
      .select({
        id: Matches.id,
        createdAt: Matches.createdAt,
        seq: Matches.currentSeq,
        currentTurn: Matches.currentTurn,
        mapId: Matches.mapId,
        winner: Matches.winner,
        code: Matches.code,
        deadline: Matches.deadline,
        opponent,
        held: seatsHeld,
      })
      .from(Matches)
      .where(where)
      .orderBy(desc(Matches.createdAt))
      .limit(LIST_LIMIT);
    return rows.map(({ held, deadline, ...row }) => ({
      ...row,
      // ⚠️ Every match is between `PLAYERS`, by seat, so whose turn a row
      // records is a seat without its board being read. A clock that ran out
      // is nobody's turn, though listing writes nothing to settle it.
      yourTurn:
        row.winner === null &&
        row.code === null &&
        !ranOut(deadline) &&
        holdsTheTurn({ players: PLAYERS, currentTurn: row.currentTurn }, seatList(held)),
    }));
  }

  return {
    async create({ mapId = DEFAULT_MAP_ID, mode = 'hotSeat', seat = 1, name, clock } = {}) {
      const id = crypto.randomUUID();
      const createdAt = now();
      // getMap throws on an unknown id, which is what stops a bad one reaching
      // the insert -- callers check first so it can answer 400 rather than 500.
      const state = createMatchState(getMap(mapId));
      const remote = mode === 'remote';
      if (remote && !playerInSeat(state, seat)) throw new Error(`there is no seat ${seat}`);
      const clockMs = clock === undefined ? null : clock * MINUTE;

      for (let draw = 1; ; draw++) {
        const code = remote ? drawCode() : null;
        try {
          await db.batch([
            db.insert(Matches).values({
              id,
              createdAt,
              initialState: state,
              currentState: state,
              currentSeq: 0,
              currentTurn: state.currentTurn,
              mapId,
              winner: state.winner,
              code,
              // ⚠️ A clock starts when the game does: here for hot-seat, and
              // at the join for a remote game.
              deadline: clockMs !== null && !remote ? createdAt + clockMs : null,
            }),
            // Each seat the colour its player was built with. Hot-seat is the
            // creator in every one; a remote game leaves the other empty.
            db.insert(Seats).values(
              state.players.map((player, index) => ({
                matchId: id,
                number: index + 1,
                occupant: remote && index + 1 !== seat ? null : guest,
                color: player.color,
                clockRemainingMs: clockMs,
              })),
            ),
            seatedUser(id, name),
          ]);
        } catch (cause) {
          if (code !== null && violated(cause, 'SQLITE_CONSTRAINT_UNIQUE') && draw < CODE_DRAWS) {
            continue;
          }
          throw cause;
        }

        return {
          id,
          createdAt,
          seq: 0,
          currentTurn: state.currentTurn,
          mapId,
          winner: state.winner,
          code,
          opponent: null,
          yourTurn: !remote && state.winner === null,
        };
      }
    },

    async join(code, name) {
      const [match] = await db
        .select({ id: Matches.id, currentTurn: Matches.currentTurn, held: seatsHeld })
        .from(Matches)
        .where(and(eq(Matches.code, code), isNull(Matches.archivedAt)));
      if (!match) return null;
      // ⚠️ Refused rather than made hot-seat: a code is for somebody else.
      if (seatList(match.held).length > 0) {
        return { ok: false, reason: 'that is your own game -- send its code to your opponent' };
      }

      // ⚠️ **Each statement conditional, in one batch**: the seat is taken only
      // while the code is still there, and the rest only once this guest has
      // it, so of two joins racing one wins, and the other -- or a join landing
      // after a cancel -- changes nothing at all.
      const stillWaiting = exists(
        db
          .select({ one: sql`1` })
          .from(Matches)
          .where(and(eq(Matches.id, match.id), eq(Matches.code, code), isNull(Matches.archivedAt))),
      );
      const seated = exists(
        db
          .select({ one: sql`1` })
          .from(Seats)
          .where(and(eq(Seats.matchId, match.id), eq(Seats.occupant, guest))),
      );
      const firstEmpty = db
        .select({ number: min(Seats.number) })
        .from(Seats)
        .where(and(eq(Seats.matchId, match.id), isNull(Seats.occupant)));
      // The game starts here, so its clock does: the first mover's time from
      // now -- and null, from a null, for a game with no clock.
      const firstMover = seatOf({ players: PLAYERS }, match.currentTurn);
      const firstClock = db
        .select({ ms: Seats.clockRemainingMs })
        .from(Seats)
        .where(and(eq(Seats.matchId, match.id), eq(Seats.number, firstMover ?? 0)));
      const [claimed] = await db.batch([
        db
          .update(Seats)
          .set({ occupant: guest })
          .where(and(eq(Seats.matchId, match.id), eq(Seats.number, firstEmpty), stillWaiting)),
        db
          .update(Matches)
          .set({ code: null, deadline: sql`${now()} + ${firstClock}` })
          .where(and(eq(Matches.id, match.id), eq(Matches.code, code), seated)),
        seatedUser(match.id, name),
      ]);
      if (claimed.rowsAffected !== 1) {
        return { ok: false, reason: 'somebody else joined that game first' };
      }

      const [joined] = await summaries(eq(Matches.id, match.id));
      return { ok: true, match: joined };
    },

    async cancel(matchId) {
      const { rowsAffected } = await db
        .update(Matches)
        .set({ archivedAt: now(), code: null })
        .where(and(eq(Matches.id, matchId), isNotNull(Matches.code), mine));
      if (rowsAffected === 1) return true;
      return (await loadMatch(matchId)) ? false : null;
    },

    async name() {
      const [user] = await db.select({ name: Users.name }).from(Users).where(eq(Users.id, guest));
      return user?.name ?? generateName();
    },

    async list() {
      return summaries(mine);
    },

    async unfinished() {
      const [{ n }] = await db
        .select({ n: count() })
        .from(Matches)
        .where(and(mine, isNull(Matches.winner)));
      return n;
    },

    async archive(matchId) {
      const { rowsAffected } = await db
        .update(Matches)
        .set({ archivedAt: now() })
        .where(and(eq(Matches.id, matchId), mine));
      return rowsAffected === 1;
    },

    async snapshot(matchId) {
      const match = await current(matchId);
      return (
        match && {
          seq: match.seq,
          state: match.state,
          you: match.seats,
          code: match.code,
          clocks: clocksAt(match, now()),
          endedBy: match.endedBy,
        }
      );
    },

    async since(matchId, from) {
      // ⚠️ **A caught-up poll reads no board** -- the common case at poll
      // interval, and with two players polling, twice as common. Only what the
      // answer needs, and the deadline, are asked for until there is something
      // to send.
      const [row] = await db
        .select({
          seq: Matches.currentSeq,
          code: Matches.code,
          deadline: Matches.deadline,
          held: seatsHeld,
        })
        .from(Matches)
        .where(open(matchId));
      if (!row || seatList(row.held).length === 0) return null;

      // Caught up: no events to send, and no board either -- the client
      // already has this state and would discard a copy of it. Keyed on seq
      // rather than an empty row set, so a resolution that produced no events
      // could never strand a client without the state it implies.
      const caughtUp = { seq: row.seq, events: [], code: row.code };
      if (row.seq <= from && !ranOut(row.deadline)) return caughtUp;

      // Something to send -- or a clock to settle, which then is.
      const match = await current(matchId);
      if (!match) return null;
      if (match.seq <= from) return { ...caughtUp, seq: match.seq, code: match.code };
      // ⚠️ Bounded by the seq the state was read at, so a command landing in
      // between cannot put events in the answer that its state does not have.
      const rows = await db
        .select({ events: Resolutions.events })
        .from(Resolutions)
        .where(
          and(
            eq(Resolutions.matchId, matchId),
            gt(Resolutions.seq, from),
            lte(Resolutions.seq, match.seq),
          ),
        )
        .orderBy(Resolutions.seq);

      return {
        seq: match.seq,
        events: rows.flatMap((resolution) => resolution.events),
        state: match.state,
        code: match.code,
        clocks: clocksAt(match, now()),
        endedBy: match.endedBy,
      };
    },

    async submit(matchId, command) {
      // A clock that ran out is settled first, so a command arriving after the
      // deadline finds the game already lost.
      const match = await current(matchId);
      if (!match) return null;
      // ⚠️ Its state is built at creation, so without this the creator could
      // play before anybody joined. Cancelling, not surrendering, ends one.
      if (match.code !== null) {
        return { ok: false, reason: 'the game has not started -- it is waiting for an opponent' };
      }
      // ⚠️ A surrender is let past, so a game that has used every command can
      // still be ended -- and cleared from its players' unfinished games.
      if (match.seq >= COMMANDS_PER_MATCH && command.type !== 'surrender') {
        return {
          ok: false,
          reason: `this match has taken all ${COMMANDS_PER_MATCH} of its commands`,
        };
      }

      // validateCommand is the only thing that can mint an Action, and it
      // stamps `actor` itself -- so a client-supplied `actor` in the JSON body
      // cannot survive, and resolveAction cannot be reached without this
      // having succeeded.
      const validation = validateCommand(match.state, command, actorFor(match.state, match.seats));
      if (!validation.ok) return { ok: false, reason: validation.reason };

      const written = await commit(matchId, match, validation.action, 'command');
      return written === MOVED ? MOVED : { ok: true, ...written };
    },
  };
}
