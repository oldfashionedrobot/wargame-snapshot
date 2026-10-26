import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeState } from '@wargame/shared/testing';
import type {
  CommandResult,
  EventsResponse,
  GameEvent,
  GameServer,
  StateResponse,
} from '@wargame/shared';
import { connectGameServer } from './gameServer';

// The most intricate code in the client. fetch and timers are faked; the DOM
// is happy-dom's, which is what makes the visibility behaviour testable --
// `document.hidden` is shadowed per-test and restored in afterEach.
//
// Every timer advance is the *async* form. The poll loop reschedules from an
// async callback, so the sync form would fire the timer, never let the awaits
// inside settle, and the loop would silently stop after one poll.

const POLL = 2000;
const MAX_BACKOFF = 30_000;

const state0 = makeState(3, [{ id: 'b1', col: 0, row: 0 }]);
const state1 = makeState(3, [{ id: 'b1', col: 0, row: 1 }]);
const moved: GameEvent[] = [
  {
    type: 'unitMoved',
    unitId: 'b1',
    facing: 'north',
    path: [
      { col: 0, row: 0 },
      { col: 0, row: 1 },
    ],
  },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

// One handler per endpoint, swappable mid-test, so each test scripts only the
// endpoint it is about. `requested` is what URL assertions read.
let onState: () => Promise<Response>;
let onEvents: (since: number) => Promise<Response>;
let onCommands: () => Promise<Response>;
let requested: string[];

const polls = (): number => requested.filter((url) => url.includes('/events')).length;

// What a caught-up poll actually answers: a cursor and nothing else. The
// server omits the board when seq has not moved, so a fixture that sent one
// would be testing against a server that does not exist.
const nothingNew = (since: number): Promise<Response> =>
  Promise.resolve(
    json({ seq: since, events: [], code: null, opponentHere: false } satisfies EventsResponse),
  );

const servers: GameServer[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  requested = [];
  onState = () =>
    Promise.resolve(
      json({
        seq: 0,
        state: state0,
        you: [1, 2],
        code: null,
        clocks: null,
        endedBy: null,
        opponentHere: false,
      } satisfies StateResponse),
    );
  onEvents = nothingNew;
  onCommands = () => Promise.reject(new Error('no command scripted for this test'));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/state')) return onState();
      if (url.includes('/events')) {
        const since = Number(new URL(url, 'http://test').searchParams.get('since'));
        return onEvents(since);
      }
      if (url.includes('/commands') && init?.method === 'POST') return onCommands();
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
});

afterEach(() => {
  for (const server of servers.splice(0)) server.dispose();
  Reflect.deleteProperty(document, 'hidden'); // drop any per-test shadow
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// happy-dom's document.hidden is a prototype getter; an own property shadows
// it for one test and afterEach deletes the shadow.
function setTabHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

async function connect(options?: Parameters<typeof connectGameServer>[1]): Promise<GameServer> {
  const result = await connectGameServer('m1', options);
  if (!result.ok) throw new Error('fixture failed to connect');
  servers.push(result.server);
  return result.server;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('connectGameServer', () => {
  it('connects and serves the fetched state synchronously', async () => {
    const server = await connect();
    expect(server.getState()).toEqual(state0);
  });

  // ⚠️ A join moves no seq, so the code is all a poll has to say it happened.
  it("hands back a waiting game's code, and says when a poll first comes without it", async () => {
    onState = () =>
      Promise.resolve(
        json({
          seq: 0,
          state: state0,
          you: [2],
          code: 'ABC234',
          clocks: null,
          endedBy: null,
          opponentHere: false,
        } satisfies StateResponse),
      );
    let code: string | null = 'ABC234';
    onEvents = (since) =>
      Promise.resolve(
        json({ seq: since, events: [], code, opponentHere: false } satisfies EventsResponse),
      );
    const onStart = vi.fn();
    const result = await connectGameServer('m1', { onStart });
    if (!result.ok) throw new Error('fixture failed to connect');
    servers.push(result.server);
    expect(result.code).toBe('ABC234');
    expect(result.server.you).toEqual([2]);

    await vi.advanceTimersByTimeAsync(POLL);
    expect(onStart).not.toHaveBeenCalled();
    code = null;
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // ⚠️ The clock started with the game, so a reading from before the join
  // would count the wait against the mover.
  it('reads the clocks again when a waiting game starts', async () => {
    const clocks = [300_000, 300_000];
    onState = () =>
      Promise.resolve(
        json({
          seq: 0,
          state: state0,
          you: [1],
          code,
          clocks,
          endedBy: null,
          opponentHere: false,
        } satisfies StateResponse),
      );
    let code: string | null = 'ABC234';
    onEvents = (since) =>
      Promise.resolve(
        json({ seq: since, events: [], code, opponentHere: false } satisfies EventsResponse),
      );
    const server = await connect();
    const before = server.getClocks();
    expect(before?.remaining).toEqual(clocks);

    await vi.advanceTimersByTimeAsync(POLL);
    code = null;
    await vi.advanceTimersByTimeAsync(POLL);
    expect(server.getClocks()?.at).toBeGreaterThan(before!.at);
  });

  it('reports the other side coming and going, once each time', async () => {
    let here = false;
    onEvents = (since) =>
      Promise.resolve(
        json({ seq: since, events: [], code: null, opponentHere: here } satisfies EventsResponse),
      );
    const onPresenceChange = vi.fn();
    await connect({ onPresenceChange });
    await vi.advanceTimersByTimeAsync(POLL);
    expect(onPresenceChange).not.toHaveBeenCalled();
    here = true;
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(onPresenceChange.mock.calls).toEqual([[true]]);
  });

  it('keeps how the game ended, from the update that ended it', async () => {
    const server = await connect();
    expect(server.getEndedBy()).toBeNull();
    onEvents = () =>
      Promise.resolve(
        json({
          seq: 1,
          events: [{ type: 'gameEnded', winner: 'red' }],
          state: { ...state0, winner: 'red' },
          code: null,
          endedBy: 'surrender',
          opponentHere: true,
        } satisfies EventsResponse),
      );
    await vi.advanceTimersByTimeAsync(POLL);
    expect(server.getEndedBy()).toBe('surrender');
  });

  it('keeps the clocks an update carries', async () => {
    const server = await connect();
    expect(server.getClocks()).toBeNull();
    onEvents = () =>
      Promise.resolve(
        json({
          seq: 1,
          events: moved,
          state: state1,
          code: null,
          clocks: [1_000, 2_000],
          opponentHere: false,
        } satisfies EventsResponse),
      );
    await vi.advanceTimersByTimeAsync(POLL);
    expect(server.getClocks()?.remaining).toEqual([1_000, 2_000]);
  });

  // The kind, never the message: transport wording changes in step 2, and a
  // test pinned to it would be rewritten by an otherwise additive change.
  it('classifies a missing match as notFound', async () => {
    onState = () => Promise.resolve(json({ error: 'not found' }, 404));
    const result = await connectGameServer('nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('notFound');
  });

  it('classifies a dead network as unreachable', async () => {
    onState = () => Promise.reject(new TypeError('fetch failed'));
    const result = await connectGameServer('m1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unreachable');
  });
});

describe('subscribe', () => {
  it('fires synchronously with the current state, so subscribers need no initial fetch', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([], state0);
  });

  it('stops delivering after unsubscribe', async () => {
    const server = await connect();
    const listener = vi.fn();
    const unsubscribe = server.subscribe(listener);
    unsubscribe();
    onEvents = () => Promise.resolve(json({ seq: 1, events: moved, state: state1 }));
    await vi.advanceTimersByTimeAsync(POLL);
    expect(listener).toHaveBeenCalledTimes(1); // the synchronous initial fire only
  });
});

describe('polling', () => {
  it('asks for everything after the last seq it saw', async () => {
    await connect();
    onEvents = () => Promise.resolve(json({ seq: 3, events: moved, state: state1 }));
    await vi.advanceTimersByTimeAsync(POLL);
    onEvents = nothingNew;
    await vi.advanceTimersByTimeAsync(POLL);
    const asked = requested.filter((url) => url.includes('/events'));
    expect(asked[0]).toContain('since=0');
    expect(asked[1]).toContain('since=3');
  });

  it('delivers new events and state to listeners', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);
    onEvents = () => Promise.resolve(json({ seq: 1, events: moved, state: state1 }));
    await vi.advanceTimersByTimeAsync(POLL);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(moved, state1);
    expect(server.getState()).toEqual(state1);
  });

  it('stops once a poll brings the end of the match', async () => {
    await connect();
    const over = { ...state1, winner: state1.players[0].id };
    onEvents = () => Promise.resolve(json({ seq: 1, events: [], state: over }));
    await vi.advanceTimersByTimeAsync(POLL);
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(polls()).toBe(1);
  });

  it('never polls a match that was already over, even when the tab comes back', async () => {
    const over = { ...state0, winner: state0.players[0].id };
    onState = () =>
      Promise.resolve(
        json({
          seq: 5,
          state: over,
          you: [1, 2],
          code: null,
          clocks: null,
          endedBy: null,
          opponentHere: false,
        } satisfies StateResponse),
      );
    await connect();
    await vi.advanceTimersByTimeAsync(10 * POLL);
    setTabHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10 * POLL);
    expect(polls()).toBe(0);
  });

  it('delivers nothing when the poll brings nothing new', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(listener).toHaveBeenCalledTimes(1); // the synchronous initial fire only
    expect(server.getState()).toEqual(state0);
  });

  // The `!update.state` half of the guard, which needs a response the seq
  // check does *not* already reject: a cursor that moved, carrying no board.
  // The protocol says that cannot happen -- state accompanies every advance
  // -- so this is the impossible case being made loud rather than silently
  // adopting `undefined` as the board and blanking it.
  //
  // An earlier version of this test used a caught-up response, where
  // `update.seq <= lastSeq` short-circuits first, so it never reached the
  // clause it claimed to cover.
  it('ignores an update that advances the cursor without a board', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);

    onEvents = () => Promise.resolve(json({ seq: 7, events: moved }));
    await vi.advanceTimersByTimeAsync(POLL);

    expect(listener).toHaveBeenCalledTimes(1); // nothing delivered
    expect(server.getState()).toEqual(state0); // and the board it holds survives

    // The cursor did not advance either, so the next poll asks from the same
    // place rather than skipping whatever it could not apply.
    onEvents = nothingNew;
    await vi.advanceTimersByTimeAsync(POLL);
    const asked = requested.filter((url) => url.includes('/events'));
    expect(asked[asked.length - 1]).toContain('since=0');
  });
});

describe('seq deduplication', () => {
  // The reason the guard exists: a poll already in flight when a command is
  // submitted returns the same events the POST response delivers. Applying both
  // would animate the move twice -- state hides a double-apply, events do not.
  it('drops a poll response repeating an update the submit already delivered', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);

    const inFlight = deferred<Response>();
    onEvents = () => inFlight.promise;
    await vi.advanceTimersByTimeAsync(POLL); // the poll leaves and does not return yet

    onCommands = () =>
      Promise.resolve(
        json({ ok: true, seq: 1, events: moved, state: state1 } satisfies CommandResult),
      );
    await server.submit({ type: 'endTurn' });
    expect(listener).toHaveBeenCalledTimes(2); // initial fire + the submit's own delivery

    onEvents = nothingNew;
    inFlight.resolve(json({ seq: 1, events: moved, state: state1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(2); // the duplicate was dropped

    await vi.advanceTimersByTimeAsync(POLL); // and the next poll asks past it
    expect(requested.at(-1)).toContain('since=1');
  });
});

describe('submit', () => {
  it('delivers its own response immediately, without waiting for a poll', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);
    onCommands = () =>
      Promise.resolve(
        json({ ok: true, seq: 1, events: moved, state: state1 } satisfies CommandResult),
      );
    const result = await server.submit({ type: 'endTurn' });
    expect(result.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(moved, state1);
  });

  it('reports a transport failure as ok: false and flips the connection to retrying', async () => {
    const onConnectionChange = vi.fn();
    const server = await connect({ onConnectionChange });
    const listener = vi.fn();
    server.subscribe(listener);
    onCommands = () => Promise.reject(new TypeError('fetch failed'));
    const result = await server.submit({ type: 'endTurn' });
    expect(result.ok).toBe(false);
    expect(onConnectionChange).toHaveBeenCalledWith('retrying');
    expect(listener).toHaveBeenCalledTimes(1); // nothing to deliver
  });

  // A rejection is an answer, not a connection problem. The server's own
  // wording is the contract here -- passing it through is the point -- so
  // asserting it is not the message-pinning the transport tests avoid.
  it('returns a 422 rejection with the server reason, without touching the connection', async () => {
    const onConnectionChange = vi.fn();
    const server = await connect({ onConnectionChange });
    const listener = vi.fn();
    server.subscribe(listener);
    onCommands = () => Promise.resolve(json({ error: 'unit has already acted' }, 422));
    const result = await server.submit({ type: 'endTurn' });
    expect(result).toEqual({ ok: false, reason: 'unit has already acted' });
    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1); // nothing to deliver
  });

  it('carries the server reason on a non-422 failure too, still as transport', async () => {
    const onConnectionChange = vi.fn();
    const server = await connect({ onConnectionChange });
    onCommands = () => Promise.resolve(json({ error: 'seq guard matched nothing' }, 500));
    const result = await server.submit({ type: 'endTurn' });
    expect(result).toEqual({ ok: false, reason: 'seq guard matched nothing' });
    expect(onConnectionChange).toHaveBeenCalledWith('retrying');
  });

  it('falls back to the status when the failure body is not ours', async () => {
    const server = await connect();
    onCommands = () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const result = await server.submit({ type: 'endTurn' });
    expect(result).toEqual({ ok: false, reason: 'server returned 502' });
  });
});

describe('backoff', () => {
  it('doubles the interval per failed poll and caps at 30s', async () => {
    await connect();
    onEvents = () => Promise.reject(new TypeError('fetch failed'));

    await vi.advanceTimersByTimeAsync(POLL);
    expect(polls()).toBe(1); // failed; next in 4s
    await vi.advanceTimersByTimeAsync(2 * POLL - 1);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(2); // failed; next in 8s
    await vi.advanceTimersByTimeAsync(4 * POLL);
    expect(polls()).toBe(3); // failed; next in 16s

    await vi.advanceTimersByTimeAsync(8 * POLL); // 4th failure caps the doubling
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF); // from here every gap is 30s
    expect(polls()).toBe(5);
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF - 1);
    expect(polls()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(6);
  });

  it('resets the interval on the next success', async () => {
    await connect();
    onEvents = () => Promise.reject(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(POLL); // failed; next in 4s
    onEvents = nothingNew;
    await vi.advanceTimersByTimeAsync(2 * POLL); // succeeded; interval back to 2s
    expect(polls()).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL);
    expect(polls()).toBe(3);
  });

  it('reports retrying while polls fail and connected once one succeeds', async () => {
    const onConnectionChange = vi.fn();
    await connect({ onConnectionChange });
    onEvents = () => Promise.reject(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(POLL);
    expect(onConnectionChange).toHaveBeenLastCalledWith('retrying');
    onEvents = nothingNew;
    await vi.advanceTimersByTimeAsync(2 * POLL);
    expect(onConnectionChange).toHaveBeenLastCalledWith('connected');
  });
});

describe('hidden tab', () => {
  it('polls at the slowest interval while the tab is hidden', async () => {
    setTabHidden(true);
    await connect();
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF - 1);
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(1);
  });

  // Without the reset, restoring a tab could leave it up to thirty seconds
  // stale while looking live.
  it('resets the backoff and polls immediately on return', async () => {
    setTabHidden(true);
    await connect();
    setTabHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1); // immediately, not thirty seconds out
    await vi.advanceTimersByTimeAsync(POLL);
    expect(polls()).toBe(2); // and back on the normal interval
  });

  it('ignores visibility changes after dispose', async () => {
    const server = await connect();
    server.dispose();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF);
    expect(polls()).toBe(0);
  });
});

describe('dispose', () => {
  it('stops the poll loop', async () => {
    const server = await connect();
    // Poll once first: without this, zero-polls-after-dispose is also what an
    // implementation that never scheduled anything would produce.
    await vi.advanceTimersByTimeAsync(POLL);
    expect(polls()).toBe(1);

    server.dispose();
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF);
    expect(polls()).toBe(1);
  });

  // A listener left on `document` outlives the connection and keeps its whole
  // closure alive -- one leak per match navigated to, for the life of the tab.
  // It has no *behavioural* symptom, because `disposed` already stops the
  // loop the handler would restart, so the registration itself is the only
  // thing that can be observed.
  it('removes its visibilitychange listener', async () => {
    const removed = vi.spyOn(document, 'removeEventListener');
    const server = await connect();
    server.dispose();
    expect(removed).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removed.mockRestore();
  });

  // StrictMode produces exactly this: a poll in flight when the route tears
  // down. Whoever constructed the server disposes it; the late response must
  // not restart the loop or reach a listener.
  it('does not reschedule or deliver when a poll resolves after dispose', async () => {
    const server = await connect();
    const listener = vi.fn();
    server.subscribe(listener);

    const inFlight = deferred<Response>();
    onEvents = () => inFlight.promise;
    await vi.advanceTimersByTimeAsync(POLL); // the poll leaves...
    server.dispose(); // ...the route unmounts...
    inFlight.resolve(json({ seq: 1, events: moved, state: state1 })); // ...then it lands
    await vi.advanceTimersByTimeAsync(10 * MAX_BACKOFF);

    expect(listener).toHaveBeenCalledTimes(1); // dispose cleared the listeners
    expect(polls()).toBe(1); // and nothing rescheduled
  });
});
