import type {
  ClockReading,
  Clocks,
  Command,
  CommandResult,
  EventsResponse,
  GameServer,
  GameState,
  StateResponse,
  UpdateListener,
} from '@wargame/shared';
import { isOver } from '@wargame/shared';
import { getJson, HttpError, postJson, RejectedError } from './api';
import type { FailureKind } from './api';

const POLL_INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 30_000;

export type ConnectionStatus = 'connected' | 'retrying';

const reading = (clocks: Clocks): ClockReading | null =>
  clocks && { remaining: clocks, at: Date.now() };

export interface ConnectOptions {
  onConnectionChange?: (status: ConnectionStatus) => void;
  /** A game that was waiting has been joined: the first poll without its code. */
  onStart?: () => void;
  /** The other side came or went, by the server's last word. */
  onPresenceChange?: (opponentHere: boolean) => void;
}

export type ConnectResult =
  | {
      ok: true;
      server: GameServer;
      /** The code a waiting game is joined by; `null` for a game already under way. */
      code: string | null;
      opponentHere: boolean;
    }
  | { ok: false; kind: FailureKind; reason: string };

/**
 * The GameServer implementation that talks HTTP.
 *
 * Connects before returning, so callers never see a server without state --
 * which is what lets getState() stay synchronous.
 *
 * Returns a result rather than throwing because "no such match" is an expected
 * outcome of a shared link, not an exception, and it needs different UI from a
 * server that's simply down.
 */
export async function connectGameServer(
  matchId: string,
  options: ConnectOptions = {},
): Promise<ConnectResult> {
  const base = `/matches/${encodeURIComponent(matchId)}`;

  let initial: StateResponse;
  try {
    initial = await getJson<StateResponse>(`${base}/state`);
  } catch (cause) {
    const kind: FailureKind = cause instanceof HttpError ? cause.kind : 'unreachable';
    return {
      ok: false,
      kind,
      reason: cause instanceof Error ? cause.message : 'connection failed',
    };
  }

  let state: GameState = initial.state;
  // Every update a caller sees passes this. Deduplicating here rather than in
  // the UI is what keeps components ignorant of seq: a poll already in flight
  // when a command is submitted returns the same events the POST response is
  // about to deliver, and applying both would animate the move twice.
  let lastSeq = initial.seq;
  let status: ConnectionStatus = 'connected';
  let disposed = false;
  let waiting = initial.code !== null;
  let clocks = reading(initial.clocks);
  let endedBy = initial.endedBy;
  let opponentHere = initial.opponentHere;

  const listeners = new Set<UpdateListener>();

  const setStatus = (next: ConnectionStatus): void => {
    if (next === status) return;
    status = next;
    options.onConnectionChange?.(next);
  };

  const applyUpdate = (update: Omit<EventsResponse, 'code' | 'opponentHere'>): void => {
    // Two ways to have nothing to do, and the second is the ordinary one: a
    // caught-up poll answers without a board (see EventsResponse), so there
    // is no state to adopt and no batch to deliver. Not advancing lastSeq
    // costs nothing -- it is already equal.
    if (update.seq <= lastSeq || !update.state) return;

    lastSeq = update.seq;
    state = update.state;
    if (update.clocks !== undefined) clocks = reading(update.clocks);
    if (update.endedBy !== undefined) endedBy = update.endedBy;
    for (const listener of listeners) listener(update.events, state);
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoff = POLL_INTERVAL_MS;

  const schedule = (delay = backoff): void => {
    // A finished match never changes, so there is nothing left to ask about.
    if (disposed || isOver(state)) return;
    if (timer !== null) clearTimeout(timer);
    // Nothing changes while the tab is hidden that can't be caught up on
    // return, and a hidden tab polling forever is pure waste.
    timer = setTimeout(() => void poll(), document.hidden ? MAX_BACKOFF_MS : delay);
  };

  const poll = async (): Promise<void> => {
    try {
      const update = await getJson<EventsResponse>(`${base}/events?since=${lastSeq}`);
      // ⚠️ Read off every poll, the caught-up ones too: a join is not a game
      // event, so nothing else would ever say it happened. ⚠️ **The match is
      // fetched once more when it starts**, since the clock started with it
      // and the reading from before would count the wait against the mover.
      if (waiting && update.code === null) {
        clocks = reading((await getJson<StateResponse>(`${base}/state`)).clocks);
        waiting = false;
        options.onStart?.();
      }
      if (update.opponentHere !== opponentHere) {
        opponentHere = update.opponentHere;
        options.onPresenceChange?.(opponentHere);
      }
      applyUpdate(update);
      backoff = POLL_INTERVAL_MS;
      setStatus('connected');
    } catch {
      // Not fatal -- the next poll asks from the same lastSeq, so nothing is
      // lost by missing one. Back off so a dead server isn't hammered.
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      setStatus('retrying');
    }
    schedule();
  };

  // Without this, going hidden schedules the next poll 30s out and coming back
  // doesn't reschedule -- so a visible tab could sit stale for half a minute.
  const onVisibilityChange = (): void => {
    if (document.hidden) return;
    backoff = POLL_INTERVAL_MS;
    schedule(0);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  schedule();

  const server: GameServer = {
    getState: () => state,
    you: initial.you,
    getClocks: () => clocks,
    getEndedBy: () => endedBy,

    async submit(command: Command) {
      let result: CommandResult;
      try {
        result = await postJson<CommandResult>(`${base}/commands`, command);
      } catch (cause) {
        // A rejection is an answer, not a transport failure: the server heard
        // us and refused, so the reconnecting banner stays down.
        if (cause instanceof RejectedError) return { ok: false, reason: cause.message };
        setStatus('retrying');
        return { ok: false, reason: cause instanceof Error ? cause.message : 'submit failed' };
      }

      setStatus('connected');
      if (result.ok) applyUpdate(result);
      return result;
    },

    subscribe(onUpdate) {
      listeners.add(onUpdate);
      onUpdate([], state); // so a subscriber needs no separate initial fetch
      return () => listeners.delete(onUpdate);
    },

    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };

  return { ok: true, server, code: initial.code, opponentHere };
}
