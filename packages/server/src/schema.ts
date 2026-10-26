import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  Command,
  EndedBy,
  GameEvent,
  GameState,
  PlayerColor,
  PlayerId,
  Rolls,
} from '@wargame/shared';
import type { GuestId } from './guest';

/**
 * A person -- for now always a guest, written when it first creates a game,
 * never when it is minted, so minting stays free. ⚠️ **The table an account
 * grows into**: sign-in adds columns beside these rather than moving them.
 */
export const Users = sqliteTable('users', {
  id: text('id').$type<GuestId>().primaryKey(),
  // The name an opponent sees, generated until the player chooses one.
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const Matches = sqliteTable(
  'matches',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at').notNull(),
    // Written once and never read back -- deliberately. initial_state plus the
    // log is a complete history; without it the log is deltas with no anchor,
    // and it cannot be reconstructed after the fact.
    initialState: text('initial_state', { mode: 'json' }).$type<GameState>().notNull(),
    // A checkpoint, not a second source of truth: rebuildable at any time by
    // folding the log from initial_state. It exists because submit must validate
    // against current state and already reads this row for the guard below.
    currentState: text('current_state', { mode: 'json' }).$type<GameState>().notNull(),
    currentSeq: integer('current_seq').notNull(),
    // Denormalised out of current_state so listing matches doesn't parse an
    // entire board per row just to show whose turn it is.
    currentTurn: text('current_turn').$type<PlayerId>().notNull(),
    // Which map the board was instantiated from. Written and not read yet --
    // provenance, like initial_state. No foreign key: maps are code modules, and
    // their ids are immutable so this cannot come to mean something else.
    mapId: text('map_id').notNull().default('classic'),
    // Denormalised out of current_state for the same reason as current_turn: the
    // lobby has to say whether a match is finished without parsing a board per
    // row. ⚠️ Nullable, and that is the fact rather than a gap -- null means still
    // being played, which is why this took no default where map_id did. There is
    // no sensible finished-ness to backfill an existing row with.
    winner: text('winner').$type<PlayerId>(),
    // When the match was put away, for every player at once. ⚠️ A soft delete:
    // an archived match reads as missing to its players too, but the row and its
    // log stay, since real games are tuning evidence.
    archivedAt: integer('archived_at'),
    // What a second player joins by, while the game waits for one, and null
    // from then on -- so waiting is having a code. ⚠️ Separate from the id and
    // short, which it can afford to be: unique only among waiting games.
    code: text('code'),
    // When the mover's time runs out, and null whenever no clock is running:
    // no clock, a game still waiting, or one that is over. ⚠️ **Written only
    // when the turn changes** -- elapsed time is never stored, since this
    // implies it.
    deadline: integer('deadline'),
    // Null until there is a winner, so it says how the game ended and nothing
    // else.
    endedBy: text('ended_by').$type<EndedBy>(),
  },
  (t) => [
    uniqueIndex('matches_code')
      .on(t.code)
      .where(sql`${t.code} is not null`),
  ],
);

/**
 * Who sits where. ⚠️ **A guest's matches are the seats it holds**, and a
 * request may act only through one. Seat *n* is the *n*th
 * player in the match's state -- `playerInSeat` -- and a hot-seat game is one
 * guest in every seat.
 */
export const Seats = sqliteTable(
  'seats',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => Matches.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    // Empty while a seat waits for somebody to take it.
    occupant: text('occupant').$type<GuestId>(),
    // ⚠️ Ahead of its feature: nothing but a match's creation writes it until
    // players choose colours, and the state takes its colours from it then.
    color: text('color').$type<PlayerColor>().notNull(),
    // This seat's time left as of the end of its last turn; null for a game
    // with no clock. The mover's is the match's deadline, not this.
    clockRemainingMs: integer('clock_remaining_ms'),
  },
  // A guest's matches are found by the seats it holds -- and rows scanned are
  // what a hosted database bills.
  (t) => [primaryKey({ columns: [t.matchId, t.number] }), index('seats_occupant').on(t.occupant)],
);

/**
 * One accepted action and everything it produced.
 *
 * `(match_id, seq)` is the natural key for an ordered log, is what makes
 * `WHERE seq > ?` an index scan, and catches two writers claiming the same seq
 * for free.
 */
export const Resolutions = sqliteTable(
  'resolutions',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => Matches.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    // Promoted out of the action blob: the one field of an action worth
    // filtering on, and the only record of who did something once phase 11
    // makes that mean anything.
    actor: text('actor').$type<PlayerId>().notNull(),
    // An audit record, not something to act on: the command as accepted, still
    // carrying its actor. Typed as a Command, not an Action, so reading one back
    // cannot skip validateCommand -- validity was proven against the state at
    // the time, which is not this one.
    action: text('action', { mode: 'json' }).$type<Command>().notNull(),
    events: text('events', { mode: 'json' }).$type<GameEvent[]>().notNull(),
    // The rolls resolution was handed, written and not read -- the same as
    // action. Luck joins the base before the attacker's band and the defender's
    // cover scale it, so most rolls cannot be recovered from the damage they
    // produced; this is what keeps the record. ⚠️ Nullable, so rows from before it
    // existed stay valid. ⚠️ On the row and never in an event: events go to both
    // players, and a client is told an outcome and never its roll.
    rolls: text('rolls', { mode: 'json' }).$type<Rolls>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.seq] })],
);
