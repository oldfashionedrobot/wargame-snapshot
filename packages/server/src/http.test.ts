import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type {
  Command,
  CommandResult,
  Coordinate,
  ErrorResponse,
  EventsResponse,
  Facing,
  GuestResponse,
  MapPreview,
  MapSummary,
  MatchSummary,
  MeResponse,
  PlayerId,
  StateResponse,
} from '@wargame/shared';
import { exploreMovement, getUnitType } from '@wargame/shared';
import { route } from '@wargame/shared/testing';
import { getMap } from './maps';
import { createMatchState, PLAYERS } from './matchState';
import { createDb, migrate } from './db';
import { createServer } from './http';
import type { ServerOptions } from './http';
import { GUEST_LIFETIME_MS, GUEST_RENEWAL_AGE_MS } from './guest';

// Black box on purpose. Nothing below knows how a URL is dispatched, so the
// suite is unchanged by rewriting the routing underneath it -- which it has
// already survived once.
//
// One server for the file, one in-memory database inside it. Isolation is per
// *match*, not per test: every test that mutates creates its own, and the list
// assertions are written to tolerate the others' rows.

// Inferred rather than annotated as Bun's `Server`, which is generic over its
// websocket data -- this stays right whatever createServer returns.
let server: Awaited<ReturnType<typeof createServer>>;
// This deployment's build, as a release would set it.
const BUILD = 42;
const NONE = { count: Infinity, windowMs: 1 };
const MINUTE = 60_000;
let base: string;
// The guest every helper below speaks as. Tests about identity use `fetch` raw.
let token: string;
let dist: string;

beforeAll(async () => {
  // A fixture client build, never the real one: `packages/client/dist` is
  // gitignored and `bun run test` does not build it, so tests written against
  // it mean different things depending on whether someone ran a build. With
  // no dist the '/*' route answers "client not built" for everything, which
  // made the routing tests below pass even with the '/api/*' route deleted --
  // measured, not supposed.
  dist = mkdtempSync(join(tmpdir(), 'wargame-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><h1>fixture index</h1>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'const artifact = "raw";');
  writeFileSync(
    join(dist, 'assets', 'app-abc123.js.br'),
    brotliCompressSync('const artifact = "br";'),
  );
  writeFileSync(join(dist, 'assets', 'app-abc123.js.gz'), gzipSync('const artifact = "gz";'));
  writeFileSync(join(dist, 'assets', 'plain-def456.js'), 'const artifact = "plain";');

  // Port 0 lets the OS pick, so a running dev server cannot collide with this
  // one, and `:memory:` keeps the real development database out of reach. All
  // three are arguments rather than process.env, which is what lets this be a
  // plain static import with no ordering to get wrong. No limits: this suite
  // makes many matches as one guest from one address, and the tests about
  // limits each build a server of their own.
  server = await createServer({
    port: 0,
    database: await freshDatabase(),
    clientDist: dist,
    build: BUILD,
    limits: { unfinishedMatches: Infinity, creates: NONE, commands: NONE, ceiling: NONE },
  });
  base = server.url.origin;
  token = await mintGuest(base);
});

afterAll(async () => {
  await server.stop(true);
  rmSync(dist, { recursive: true, force: true });
});

// Migrated here because the server never migrates.
async function freshDatabase() {
  const database = await createDb(':memory:');
  await migrate(database);
  return database;
}

// A server of its own, for a test that needs options the shared one lacks.
async function withServer(
  options: ServerOptions,
  test: (origin: string) => Promise<void>,
): Promise<void> {
  const own = await createServer({
    port: 0,
    database: await freshDatabase(),
    clientDist: dist,
    ...options,
  });
  try {
    await test(own.url.origin);
  } finally {
    await own.stop(true);
  }
}

async function mintGuest(at: string): Promise<string> {
  const response = await fetch(`${at}/api/auth/guest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return ((await response.json()) as GuestResponse).token;
}

const asGuest = (init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
};

const get = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${base}${path}`, asGuest(init));

const postJson = (path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...asGuest({ headers: { 'content-type': 'application/json' } }),
    method: 'POST',
    body: JSON.stringify(body),
  });

async function newMatch(): Promise<MatchSummary> {
  return (await postJson('/api/matches')).json() as Promise<MatchSummary>;
}

/**
 * A unit that can legally step one tile forward, and the command that does it --
 * asked of the rulebook rather than assumed.
 *
 * ⚠️ **Hardcoding it has now broken three times** -- once when the army left the
 * maps, once when the boards were resized, and once when a formation grew a
 * second rank and put a friend on the square the front unit would have stepped
 * into. The army is a dial and becomes a player's choice, so the durable
 * question is *who can move one tile*, which `exploreMovement` answers.
 *
 * ⚠️ One square, not a unit's whole range: these are tests about the HTTP
 * surface, and a route a gun carriage cannot afford would fail them for the
 * wrong reason.
 *
 * The path is a walkable route rather than two endpoints, which is what a
 * client actually sends -- validatePath walks every step in 6c.
 */
const OPENING = createMatchState(getMap('classic'));

interface Step {
  id: string;
  from: Coordinate;
  to: Coordinate;
  facing: Facing;
}

function oneStepForward(owner: PlayerId): Step {
  for (const unit of OPENING.units) {
    if (unit.owner !== owner) continue;
    const { movementRange, movementType } = getUnitType(unit.unitTypeId);
    const { reachable } = exploreMovement(OPENING, unit, movementRange, movementType);
    // Forward is the way the army was deployed facing, so this holds for
    // either side of the board.
    const forward = unit.facing === 'north' ? 1 : -1;
    const to: Coordinate = { col: unit.position.col, row: unit.position.row + forward };
    if (!reachable.some((tile) => tile.col === to.col && tile.row === to.row)) continue;
    return { id: unit.id, from: unit.position, to, facing: unit.facing };
  }
  throw new Error(`no ${owner} unit can step one tile forward on the starting board`);
}

const stepCommand = (step: Step): Command => ({
  type: 'move',
  facing: step.facing,
  unitId: step.id,
  path: route(step.from, step.to),
});

const MOVER = oneStepForward(OPENING.currentTurn);
const legalMove = stepCommand(MOVER);
const replyMove = (() => {
  const other = OPENING.players.find((player) => player.id !== OPENING.currentTurn);
  if (!other) throw new Error('the starting board seats one player');
  return stepCommand(oneStepForward(other.id));
})();

describe('GET /api/matches', () => {
  it('lists matches', async () => {
    const response = await get('/api/matches');
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it('includes a match that was just created', async () => {
    const { id } = await newMatch();
    const listed = (await (await get('/api/matches')).json()) as MatchSummary[];
    expect(listed.map((match) => match.id)).toContain(id);
  });
});

describe('POST /api/matches', () => {
  it('creates one and answers 201 with its summary', async () => {
    const response = await postJson('/api/matches');
    expect(response.status).toBe(201);

    const match = (await response.json()) as MatchSummary;
    expect(match.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(match.seq).toBe(0);
    expect(match.currentTurn).toBe(PLAYERS[0].id); // seat 1 moves first
    expect(match.createdAt).toBeGreaterThan(0);
    expect(match.mapId).toBe('classic'); // the default, with no body sent
  });

  // ⚠️ What a client from before modes and clocks sends, and must still get.
  it('makes a body with nothing in it a hot-seat game with no clock', async () => {
    const { id, code } = (await (await postJson('/api/matches', {})).json()) as MatchSummary;
    expect(code).toBeNull();
    const state = (await (await get(`/api/matches/${id}/state`)).json()) as StateResponse;
    expect(state).toMatchObject({ you: [1, 2], code: null, clocks: null });
  });

  it('creates on a named map', async () => {
    const response = await postJson('/api/matches', { mapId: 'lakeland' });
    expect(response.status).toBe(201);
    expect(((await response.json()) as MatchSummary).mapId).toBe('lakeland');
  });

  // Absent and wrong are different answers: a client that sends no body at all
  // still gets a match, but one that names a map nobody has is confused.
  it('refuses a map that does not exist', async () => {
    const response = await postJson('/api/matches', { mapId: 'atlantis' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorResponse).error).toMatch(/unknown map/);
  });

  it('refuses a mapId that is not a string', async () => {
    expect((await postJson('/api/matches', { mapId: 7 })).status).toBe(400);
  });

  it('creates a remote game waiting under a code, in the seat asked for', async () => {
    const response = await postJson('/api/matches', { mode: 'remote', seat: 2 });
    expect(response.status).toBe(201);
    const { id, code } = (await response.json()) as MatchSummary;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await (await get(`/api/matches/${id}/state`)).json()).toMatchObject({ you: [2], code });
    // Its state is built, but nobody plays until somebody joins.
    expect((await postJson(`/api/matches/${id}/commands`, { type: 'endTurn' })).status).toBe(422);
  });

  it('refuses a mode, a seat or a name it cannot use', async () => {
    for (const body of [
      { mode: 'solo' },
      { mode: 'remote', seat: PLAYERS.length + 1 },
      { mode: 'remote', seat: 1.5 },
      { name: 7 },
      { clock: 7 },
      { clock: '5' },
    ]) {
      const response = await postJson('/api/matches', body);
      expect([body, response.status]).toEqual([body, 400]);
    }
  });

  it('keeps the name sent, trimmed and bounded, for the menus to offer next time', async () => {
    const meant = 'x'.repeat(100);
    expect((await postJson('/api/matches', { name: `  ${meant}  ` })).status).toBe(201);
    const { name } = (await (await get('/api/me')).json()) as MeResponse;
    expect(name.length).toBeGreaterThan(0);
    expect(meant.startsWith(name) && name.length < meant.length).toBe(true);
  });
});

// ⚠️ Nothing runs between requests, so a clock runs out when somebody looks.
describe('the clock', () => {
  it('reports both clocks, and ends the game on the first poll after one runs out', async () => {
    let clock = Date.now();
    await withServer({ now: () => clock }, async (origin) => {
      const headers = {
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      };
      const created = await fetch(`${origin}/api/matches`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clock: 5 }),
      });
      const { id } = (await created.json()) as MatchSummary;
      const state = await fetch(`${origin}/api/matches/${id}/state`, { headers });
      expect(((await state.json()) as StateResponse).clocks).toEqual([5 * MINUTE, 5 * MINUTE]);

      clock += 5 * MINUTE;
      const poll = await fetch(`${origin}/api/matches/${id}/events?since=0`, { headers });
      const answer = (await poll.json()) as EventsResponse;
      expect(answer.state?.winner).toBe(PLAYERS[1].id);
      expect(answer.clocks).toEqual([0, 5 * MINUTE]);
      expect(answer.endedBy).toBe('clock');
    });
  });
});

describe('GET /api/me', () => {
  it('offers a guest with no name a generated one', async () => {
    const headers = { authorization: `Bearer ${await mintGuest(base)}` };
    const response = await fetch(`${base}/api/me`, { headers });
    expect(response.status).toBe(200);
    expect(((await response.json()) as MeResponse).name).not.toBe('');
  });
});

describe('POST /api/matches/join', () => {
  let joiner: Record<string, string>;
  beforeAll(async () => {
    joiner = {
      authorization: `Bearer ${await mintGuest(base)}`,
      'content-type': 'application/json',
    };
  });
  const join = (body: unknown, headers = joiner) =>
    fetch(`${base}/api/matches/join`, { method: 'POST', headers, body: JSON.stringify(body) });
  const waiting = async () =>
    (await (await postJson('/api/matches', { mode: 'remote' })).json()) as MatchSummary;

  it('joins a waiting game by its code, however it is typed, and starts it', async () => {
    const { id, code } = await waiting();
    const typed = ` ${code!.slice(0, 3).toLowerCase()}-${code!.slice(3)} `;
    const response = await join({ code: typed });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id, code: null });

    const state = await fetch(`${base}/api/matches/${id}/state`, { headers: joiner });
    expect(await state.json()).toMatchObject({ you: [2], code: null });
    // ⚠️ How the creator learns of it: a join moves no seq, so a caught-up
    // poll carries whether the game still waits.
    const poll = (await (await get(`/api/matches/${id}/events?since=0`)).json()) as EventsResponse;
    expect(poll).toEqual({ seq: 0, events: [], code: null, opponentHere: true });
  });

  it('answers 404 for a code nothing waits under', async () => {
    // O is never drawn, so no game can be waiting under this.
    const response = await join({ code: 'OOOOOO' });
    expect(response.status).toBe(404);
    expect(typeof ((await response.json()) as ErrorResponse).error).toBe('string');
  });

  it('refuses the creator its own game, and a body that names no code', async () => {
    const { code } = await waiting();
    expect((await postJson('/api/matches/join', { code })).status).toBe(409);
    expect((await join({})).status).toBe(400);
    expect((await join({ code, name: 7 })).status).toBe(400);
  });

  // Joining starts a game, so it spends what creating one does.
  it('spends from the allowance creating does', async () => {
    const limits = { creates: { count: 1, windowMs: MINUTE } };
    await withServer({ limits }, async (origin) => {
      const headers = async () => ({
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      });
      const created = await fetch(`${origin}/api/matches`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ mode: 'remote' }),
      });
      const { code } = (await created.json()) as MatchSummary;
      const joined = await fetch(`${origin}/api/matches/join`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ code }),
      });
      expect(joined.status).toBe(429);
    });
  });
});

describe('POST /api/matches/:id/cancel', () => {
  it('cancels a waiting game, which leaves the list', async () => {
    const { id } = (await (
      await postJson('/api/matches', { mode: 'remote' })
    ).json()) as MatchSummary;
    expect((await postJson(`/api/matches/${id}/cancel`)).status).toBe(204);
    const listed = (await (await get('/api/matches')).json()) as MatchSummary[];
    expect(listed.map((match) => match.id)).not.toContain(id);
    expect((await get(`/api/matches/${id}/state`)).status).toBe(404);
  });

  it('refuses a game that has started', async () => {
    const { id } = await newMatch();
    const response = await postJson(`/api/matches/${id}/cancel`);
    expect(response.status).toBe(409);
    expect(typeof ((await response.json()) as ErrorResponse).error).toBe('string');
  });
});

// A shared cache must not keep one guest's answer for another, and a browser's
// copy of a board is stale by the next command.
describe('caching the API', () => {
  it('stores nothing, refusals included', async () => {
    for (const response of [await get('/api/matches'), await get('/api/matches/nope/state')]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});

describe('GET /api/health', () => {
  it('answers with nothing to say, to anyone, and names the build', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(204);
    expect(response.headers.get('x-build')).toBe(String(BUILD));
  });
});

describe('GET /api/maps', () => {
  it('names every map a match can be started on', async () => {
    const response = await get('/api/maps');
    expect(response.status).toBe(200);

    const maps = (await response.json()) as MapSummary[];
    expect(maps.map((map) => map.id)).toContain('classic');
    expect(maps.every((map) => map.name.length > 0)).toBe(true);
    expect(maps.every((map) => map.width > 0 && map.height > 0)).toBe(true);
  });

  // Two routes describe the same board, so they are held to agreeing.
  it('gives each map the size of the board its preview draws', async () => {
    const maps = (await (await get('/api/maps')).json()) as MapSummary[];
    for (const map of maps) {
      const { state } = (await (await get(`/api/maps/${map.id}/preview`)).json()) as MapPreview;
      expect(`${map.id} ${map.width}x${map.height}`).toBe(
        `${map.id} ${state.grid[0].length}x${state.grid.length}`,
      );
    }
  });
});

describe('GET /api/maps/:id/preview', () => {
  it('returns the board a match on that map would start from', async () => {
    const response = await get('/api/maps/classic/preview');
    expect(response.status).toBe(200);

    const preview = (await response.json()) as MapPreview;
    expect(preview.id).toBe('classic');
    expect(preview.name.length).toBeGreaterThan(0);

    // Coherent rather than a fixed size, like the state endpoint above: the
    // dimensions belong to the map, and pinning them here would fail on a map
    // edit while saying nothing about this route.
    const { state } = preview;
    const width = state.grid[0]?.length ?? 0;
    expect(state.grid.length).toBeGreaterThan(0);
    expect(state.grid.every((row) => row.length === width)).toBe(true);
    // ⚠️ **The army is the half worth asserting.** Rows alone would have been a
    // cheaper endpoint; this one exists to answer *board plus deployment*, and
    // a response that forgot the units would still look like a valid board.
    expect(new Set(state.units.map((unit) => unit.owner)).size).toBe(2);
  });

  // ⚠️ **Stores nothing**, which is the whole reason this is not "create a
  // match and read it back". Asserted through the lobby, because that is where
  // a stray match would show up and is the thing that would actually hurt.
  it('creates no match', async () => {
    const before = ((await (await get('/api/matches')).json()) as MatchSummary[]).length;
    expect((await get('/api/maps/classic/preview')).status).toBe(200);
    expect((await get('/api/maps/meadow/preview')).status).toBe(200);
    const after = ((await (await get('/api/matches')).json()) as MatchSummary[]).length;
    expect(after).toBe(before);
  });

  // ⚠️ 404 here where create answers 400, and deliberately: looking at a board
  // that does not exist is a missing resource, building on one is a bad
  // argument. Pinned because the client tells the two apart.
  it('404s an id no map has', async () => {
    const response = await get('/api/maps/atlantis/preview');
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error.length).toBeGreaterThan(0);
  });

  // Names every object has, which a lookup on a plain object would find.
  it('404s, and refuses to create on, an id every object inherits', async () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect([id, (await get(`/api/maps/${id}/preview`)).status]).toEqual([id, 404]);
      expect([id, (await postJson('/api/matches', { mapId: id })).status]).toEqual([id, 400]);
    }
  });
});

describe('GET /api/matches/:id/state', () => {
  it('returns the starting board at seq 0', async () => {
    const { id } = await newMatch();
    const response = await get(`/api/matches/${id}/state`);
    expect(response.status).toBe(200);

    const { seq, state } = (await response.json()) as StateResponse;
    expect(seq).toBe(0);
    expect(state.currentTurn).toBe(PLAYERS[0].id);

    // The board's size belongs to whatever map the server built this from, so
    // assert that the board is *coherent* rather than that it is 8 wide --
    // which would fail the day the default map changes while telling us
    // nothing about the endpoint. Rectangular and fully occupied-in-bounds
    // catches more than a dimension ever did.
    const height = state.grid.length;
    const width = state.grid[0]?.length ?? 0;
    expect(height).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
    expect(state.grid.every((row) => row.length === width)).toBe(true);
    for (const unit of state.units) {
      expect(unit.position.row).toBeGreaterThanOrEqual(0);
      expect(unit.position.row).toBeLessThan(height);
      expect(unit.position.col).toBeGreaterThanOrEqual(0);
      expect(unit.position.col).toBeLessThan(width);
    }

    // Both sides start with something to move. Asserting a count instead would
    // fail every time the starting roster is tuned, which says nothing about
    // whether the endpoint works.
    for (const player of state.players) {
      expect(state.units.some((unit) => unit.owner === player.id)).toBe(true);
    }
    expect(state.units.every((unit) => !unit.hasActed)).toBe(true);
  });

  it('404s an unknown match', async () => {
    expect((await get('/api/matches/nope/state')).status).toBe(404);
  });
});

describe('GET /api/matches/:id/events', () => {
  it('returns nothing to replay on a fresh match', async () => {
    const { id } = await newMatch();
    const response = await get(`/api/matches/${id}/events?since=0`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as EventsResponse;
    expect(body.seq).toBe(0);
    expect(body.events).toEqual([]);
    // No board on a caught-up poll: the client has this state already and
    // discards a second copy, so sending one is pure waste on every poll.
    expect(body.state).toBeUndefined();
  });

  it('returns everything after the given seq', async () => {
    const { id } = await newMatch();
    await postJson(`/api/matches/${id}/commands`, legalMove);

    const body = (await (await get(`/api/matches/${id}/events?since=0`)).json()) as EventsResponse;
    expect(body.seq).toBe(1);
    // The move landed; a trailing `turnEnded` depends on `ACTIONS_PER_TURN`.
    expect(body.events[0].type).toBe('unitMoved');
    // Events never travel without the state they produced -- and the state is
    // the *post*-move one, which the unit's position is what shows. currentTurn
    // could not show it: whether a move ends a turn is the budget's business.
    expect(body.state?.units.find((unit) => unit.id === MOVER.id)?.position).toEqual(MOVER.to);

    // Asking from the current seq is the steady-state poll: nothing new, and
    // therefore no board either.
    const caughtUp = (await (
      await get(`/api/matches/${id}/events?since=1`)
    ).json()) as EventsResponse;
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.state).toBeUndefined();
  });

  it('400s a negative or non-integer since', async () => {
    const { id } = await newMatch();
    expect((await get(`/api/matches/${id}/events?since=-1`)).status).toBe(400);
    expect((await get(`/api/matches/${id}/events?since=abc`)).status).toBe(400);
    expect((await get(`/api/matches/${id}/events?since=1.5`)).status).toBe(400);
  });

  it('404s an unknown match', async () => {
    expect((await get('/api/matches/nope/events?since=0')).status).toBe(404);
  });
});

describe('POST /api/matches/:id/commands', () => {
  it('accepts a legal command and answers 200 with events and state', async () => {
    const { id } = await newMatch();
    const response = await postJson(`/api/matches/${id}/commands`, legalMove);
    expect(response.status).toBe(200);

    const result = (await response.json()) as CommandResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seq).toBe(1);
    // The move landed; a trailing `turnEnded` depends on `ACTIONS_PER_TURN`.
    expect(result.events[0].type).toBe('unitMoved');
    expect(result.state.units.find((unit) => unit.id === MOVER.id)?.position).toEqual(MOVER.to);
  });

  // ⚠️ Hot-seat stamps the actor from whose turn it is, and this is the one
  // test that can tell that apart from "the opener, forever": after End Turn
  // the reply is accepted and the opener's own move is refused.
  it('stamps whoever is to move: after End Turn the other side moves, and the opener may not', async () => {
    const { id } = await newMatch();
    expect((await postJson(`/api/matches/${id}/commands`, { type: 'endTurn' })).status).toBe(200);
    expect((await postJson(`/api/matches/${id}/commands`, legalMove)).status).toBe(422);
    expect((await postJson(`/api/matches/${id}/commands`, replyMove)).status).toBe(200);
  });

  // 422, not 200: well-formed, and refused on its merits. Distinct from the
  // 400s above, which mean the body was never a command at all.
  it('answers 422 when the rulebook refuses', async () => {
    const { id } = await newMatch();
    // A perfectly walkable route, refused on distance alone -- which keeps
    // this testing the rulebook rather than the path checker 6c adds.
    const outOfRange: Command = {
      type: 'move',
      facing: 'north',
      unitId: MOVER.id,
      path: route(MOVER.from, { col: MOVER.from.col + 7, row: MOVER.from.row + 9 }),
    };

    const response = await postJson(`/api/matches/${id}/commands`, outOfRange);
    expect(response.status).toBe(422);

    // The wording belongs to shared/, so assert the envelope, not the reason.
    const body = (await response.json()) as ErrorResponse;
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('400s a malformed body before the authority sees it', async () => {
    const { id } = await newMatch();
    const response = await fetch(
      `${base}/api/matches/${id}/commands`,
      asGuest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('400s well-formed JSON that is not a command', async () => {
    const { id } = await newMatch();
    expect((await postJson(`/api/matches/${id}/commands`, { type: 'nope' })).status).toBe(400);
    expect((await postJson(`/api/matches/${id}/commands`, { type: 'move' })).status).toBe(400);
    expect((await postJson(`/api/matches/${id}/commands`, 'a string')).status).toBe(400);
  });

  it('404s an unknown match', async () => {
    expect((await postJson('/api/matches/nope/commands', legalMove)).status).toBe(404);
  });
});

describe('routing', () => {
  it('404s an unrecognised /api path', async () => {
    expect((await get('/api/garbage')).status).toBe(404);
    expect((await get('/api/matches/some-id/garbage')).status).toBe(404);
    expect((await get('/api/matches/some-id/state/extra')).status).toBe(404);
  });

  // Currently 404 rather than 405. Recorded so a router that answers 405
  // instead is a visible decision rather than a silent change.
  it('404s a method the endpoint does not serve', async () => {
    expect((await get('/api/matches', { method: 'DELETE' })).status).toBe(404);
    expect((await get('/api/matches/some-id/state', { method: 'POST' })).status).toBe(404);
  });

  // ⚠️ To the start, not the page: the client's asset paths are relative, so a
  // page served from a deeper path could not find them. There are no deep
  // links -- the client keeps its routes in memory.
  it('sends a non-api path that is no file to the start, not the api 404', async () => {
    const response = await get('/some/old/route', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(await (await get('/some/old/route')).text()).toContain('fixture index');
  });
});

// Distinct plaintext inside each variant is what proves *which* file was
// served: bun's fetch decodes Content-Encoding transparently while keeping the
// header, so body text distinguishes them where byte counts could not.
describe('the client build', () => {
  const getAsset = (path: string, accept: string): Promise<Response> =>
    fetch(`${base}${path}`, { headers: { 'accept-encoding': accept } });

  // The page, an asset, and the redirect from a path that is no file.
  it('is never framed, sniffed or sent with a referrer', async () => {
    for (const path of ['/', '/assets/app-abc123.js', '/no/such/page']) {
      const { headers } = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect([path, headers.get('x-frame-options')]).toEqual([path, 'DENY']);
      expect(headers.get('x-content-type-options')).toBe('nosniff');
      expect(headers.get('referrer-policy')).toBe('no-referrer');
      expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(headers.get('permissions-policy')).toContain('camera=()');
    }
  });

  it('serves the brotli variant to a client that accepts it', async () => {
    const response = await getAsset('/assets/app-abc123.js', 'gzip, br');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toBe('const artifact = "br";');
  });

  it('serves gzip when brotli is not accepted', async () => {
    const response = await getAsset('/assets/app-abc123.js', 'gzip');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.text()).toBe('const artifact = "gz";');
  });

  it('serves the original when neither is accepted', async () => {
    const response = await getAsset('/assets/app-abc123.js', 'identity');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('const artifact = "raw";');
  });

  it('falls through to the original when no variant exists', async () => {
    const response = await getAsset('/assets/plain-def456.js', 'gzip, br');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('const artifact = "plain";');
  });

  it('marks anything under /assets immutable and everything else no-cache', async () => {
    const asset = await getAsset('/assets/app-abc123.js', 'br');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('vary')).toBe('Accept-Encoding');

    // index.html is the one file whose name never changes, so it revalidates.
    const index = await getAsset('/', 'br');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('fixture index');
  });
});

// A client on itch's CDN is cross-origin to this server, so every answer -- a
// refusal and a missing match included -- has to be readable from there, and
// a write has to be allowed through its preflight.
describe('CORS', () => {
  it('lets any origin read every API answer, errors included', async () => {
    const { id } = await newMatch();
    const answers = [
      await get('/api/maps'),
      await get('/api/matches/no-such-match/state'),
      await get(`/api/matches/${id}/events?since=-1`),
      await postJson(`/api/matches/${id}/commands`, { ...legalMove, unitId: 'nobody' }),
      await get('/api/no-such-endpoint'),
    ];
    expect(answers.map((response) => response.status)).toEqual([200, 404, 400, 422, 404]);
    for (const response of answers) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('answers a preflight on any API path', async () => {
    for (const path of ['/api/matches', '/api/matches/some-id/commands']) {
      const response = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://html-classic.itch.zone',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      const headers = response.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
      expect(headers).toContain('authorization');
      expect(headers).toContain('content-type');
    }
  });

  // A client compares this with its own to know it is out of date, so it rides
  // every answer -- errors too -- and is readable from another origin.
  it('reports the build on every API answer, readable cross-origin', async () => {
    for (const path of ['/api/maps', '/api/matches/no-such-match/state', '/api/garbage']) {
      const response = await get(path);
      expect(response.headers.get('x-build')).toBe(String(BUILD));
      expect(response.headers.get('access-control-expose-headers')).toContain('X-Build');
    }
  });

  // ⚠️ Plain text is a request any web page can send without a preflight.
  it('refuses a POST that is not JSON', async () => {
    const { id } = await newMatch();
    const asText = (path: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(legalMove),
      });
    expect((await asText(`/api/matches/${id}/commands`)).status).toBe(415);
    expect((await asText('/api/matches')).status).toBe(415);
    expect((await fetch(`${base}/api/matches`, { method: 'POST' })).status).toBe(415);
  });
});

// Every route that names a match, as `[method, path]`.
const matchRoutes = (id: string): [string, string][] => [
  ['GET', `/api/matches/${id}/state`],
  ['GET', `/api/matches/${id}/events?since=0`],
  ['POST', `/api/matches/${id}/commands`],
  ['POST', `/api/matches/${id}/cancel`],
];

// A request with the headers given and nothing added. A POST carries a legal
// command, so only who is asking can be what refuses it.
const ask = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(
    `${base}${path}`,
    method === 'POST'
      ? {
          method,
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(legalMove),
        }
      : { method, headers },
  );

describe('guests', () => {
  it('mints a token for anyone who asks', async () => {
    const response = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(201);
    expect(typeof ((await response.json()) as GuestResponse).token).toBe('string');
  });

  // Default-deny, checked from outside: every route a match lives behind
  // refuses a request that names no guest, and says how to become one.
  it('refuses every match route without a token, with a 401 a client can read', async () => {
    const { id } = await newMatch();
    const protectedRoutes: [string, string][] = [
      ['GET', '/api/matches'],
      ['POST', '/api/matches'],
      ['POST', '/api/matches/join'],
      ['GET', '/api/me'],
      ...matchRoutes(id),
      ['POST', `/api/matches/${id}/archive`],
    ];
    for (const [method, path] of protectedRoutes) {
      const response = await ask(method, path);
      expect([path, response.status]).toEqual([path, 401]);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('needs no token for what anyone may see', async () => {
    expect((await fetch(`${base}/api/maps`)).status).toBe(200);
    expect((await fetch(`${base}/api/maps/classic/preview`)).status).toBe(200);
  });

  it('refuses a token that was tampered with, or signed with another key', async () => {
    const list = (with_: string) =>
      fetch(`${base}/api/matches`, { headers: { authorization: `Bearer ${with_}` } });
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect((await list(flipped)).status).toBe(401);
    expect((await list('not-a-token')).status).toBe(401);

    await withServer({ guestKey: 'another key' }, async (elsewhere) => {
      expect((await list(await mintGuest(elsewhere))).status).toBe(401);
    });
  });

  it('stops honouring a token once its lifetime is over', async () => {
    let clock = Date.now();
    await withServer({ now: () => clock }, async (timed) => {
      const minted = await mintGuest(timed);
      const list = () =>
        fetch(`${timed}/api/matches`, { headers: { authorization: `Bearer ${minted}` } });
      clock += GUEST_LIFETIME_MS - 1;
      expect((await list()).status).toBe(200);
      clock += 1;
      expect((await list()).status).toBe(401);
    });
  });

  // ⚠️ A guest lasts while it plays: an answer to a token old enough carries a
  // replacement for the same guest, with a whole lifetime of its own.
  it('renews a token once it is old enough, for the same guest', async () => {
    let clock = Date.now();
    await withServer({ now: () => clock }, async (timed) => {
      const minted = await mintGuest(timed);
      const matchesAs = (token: string, init: RequestInit = {}) =>
        fetch(`${timed}/api/matches`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        });
      const { id } = (await (
        await matchesAs(minted, { method: 'POST', body: '{}' })
      ).json()) as MatchSummary;

      expect((await matchesAs(minted)).headers.get('x-guest-token')).toBeNull();

      clock += GUEST_RENEWAL_AGE_MS;
      const due = await matchesAs(minted);
      const renewed = due.headers.get('x-guest-token');
      expect(renewed).toBeTruthy();
      expect(due.headers.get('access-control-expose-headers')).toContain('X-Guest-Token');

      // At the old token's end it is refused, and its renewal is the same guest.
      clock += GUEST_LIFETIME_MS - GUEST_RENEWAL_AGE_MS;
      expect((await matchesAs(minted)).status).toBe(401);
      const listed = (await (await matchesAs(renewed ?? '')).json()) as MatchSummary[];
      expect(listed.map((match) => match.id)).toEqual([id]);
    });
  });
});

describe('POST /api/matches/:id/archive', () => {
  // ⚠️ Kept for an admin, closed to players: archiving is match-wide, so either
  // player of a shared game could otherwise erase it from the other's list.
  it('answers 403 to everyone, and touches nothing', async () => {
    const { id } = await newMatch();
    for (const matchId of [id, 'no-such-match']) {
      const response = await postJson(`/api/matches/${matchId}/archive`);
      expect([matchId, response.status]).toEqual([matchId, 403]);
      expect(typeof ((await response.json()) as ErrorResponse).error).toBe('string');
    }
    const listed = (await (await get('/api/matches')).json()) as MatchSummary[];
    expect(listed.map((match) => match.id)).toContain(id);
  });
});

describe('the cap on unfinished matches', () => {
  it('refuses one more past it, until one is finished -- and only for that guest', async () => {
    await withServer({ limits: { unfinishedMatches: 2 } }, async (origin) => {
      const asked = async () => ({
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      });
      const post = (path: string, headers: Record<string, string>) =>
        fetch(`${origin}/api/matches${path}`, { method: 'POST', headers, body: '{}' });

      const guest = await asked();
      const { id } = (await (await post('', guest)).json()) as MatchSummary;
      expect((await post('', guest)).status).toBe(201);

      const refused = await post('', guest);
      expect(refused.status).toBe(409);
      expect(typeof ((await refused.json()) as ErrorResponse).error).toBe('string');
      expect((await post('', await asked())).status).toBe(201);

      // Surrendering finishes a game, which is what makes room.
      const surrender = await fetch(`${origin}/api/matches/${id}/commands`, {
        method: 'POST',
        headers: guest,
        body: JSON.stringify({ type: 'surrender' }),
      });
      expect(surrender.status).toBe(200);
      expect((await post('', guest)).status).toBe(201);
    });
  });

  it('counts a join as it counts a create', async () => {
    await withServer({ limits: { unfinishedMatches: 1 } }, async (origin) => {
      const asked = async () => ({
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      });
      const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
        fetch(`${origin}/api/matches${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

      const created = await post('', await asked(), { mode: 'remote' });
      const { code } = (await created.json()) as MatchSummary;
      const full = await asked();
      expect((await post('', full)).status).toBe(201);
      expect((await post('/join', full, { code })).status).toBe(409);
    });
  });
});

describe('limits by address', () => {
  // A new guest per request, so that only the address is left in common.
  const fresh = async (origin: string, headers: Record<string, string> = {}) => ({
    ...headers,
    authorization: `Bearer ${await mintGuest(origin)}`,
    'content-type': 'application/json',
  });
  const create = (origin: string, headers: Record<string, string>) =>
    fetch(`${origin}/api/matches`, { method: 'POST', headers, body: '{}' });

  it('refuses new matches past the allowance, says when to come back, and lets go after', async () => {
    let clock = Date.now();
    const limits = { creates: { count: 2, windowMs: MINUTE } };
    await withServer({ limits, now: () => clock }, async (origin) => {
      expect((await create(origin, await fresh(origin))).status).toBe(201);
      expect((await create(origin, await fresh(origin))).status).toBe(201);

      const refused = await create(origin, await fresh(origin));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
      expect(refused.headers.get('access-control-allow-origin')).toBe('*');
      expect(((await refused.json()) as ErrorResponse).error).toContain('60 seconds');

      clock += MINUTE;
      expect((await create(origin, await fresh(origin))).status).toBe(201);
    });
  });

  // Counted before the body is read, so a flood of junk spends it too.
  it('refuses commands past the allowance, well-formed or not', async () => {
    const limits = { commands: { count: 1, windowMs: MINUTE } };
    await withServer({ limits }, async (origin) => {
      const guest = await fresh(origin);
      const { id } = (await (await create(origin, guest)).json()) as MatchSummary;
      const send = (body: string) =>
        fetch(`${origin}/api/matches/${id}/commands`, { method: 'POST', headers: guest, body });
      expect((await send(JSON.stringify(legalMove))).status).toBe(200);
      expect((await send('not json')).status).toBe(429);
    });
  });

  // ⚠️ Fly's edge sets the header in production; anywhere else a client could
  // write a new one on every request, so it is ignored unless trusted.
  it('keeps count by Fly-Client-IP only when told to trust it', async () => {
    const limits = { creates: { count: 1, windowMs: MINUTE } };
    const from = (address: string) => ({ 'fly-client-ip': address });
    for (const trustFlyClientIp of [true, false]) {
      await withServer({ limits, trustFlyClientIp }, async (origin) => {
        expect((await create(origin, await fresh(origin, from('10.0.0.1')))).status).toBe(201);
        const other = await create(origin, await fresh(origin, from('10.0.0.2')));
        expect([trustFlyClientIp, other.status]).toEqual([
          trustFlyClientIp,
          trustFlyClientIp ? 201 : 429,
        ]);
      });
    }
  });
});

describe('the ceiling on new matches', () => {
  it('refuses everyone once it is reached, saying when it reopens', async () => {
    const limits = { ceiling: { count: 1, windowMs: 24 * 60 * MINUTE } };
    await withServer({ limits, trustFlyClientIp: true }, async (origin) => {
      const from = async (address: string) => ({
        'fly-client-ip': address,
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      });
      const create = async (address: string) =>
        fetch(`${origin}/api/matches`, {
          method: 'POST',
          headers: await from(address),
          body: '{}',
        });

      expect((await create('10.0.0.1')).status).toBe(201);
      const refused = await create('10.0.0.2');
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe(String(24 * 60 * 60));
      expect(((await refused.json()) as ErrorResponse).error).toContain('24 hours');
    });
  });

  // Checked last, so a create refused for something else spends nothing of it.
  it('spends nothing on a create refused for another reason', async () => {
    const limits = { unfinishedMatches: 1, ceiling: { count: 2, windowMs: MINUTE } };
    await withServer({ limits }, async (origin) => {
      const guest = async () => ({
        authorization: `Bearer ${await mintGuest(origin)}`,
        'content-type': 'application/json',
      });
      const create = (headers: Record<string, string>, body = '{}') =>
        fetch(`${origin}/api/matches`, { method: 'POST', headers, body });

      const first = await guest();
      expect((await create(first)).status).toBe(201);
      expect((await create(first, '{"mapId":"atlantis"}')).status).toBe(400);
      expect((await create(first)).status).toBe(409);
      // The ceiling's second and last match, which either refusal would have spent.
      expect((await create(await guest())).status).toBe(201);
      expect((await create(await guest())).status).toBe(503);
    });
  });
});

describe('another guest', () => {
  let other: Record<string, string>;
  beforeAll(async () => {
    other = { authorization: `Bearer ${await mintGuest(base)}` };
  });

  it('does not see a match that is not theirs in their list', async () => {
    const { id } = await newMatch();
    const { id: own } = (await (await ask('POST', '/api/matches', other)).json()) as MatchSummary;
    const listed = (await (await ask('GET', '/api/matches', other)).json()) as MatchSummary[];
    expect(listed.map((match) => match.id)).toContain(own);
    expect(listed.map((match) => match.id)).not.toContain(id);
  });

  // ⚠️ "Not yours" is "no such match" -- the same 404 with the same body -- so
  // asking about an id says nothing about whether it exists.
  it('reaches a match that is not theirs no more than one that does not exist', async () => {
    const { id } = await newMatch();
    const answers = (matchId: string) =>
      Promise.all(
        matchRoutes(matchId).map(async ([method, path]) => {
          const response = await ask(method, path, other);
          return [response.status, await response.json()];
        }),
      );

    const theirs = await answers(id);
    for (const [status] of theirs) expect(status).toBe(404);
    expect(theirs).toEqual(await answers('no-such-match'));
    // and the command it sent did not land
    expect(((await (await get(`/api/matches/${id}/state`)).json()) as StateResponse).seq).toBe(0);
  });
});

describe('starting in production', () => {
  // A process of its own, since production is read once at import, in a
  // directory with no .env for bun to load on its own.
  const start = async (env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'http.ts')], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...env },
      stderr: 'pipe',
      stdout: 'ignore',
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    clearTimeout(timeout);
    // From the error itself: bun also prints the source around a throw.
    const missing = /error: production needs (.+)/.exec(stderr)?.[1].split(', ');
    return { code, missing };
  };

  it('refuses without the database or the signing key, naming what is missing', async () => {
    expect(await start({})).toEqual({
      code: 1,
      missing: ['DATABASE_URL', 'DATABASE_AUTH_TOKEN', 'GUEST_KEY'],
    });
    expect(await start({ DATABASE_URL: 'libsql://nowhere', DATABASE_AUTH_TOKEN: 'x' })).toEqual({
      code: 1,
      missing: ['GUEST_KEY'],
    });
  });
});

// ⚠️ Nothing sets a cookie. Identity will travel in a header, because no cookie
// survives a portal's iframe -- and a cookie on an immutable asset is one a
// shared cache could store and replay to everyone.
describe('cookies', () => {
  it('sets none, on the API or on the client build', async () => {
    for (const path of ['/api/maps', '/api/matches', '/', '/assets/app-abc123.js']) {
      expect((await get(path)).headers.get('set-cookie')).toBeNull();
    }
  });
});
