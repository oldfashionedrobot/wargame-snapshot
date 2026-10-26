import { isFacing } from './coordinate';
import type { Command, Coordinate, GameEvent, GameState, PlayerId } from './types';

// The wire contract. Lives in shared because both sides need it: the server
// implements it and the client's HTTP implementation must not have to import
// the server package to know its shape.

// --- The interface the client talks to ------------------------------------

export type CommandResult =
  | {
      ok: true;
      seq: number;
      events: GameEvent[];
      state: GameState;
      clocks?: Clocks;
      endedBy?: EndedBy | null;
    }
  | { ok: false; reason: string };

/**
 * Each seat's time left, in milliseconds and by seat, as the server measured it
 * when it answered; `null` for a game with no clock. ⚠️ **Which one is running
 * is the state's to say**: the seat to move's, while the game is under way and
 * not waiting. A client counts that one down until the next answer, and its
 * count decides nothing -- the server's deadline does.
 */
export type Clocks = number[] | null;

/** `Clocks` as a client received them, for counting the running one down. */
export interface ClockReading {
  remaining: readonly number[];
  at: number;
}

/** How a finished game ended: on the board, by a surrender, or on the clock. */
export type EndedBy = 'board' | 'surrender' | 'clock';

/** The clocks a game can have: minutes each player has for the whole game. */
export const CLOCK_MINUTES = [5, 10, 15, 20] as const;

export type UpdateListener = (events: GameEvent[], state: GameState) => void;

export interface GameServer {
  /** Latest known authoritative state. Synchronous, so a remote implementation
   *  serves it from a cache primed before construction completes. */
  getState(): GameState;

  /**
   * The seats this client holds -- every seat, in hot-seat. Fixed for the life
   * of a connection: nobody changes seats mid-game.
   */
  readonly you: readonly number[];

  /**
   * The clocks as last reported, and when -- `Date.now()` at arrival -- or
   * `null` for a game with no clock. Which one is running is the state's to
   * say; see `Clocks`.
   */
  getClocks(): ClockReading | null;

  /** How the game ended, as last reported; `null` while it goes on. */
  getEndedBy(): EndedBy | null;

  /** Submit intent. Async from the first version -- sync-to-async is a
   *  retrofit that touches every call site. */
  submit(command: Command): Promise<CommandResult>;

  /**
   * Register for state changes. Fires with current state as soon as it has
   * one -- synchronously for an implementation that already holds it, on
   * connect for a remote one. Never assume delivery before this call returns.
   *
   * Implementations deduplicate by `seq`, so a listener sees each update
   * exactly once no matter whether it arrived as a submit response or a poll.
   * Callers never see `seq` and never track it.
   *
   * Returns an unsubscribe function.
   */
  subscribe(onUpdate: UpdateListener): () => void;

  /**
   * Release the connection: stop polling, drop listeners.
   *
   * Unsubscribing a listener is not enough -- an implementation that polls
   * keeps running regardless of whether anyone is listening, so whoever
   * constructed the server has to be able to shut it down.
   */
  dispose(): void;
}

// --- HTTP shapes ----------------------------------------------------------

/**
 * GET /api/matches -- enough to render a row without loading a board.
 *
 * When the server needs fields the client shouldn't see, map explicitly rather
 * than extending this. A server type that extends it is structurally assignable
 * to it, so JSON.stringify would ship the extra fields and nothing in the type
 * system would object.
 */
export interface MatchSummary {
  id: string;
  createdAt: number;
  seq: number;
  currentTurn: PlayerId;
  /** Which board it was built from, so a list of matches can be told apart. */
  mapId: string;
  /**
   * Who won, or `null` for a match still being played.
   *
   * ⚠️ The lobby needs this, not `currentTurn`, to describe a finished match --
   * `currentTurn` is never cleared, so a row reading it alone would say *blue's
   * turn* forever.
   */
  winner: PlayerId | null;
  /** The code to join by, while the game waits for its second player; otherwise `null`. */
  code: string | null;
  /** The other player's name, in a game with one; `null` in hot-seat and while waiting. */
  opponent: string | null;
  /** Whether the game is waiting on this guest: never once won, nor while waiting. */
  yourTurn: boolean;
}

/** POST /api/auth/guest -- a guest's token, sent back as `Authorization: Bearer`. */
export interface GuestResponse {
  token: string;
}

/** Two players on one device, or one each on their own. */
export type MatchMode = 'hotSeat' | 'remote';

/**
 * POST /api/matches -- the body. Every field may be left out: the default map,
 * hot-seat, and the guest's own name or a generated one -- which is also what a
 * client from before modes asks for.
 */
export interface CreateMatchRequest {
  mapId?: string;
  mode?: MatchMode;
  /** The creator's seat in a remote game, numbered from 1; seat 1 moves first. */
  seat?: number;
  /** The name an opponent sees, kept for the guest's later games too. */
  name?: string;
  /** One of `CLOCK_MINUTES`; left out, the game has no clock. */
  clock?: number;
}

/** POST /api/matches/join -- answered with the joined match's `MatchSummary`. */
export interface JoinMatchRequest {
  code: string;
  name?: string;
}

/** GET /api/me -- the name to offer: the guest's own, or a suggestion for one with none. */
export interface MeResponse {
  name: string;
}

/** GET /api/maps -- what a new match can be started on. */
export interface MapSummary {
  id: string;
  name: string;
  /** In tiles, under the names the board's own code uses. */
  width: number;
  height: number;
}

/**
 * GET /api/maps/:id/preview -- a board with nobody having played on it.
 *
 * ⚠️ **A whole `GameState`, not the map's rows**, and that is the point rather
 * than a convenience: a map on its own is characters, and what anyone wants to
 * look at is the board *and the army deployed onto it*. Those are the same pair
 * `maps.test.ts` asserts against, for the same reason -- a deployment square
 * drawn onto a river is a property of the pair and invisible in either half.
 *
 * ⚠️ **It is not a match and nothing is stored.** `createMatchState` is pure, so
 * this costs a grid and sixteen units per request and leaves no row behind. A
 * viewer that created real matches to look at boards would fill the lobby with
 * them, and there is no delete.
 *
 * ⚠️ `id` rides along although the caller asked for it. A picker can be changed
 * twice before the first answer lands, and an id in the body makes discarding
 * the stale one a comparison rather than a bookkeeping exercise.
 */
export interface MapPreview {
  id: string;
  name: string;
  state: GameState;
}

/** GET /api/matches/:id/state -- initial load. No events; there's nothing to animate. */
export interface StateResponse {
  seq: number;
  state: GameState;
  /** The seats this guest holds, lowest first. */
  you: number[];
  /** As on `MatchSummary`: present while the game waits for its second player. */
  code: string | null;
  clocks: Clocks;
  /** `null` until the game is over. */
  endedBy: EndedBy | null;
  /**
   * Whether anybody else in this match has asked about it lately -- never in
   * hot-seat, which has nobody else. Shown, never acted on.
   */
  opponentHere: boolean;
}

/** GET /api/matches/:id/events?since=N -- everything after N. */
export interface EventsResponse {
  seq: number;
  events: GameEvent[];
  /**
   * The state those events produced -- present exactly when `seq` is greater
   * than the `since` that was asked for.
   *
   * A caught-up poll is the common case at a two-second interval, and it has
   * nothing to apply: the client drops any update whose `seq` it already has,
   * so a board sent with one is parsed and discarded. Omitting it is why the
   * steady-state poll costs a few dozen bytes instead of the whole grid.
   *
   * Events still never travel without the state they produced -- that is what
   * keeps the client self-correcting, and it is unchanged for every response
   * that carries any.
   */
  state?: GameState;
  /**
   * As on `StateResponse`. ⚠️ **On every poll, the caught-up ones included**:
   * a join is not a game event and moves no `seq`, so this is how a waiting
   * player learns the game has started.
   */
  code: string | null;
  /** Present with `state`: the clocks it leaves, and how it ended if it has. */
  clocks?: Clocks;
  endedBy?: EndedBy | null;
  /** As on `StateResponse`, and on every poll: it costs no read. */
  opponentHere: boolean;
}

/**
 * The body of every non-2xx response, a rule refusal (422) included; the
 * status says which kind of failure it is. `CommandResult`'s `{ ok: false }` is
 * what the client's `submit` resolves a refusal *to*, and never crosses the
 * wire.
 */
export interface ErrorResponse {
  error: string;
}

// --- Runtime validation ---------------------------------------------------
// TypeScript is erased; a POST body is attacker-controlled and can be
// anything. Hand-rolled because the command union is tiny and a schema library
// would be this package's first dependency.

// A defensive allocation bound, not a game rule -- validatePath enforces the
// real limit (the unit's movement budget). This exists so a hostile payload
// can't make us materialise a million coordinates before the reducer gets a
// chance to reject it. Far above any legitimate path on any plausible map.
const MAX_PATH_STEPS = 256;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseCoordinate(v: unknown): Coordinate | null {
  if (!isObject(v)) return null;
  const { col, row } = v;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return { col: col as number, row: row as number };
}

/**
 * Narrows an untrusted payload to a Command, or null if it isn't one.
 *
 * Only ever produces the fields a Command may carry -- extra properties in the
 * input are dropped rather than passed through, so a client cannot smuggle an
 * `actor` or anything else into the authority.
 */
export function parseCommand(input: unknown): Command | null {
  if (!isObject(input)) return null;

  switch (input.type) {
    case 'move': {
      if (typeof input.unitId !== 'string') return null;
      if (!Array.isArray(input.path)) return null;
      if (input.path.length === 0 || input.path.length > MAX_PATH_STEPS) return null;
      const path: Coordinate[] = [];
      for (const step of input.path) {
        const coordinate = parseCoordinate(step);
        if (!coordinate) return null;
        path.push(coordinate);
      }
      if (!isFacing(input.facing)) return null;

      // ⚠️ Refused when present and wrong, rather than dropped. Silently
      // discarding a malformed target would turn an attack into a plain move --
      // the command would succeed and do something the player did not ask for.
      const { targetUnitId, attackKind } = input;
      if (targetUnitId !== undefined && typeof targetUnitId !== 'string') return null;

      // ⚠️ **Same rule, and the failure it prevents is worse here.** A dropped
      // `attackKind` does not merely lose an attack -- it turns a *charge* into
      // an attack, which resolves, succeeds, and does something the player did
      // not ask for. This parser whitelists fields, so anything added to
      // `Command` and forgotten here is silently discarded.
      if (attackKind !== undefined && attackKind !== 'attack' && attackKind !== 'charge') {
        return null;
      }

      const command: Command = { type: 'move', unitId: input.unitId, path, facing: input.facing };
      if (targetUnitId !== undefined) command.targetUnitId = targetUnitId;
      if (attackKind !== undefined) command.attackKind = attackKind;
      return command;
    }
    case 'endTurn':
      return { type: 'endTurn' };
    case 'surrender':
      return { type: 'surrender' };
    default:
      return null;
  }
}
