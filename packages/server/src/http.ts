import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunRequest } from 'bun';
import { CLOCK_MINUTES, parseCommand } from '@wargame/shared';
import type {
  CreateMatchRequest,
  ErrorResponse,
  GuestResponse,
  JoinMatchRequest,
  MapPreview,
  MapSummary,
  MeResponse,
} from '@wargame/shared';
import { createDb } from './db';
import type { Database } from './db';
import { readJoinCode } from './joinCode';
import { createMatchStore, MOVED } from './match';
import type { NewMatch } from './match';
import { createMatchState, PLAYERS } from './matchState';
import { readName } from './names';
import { listMaps, getMap } from './maps';
import type { GameMap } from './maps';
import { checkProductionConfig, DEFAULT_BUILD, DEFAULT_PORT, IS_PROD } from './const';
import { createGuests } from './guest';
import type { GuestId, Guests } from './guest';
import { createLimiter } from './limiter';
import type { Allowance } from './limiter';
import { createPresence } from './presence';

// fileURLToPath, not .pathname -- the latter percent-encodes, so a checkout
// under a path with a space would resolve to a directory that does not exist
// and every request would fall through to "client not built".
const CLIENT_DIST = resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));

export interface ServerOptions {
  /** Defaults to $PORT, then 3001. Pass 0 to let the OS pick a free one. */
  port?: number;
  /**
   * Defaults to opening $DATABASE_URL, then the local file. ⚠️ Never migrated
   * here -- `migrate.ts` is the one thing that changes the schema -- so a test
   * hands over a `:memory:` database it migrated itself.
   */
  database?: Database;
  /** Defaults to the checked-in client build. A fixture directory in tests. */
  clientDist?: string;
  /** This deployment's build number, on every API answer. Defaults to $BUILD, then 0. */
  build?: number;
  /** The key guest tokens are signed with. Defaults to $GUEST_KEY; see `signingKey`. */
  guestKey?: string;
  /** The server's clock, which token expiry reads. Defaults to `Date.now`. */
  now?: () => number;
  /** Any of `LIMITS` to replace, so a test can loosen or tighten them. */
  limits?: Partial<Limits>;
  /** Whether to take a request's address from `Fly-Client-IP`. Defaults to whether this is production. */
  trustFlyClientIp?: boolean;
}

/** What may be asked before a request is refused rather than served. */
export interface Limits {
  /** A guest's matches neither won nor archived; at this many, creating another is a 409. */
  unfinishedMatches: number;
  /** New matches from one address; past it, a 429. */
  creates: Allowance;
  /** Commands from one address; past it, a 429. */
  commands: Allowance;
  /** New matches from everyone together; past it, a 503. A circuit breaker, far above any real day. */
  ceiling: Allowance;
}

const MINUTE = 60_000;

const LIMITS: Limits = {
  unfinishedMatches: 20,
  creates: { count: 30, windowMs: 60 * MINUTE },
  commands: { count: 60, windowMs: MINUTE },
  ceiling: { count: 1000, windowMs: 24 * 60 * MINUTE },
};

export async function createServer({
  port,
  database,
  clientDist,
  build,
  guestKey,
  now = Date.now,
  limits,
  trustFlyClientIp = IS_PROD,
}: ServerOptions = {}) {
  checkProductionConfig();
  // Re-resolved so the traversal guard's `dist + sep` prefix check below works
  // whatever shape the caller passed (trailing separator, relative path).
  const dist = resolve(clientDist ?? CLIENT_DIST);
  const db = database ?? (await createDb());
  const matchesOf = (guest: GuestId) => createMatchStore(db, guest, { now });
  const headers = apiHeaders(build ?? DEFAULT_BUILD);
  const guests = createGuests(signingKey(guestKey), now);
  const { publicRoute, guestRoute } = routeWith(headers, guests, trustFlyClientIp);
  const caps = { ...LIMITS, ...limits };
  const limiter = createLimiter(now);
  const presence = createPresence(now);
  // ⚠️ Every look at a match is a heartbeat, the caught-up polls included --
  // from memory, so it costs no read -- and answers with the other side's.
  const withPresence = <T extends object>(matchId: string, guest: GuestId, answer: T) => {
    presence.heard(matchId, guest);
    return Response.json({ ...answer, opponentHere: presence.othersHere(matchId, guest) });
  };

  const server = Bun.serve({
    port: port ?? DEFAULT_PORT,
    // A command is only a few hundred bytes
    maxRequestBodySize: 64 * 1024,
    routes: {
      // For the host's health check. ⚠️ Touches no database: a check that read
      // one would spend from its quota every few seconds, and fail the machine
      // for an outage that restarting it cannot fix.
      '/api/health': {
        GET: publicRoute(async () => new Response(null, { status: 204 })),
      },

      '/api/maps': {
        GET: publicRoute(async () =>
          // Ids, names and sizes only: the rows are nobody else's business --
          // just their count leaves -- and a map's terrain reaches the client
          // inside the match state anyway.
          Response.json(
            listMaps().map(({ id, name, rows }) => ({
              id,
              name,
              width: rows[0].length,
              height: rows.length,
            })) satisfies MapSummary[],
          ),
        ),
      },

      // ⚠️ **A board to look at, and deliberately not a match.** The viewer
      // needs what a match on this map *would* start from; `createMatchState` is
      // pure, so answering costs nothing and stores nothing. The alternative --
      // creating a throwaway match and reading its state -- fills a guest's
      // lobby with boards nobody played on.
      '/api/maps/:id/preview': {
        GET: publicRoute(async (request) => {
          const map = findMap(request.params.id);
          if (!map) return notFound();
          return Response.json({
            id: map.id,
            name: map.name,
            state: createMatchState(map),
          } satisfies MapPreview);
        }),
      },

      // Anyone may become a guest; every match route then needs one.
      '/api/auth/guest': {
        POST: publicRoute(async () =>
          Response.json({ token: guests.mint() } satisfies GuestResponse, { status: 201 }),
        ),
      },

      // The name the New Game and Join menus offer. Writes nothing, so a guest
      // that only looks at a menu is still no row.
      '/api/me': {
        GET: guestRoute(async (_request, guest) =>
          Response.json({ name: await matchesOf(guest).name() } satisfies MeResponse),
        ),
      },

      '/api/matches': {
        GET: guestRoute(async (_request, guest) => Response.json(await matchesOf(guest).list())),
        POST: guestRoute(async (request, guest, address) => {
          const wait = limiter.take(`create ${address}`, caps.creates);
          if (wait) return retryLater(429, 'too many new matches from this address', wait);

          // The body is optional -- `{}` means every default -- so an
          // unparseable one is treated as absent rather than refused.
          const match = readNewMatch(await request.json().catch(() => null));
          if (typeof match === 'string') return badRequest(match);

          const matches = matchesOf(guest);
          // Counted, then created, so two creates in one round trip can both
          // pass: a bound on abandoned matches, not an exact one.
          if ((await matches.unfinished()) >= caps.unfinishedMatches) {
            return errorResponse(TOO_MANY_UNFINISHED, 409);
          }
          // Last, so that only a match about to be made spends from it.
          const closed = limiter.take('everyone', caps.ceiling);
          if (closed) return retryLater(503, 'no more new matches today', closed);

          return Response.json(await matches.create(match), { status: 201 });
        }),
      },

      '/api/matches/join': {
        POST: guestRoute(async (request, guest, address) => {
          // Joining starts a game as creating one does, and spends from the
          // same allowance -- which is also what makes guessing codes slow.
          const wait = limiter.take(`create ${address}`, caps.creates);
          if (wait) return retryLater(429, 'too many new matches from this address', wait);

          const { code, name } = fieldsOf<JoinMatchRequest>(await request.json().catch(() => null));
          if (typeof code !== 'string') return badRequest('a code is needed');
          const sent = sentName(name);
          if (sent === INVALID) return badRequest(NAME_NOT_TEXT);

          const matches = matchesOf(guest);
          if ((await matches.unfinished()) >= caps.unfinishedMatches) {
            return errorResponse(TOO_MANY_UNFINISHED, 409);
          }
          const joined = await matches.join(readJoinCode(code), sent);
          if (!joined) return errorResponse('no game is waiting for that code', 404);
          if (!joined.ok) return errorResponse(joined.reason, 409);
          return Response.json(joined.match);
        }),
      },

      '/api/matches/:id/state': {
        GET: guestRoute(async (request, guest) => {
          const snapshot = await matchesOf(guest).snapshot(request.params.id);
          return snapshot ? withPresence(request.params.id, guest, snapshot) : notFound();
        }),
      },

      '/api/matches/:id/events': {
        GET: guestRoute(async (request, guest) => {
          const since = Number(new URL(request.url).searchParams.get('since') ?? 0);
          if (!Number.isInteger(since) || since < 0) {
            return badRequest('since must be a non-negative integer');
          }
          const events = await matchesOf(guest).since(request.params.id, since);
          return events ? withPresence(request.params.id, guest, events) : notFound();
        }),
      },

      '/api/matches/:id/commands': {
        POST: guestRoute(async (request, guest, address) => {
          const wait = limiter.take(`command ${address}`, caps.commands);
          if (wait) return retryLater(429, 'too many commands from this address', wait);

          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return badRequest('malformed JSON');
          }

          const command = parseCommand(body);
          if (!command) {
            return badRequest('not a valid command');
          }

          const result = await matchesOf(guest).submit(request.params.id, command);
          if (!result) return notFound();
          // 409: another write reached the match first -- a surrender beside
          // this command, say. Nothing of this one landed.
          if (result === MOVED) return errorResponse('the game moved on -- try again', 409);
          // 422: the body was a well-formed command, the rules refused it. That
          // is distinct from 400 (not a command at all) and from 5xx, and the
          // reason is the server's to state.
          if (!result.ok) return errorResponse(result.reason, 422);
          return Response.json(result);
        }),
      },

      '/api/matches/:id/cancel': {
        POST: guestRoute(async (request, guest) => {
          const cancelled = await matchesOf(guest).cancel(request.params.id);
          if (cancelled === null) return notFound();
          if (!cancelled) {
            return errorResponse('the game has started -- it can only be surrendered now', 409);
          }
          return new Response(null, { status: 204 });
        }),
      },

      // ⚠️ **Closed to everyone, and kept for an admin.** Archiving is
      // match-wide, so either player of a shared game could otherwise erase it
      // from the other's list; admin roles are what will open it again. The
      // same answer for every match, so it says nothing about which exist.
      '/api/matches/:id/archive': {
        POST: guestRoute(async () => errorResponse('archiving is not open to players', 403)),
      },

      // Unclaimed /api URLs, including a method an endpoint does not serve --
      // which is where every preflight lands, since no route serves OPTIONS.
      // Keeps the rest 404 rather than falling through to the client build.
      '/api/*': async (request) =>
        withHeaders(
          headers,
          request.method === 'OPTIONS'
            ? new Response(null, { status: 204, headers: PREFLIGHT })
            : notFound(),
        ),

      // The client build. A route rather than a `fetch` fallback so that every
      // path is in this table. Least specific, so '/api/*' out-matches it.
      '/*': async (request) => withHeaders(PAGE, await serveClient(dist, request)),
    },

    error(cause) {
      // An ErrorResponse rather than bun's default, so the client reads the
      // same shape here as from any other failure.
      console.error('unhandled request error:', cause);
      return errorResponse('internal server error', 500);
    },
  });

  console.log(`server listening on http://localhost:${server.port}`);

  return server;
}

// Cache policy by path shape: Vite content-hashes every /assets/* filename,
// so those bytes can never change under their name -- cache forever. Anything
// else (index.html above all, whose content decides which hashes get fetched)
// revalidates on every load.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

async function serveClient(dist: string, request: BunRequest): Promise<Response> {
  // Production only: in dev Vite serves the client.
  const url = new URL(request.url);
  const accept = request.headers.get('accept-encoding') ?? '';

  if (url.pathname === '/') {
    return (
      (await serveFile(join(dist, 'index.html'), NO_CACHE, accept)) ??
      errorResponse('client not built -- run `bun run build`', 404)
    );
  }

  // ⚠️ **A path that is no file goes to the start**, rather than getting the
  // page. The client keeps its routes in memory and its asset paths relative,
  // so there are no deep links -- and a page served from a deeper path would
  // look for its assets beside that path and find none.
  const toStart = (): Response => new Response(null, { status: 302, headers: { Location: '/' } });

  // Belt-and-braces: URL parsing already collapses `..`, but filesystem access
  // should not rest on how the parser happens to behave. `+ sep` is load-
  // bearing -- a bare startsWith would accept a sibling like dist-types.
  const resolved = resolve(dist, '.' + url.pathname);
  if (!resolved.startsWith(dist + sep)) return toStart();

  const cacheControl = url.pathname.startsWith('/assets/') ? IMMUTABLE : NO_CACHE;
  return (await serveFile(resolved, cacheControl, accept)) ?? toStart();
}

/**
 * Serves one file from the build, preferring a precompressed sibling the
 * client accepts -- the build writes .br and .gz beside every compressible
 * asset. Null when the file does not exist, so the caller owns the fallback.
 *
 * Content-Type comes from the *original* file either way: Bun.file would
 * guess application/octet-stream from a .br extension. Vary rides every
 * response, compressed or not -- a cache that stored the plain body for a
 * br-accepting client would otherwise serve it to everyone. The encoding
 * check is a substring match, which is enough for machine-generated token
 * lists; a client contorted enough to send `q=0` gets bytes it can decode.
 */
async function serveFile(
  path: string,
  cacheControl: string,
  accept: string,
): Promise<Response | null> {
  const original = Bun.file(path);
  if (!(await original.exists())) return null;

  const headers: Record<string, string> = {
    'Content-Type': original.type,
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
  };

  for (const [encoding, extension] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ] as const) {
    if (!accept.includes(encoding)) continue;
    const variant = Bun.file(path + extension);
    if (!(await variant.exists())) continue;
    return new Response(variant, { headers: { ...headers, 'Content-Encoding': encoding } });
  }

  return new Response(original, { headers });
}

const TOO_MANY_UNFINISHED = 'too many unfinished matches -- finish, surrender or cancel one first';
const NAME_NOT_TEXT = 'a name must be text';

/** A body's fields, every one unchecked; none at all for a body that is not an object. */
function fieldsOf<T>(body: unknown): { [K in keyof T]?: unknown } {
  return typeof body === 'object' && body !== null ? body : {};
}

/**
 * Something sent that is present and wrong. ⚠️ Absent and wrong are different
 * answers: absent takes the default, which is how an older client that sends
 * no body at all still gets a match.
 */
const INVALID = Symbol('invalid');

/** A sent name through `readName`, `undefined` for none, or `INVALID` for one that is not text. */
function sentName(name: unknown): string | undefined | typeof INVALID {
  if (name === undefined) return undefined;
  if (typeof name !== 'string') return INVALID;
  return readName(name) ?? undefined;
}

/** A create's body as a `NewMatch`, or the reason it is not one. */
function readNewMatch(body: unknown): NewMatch | string {
  const { mapId, mode, seat, name, clock } = fieldsOf<CreateMatchRequest>(body);
  const match: NewMatch = {};
  if (mapId !== undefined) {
    const map = typeof mapId === 'string' ? findMap(mapId) : null;
    if (!map) return 'unknown map';
    match.mapId = map.id;
  }
  if (mode !== undefined) {
    if (mode !== 'hotSeat' && mode !== 'remote') return 'unknown mode';
    match.mode = mode;
  }
  if (seat !== undefined) {
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 1 || seat > PLAYERS.length) {
      return 'no such seat';
    }
    match.seat = seat;
  }
  const sent = sentName(name);
  if (sent === INVALID) return NAME_NOT_TEXT;
  if (sent !== undefined) match.name = sent;
  if (clock !== undefined) {
    if (!CLOCK_MINUTES.some((minutes) => minutes === clock)) return 'no such clock';
    match.clock = clock as number;
  }
  return match;
}

/**
 * `getMap` without the throw.
 *
 * ⚠️ An unknown id is a 404 here and a 400 at create, which is not an
 * inconsistency: asking to *look at* a board that does not exist is a missing
 * resource, and asking to *build on* one is a bad argument. Both callers want
 * the lookup and neither wants an exception, which is what this is for --
 * `getMap` keeps throwing, because every other content lookup does.
 */
function findMap(id: string): GameMap | null {
  try {
    return getMap(id);
  } catch {
    return null;
  }
}

/**
 * Answers for a client served from anywhere -- itch's CDN, a portal, or this
 * server itself.
 *
 * ⚠️ **`*`, not an allowlist.** Every itch game is served from one shared
 * origin, so an allowlist naming it would admit all of them anyway: the origin
 * is not the boundary here, and with no cookies to carry, `*` lends nothing.
 */
const CORS = { 'Access-Control-Allow-Origin': '*' };

/**
 * What every API answer carries: CORS, and this deployment's build number for
 * a client to compare with its own. ⚠️ Exposed by name, with the renewed guest
 * token a guest's answer can carry, because a cross-origin response hides
 * every header CORS does not list.
 */
function apiHeaders(build: number): Record<string, string> {
  return {
    ...CORS,
    'Access-Control-Expose-Headers': 'X-Build, X-Guest-Token',
    'X-Build': String(build),
    // Every answer is one guest's, and current only until the next command.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * What the client build is served with, for what its CSP meta tag cannot say.
 * ⚠️ **Never framed**: itch embeds its own copy of the build, not this site,
 * so a frame of this one is somebody else's page wearing the game.
 */
const PAGE = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

const PREFLIGHT = {
  ...CORS,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  // Chrome caps a cached preflight at two hours; asking for longer buys nothing.
  'Access-Control-Max-Age': '7200',
};

/**
 * Every API route is wrapped one way or the other, which is what makes the
 * table default-deny: `publicRoute` for what anyone may ask, `guestRoute` for
 * what needs a guest, refusing a request without a valid token with a 401.
 * Both put the API's headers on whatever they answer -- an error included, or
 * the client would see a 422 as a network failure -- and refuse a POST unless
 * it is JSON. Made per server, because the headers carry its build and the
 * guests are its own.
 *
 * ⚠️ **JSON or 415**, because a POST of plain text is a request any web page
 * can send without a preflight. Requiring the content type puts every write
 * behind one.
 *
 * Per entry rather than in one place because `Bun.serve` has no middleware and
 * a matched route reaches no fallback -- forgetting it is silent, hence a
 * wrapper visible on every line of the table.
 *
 * Keep it `BunRequest<T>`: widening to `Request` compiles but degrades
 * `request.params` to `Record<string, string>`, so a param typo stops being an
 * error.
 */
function routeWith(headers: Record<string, string>, guests: Guests, trustFlyClientIp: boolean) {
  function publicRoute<T extends string>(
    handler: (request: BunRequest<T>, peer: Peer) => Promise<Response>,
  ): (request: BunRequest<T>, peer: Peer) => Promise<Response> {
    return async (request, peer) =>
      withHeaders(headers, await answer(request, (asked) => handler(asked, peer)));
  }

  function guestRoute<T extends string>(
    handler: (request: BunRequest<T>, guest: GuestId, address: string) => Promise<Response>,
  ): (request: BunRequest<T>, peer: Peer) => Promise<Response> {
    return publicRoute<T>(async (request, peer) => {
      const verified = guests.verify(bearer(request));
      if (!verified) return unauthorized();
      const response = await handler(
        request,
        verified.guest,
        addressOf(request, peer, trustFlyClientIp),
      );
      if (verified.renewal) response.headers.set('X-Guest-Token', verified.renewal);
      return response;
    });
  }

  return { publicRoute, guestRoute };
}

/** What a route needs of Bun's server, which hands itself to every handler. */
interface Peer {
  requestIP(request: Request): { address: string } | null;
}

/**
 * Where a request came from, which is what the limits are kept by. ⚠️
 * `Fly-Client-IP` only when trusted: Fly's edge sets it in production, and
 * anywhere else a client could write a fresh one on every request.
 */
function addressOf(request: Request, peer: Peer, trustFlyClientIp: boolean): string {
  const fly = trustFlyClientIp ? request.headers.get('fly-client-ip') : null;
  return fly ?? peer.requestIP(request)?.address ?? 'unknown';
}

/**
 * A refusal that passes. ⚠️ The wait is in the reason as well as
 * `Retry-After`, because the reason is what a client shows and a cross-origin
 * client cannot read a header nobody exposed.
 */
function retryLater(status: 429 | 503, reason: string, seconds: number): Response {
  const response = errorResponse(`${reason} -- try again in ${inWords(seconds)}`, status);
  response.headers.set('Retry-After', String(seconds));
  return response;
}

function inWords(seconds: number): string {
  const counted = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (seconds < 120) return counted(seconds, 'second');
  if (seconds < 7200) return counted(Math.ceil(seconds / 60), 'minute');
  return counted(Math.ceil(seconds / 3600), 'hour');
}

const bearer = (request: Request): string =>
  /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';

function unauthorized(): Response {
  const response = errorResponse('a guest token is needed -- mint one at /api/auth/guest', 401);
  response.headers.set('WWW-Authenticate', 'Bearer');
  return response;
}

/**
 * The key guest tokens are signed with. A fixed key outside production, so a
 * restart does not sign every development guest out.
 */
function signingKey(given: string | undefined): string {
  return given ?? process.env.GUEST_KEY ?? 'development only -- never in production';
}

function withHeaders(headers: Record<string, string>, response: Response): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

async function answer<T extends string>(
  request: BunRequest<T>,
  handler: (request: BunRequest<T>) => Promise<Response>,
): Promise<Response> {
  const type = request.headers.get('content-type') ?? '';
  if (request.method === 'POST' && !type.startsWith('application/json')) {
    return errorResponse('content type must be application/json', 415);
  }
  try {
    return await handler(request);
  } catch (cause) {
    console.error('unhandled request error:', cause);
    return errorResponse('internal server error', 500);
  }
}

// Every non-2xx body is an ErrorResponse. `Response.json` sets the content
// type itself, so there is nothing here to wrap.
const errorResponse = (error: string, status: number): Response =>
  Response.json({ error } satisfies ErrorResponse, { status });

const badRequest = (error: string): Response => errorResponse(error, 400);
const notFound = (): Response => errorResponse('not found', 404);

// Guarded so importing this module (a test) starts nothing. Without it, the
// dev and start scripts define createServer and exit without listening.
if (import.meta.main) await createServer();
