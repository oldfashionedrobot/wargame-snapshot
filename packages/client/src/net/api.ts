import type {
  CreateMatchRequest,
  ErrorResponse,
  GuestResponse,
  JoinMatchRequest,
  MapPreview,
  MapSummary,
  MatchSummary,
  MeResponse,
} from '@wargame/shared';
import { forgetGuestToken, guestToken, renewGuestToken } from './guest';

const API = `${__API_ORIGIN__}/api`;

/**
 * Why a request failed, when the caller needs to tell the difference.
 *
 * `notFound` is not retryable — a deep link to a match that doesn't exist will
 * never succeed, so offering "Retry" would be a lie. `unreachable` covers
 * everything else: the server is down, the network is out, or it answered with
 * something we can't use.
 */
export type FailureKind = 'notFound' | 'unreachable';

export class HttpError extends Error {
  // Declared rather than a constructor parameter property: erasableSyntaxOnly
  // forbids the shorthand, since it emits runtime code from a type position.
  readonly kind: FailureKind;

  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = 'HttpError';
    this.kind = kind;
  }
}

/**
 * A request the server understood and refused, with its reason as the message:
 * a command the rules refused, a match past a cap, or a limit that says how
 * long to wait -- see `REFUSALS`.
 * Deliberately not an `HttpError` and not a `FailureKind`: a refusal is an
 * answer, not a connection problem, and keeping it a separate type keeps it
 * unrepresentable in the connect path, whose two-case UI it can never reach.
 * One where nothing could refuse means a broken server, and falls through
 * `instanceof HttpError` checks to `unreachable` -- which is what a broken
 * server is.
 */
export class RejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RejectedError';
  }
}

// 409 a cap or a game that moved on, 422 the rules, 429 an address's limit, 503 everyone's.
const REFUSALS = [409, 422, 429, 503];

// Every non-2xx body is an ErrorResponse -- the server has no exceptions to
// that rule -- but the network in between can produce anything, so fall back
// to the status when the body isn't ours.
async function reason(response: Response): Promise<string> {
  try {
    const { error } = (await response.json()) as ErrorResponse;
    if (typeof error === 'string') return error;
  } catch {
    // not JSON: a proxy or something else answered, not our server
  }
  return `server returned ${response.status}`;
}

/**
 * Whether the server has been seen on a newer build than this client, read off
 * every answer it gives -- a refusal included. One-way: a client goes out of
 * date and does not come back until it is reloaded.
 */
let outOfDate = false;
const outOfDateListeners = new Set<() => void>();

export const outOfDateStore = {
  subscribe(listener: () => void): () => void {
    outOfDateListeners.add(listener);
    return () => outOfDateListeners.delete(listener);
  },
  get: (): boolean => outOfDate,
};

function noteServerBuild(response: Response): void {
  // A missing header reads as 0, which is never newer.
  const build = Number(response.headers.get('x-build'));
  if (outOfDate || !(build > __BUILD__)) return;
  outOfDate = true;
  for (const listener of outOfDateListeners) listener();
}

async function send(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, init);
  } catch {
    throw new HttpError('unreachable', 'could not reach the server');
  }
  noteServerBuild(response);
  return response;
}

async function mintGuest(): Promise<string> {
  const response = await send('/auth/guest', jsonPost({}));
  if (!response.ok) throw new HttpError('unreachable', await reason(response));
  return ((await response.json()) as GuestResponse).token;
}

/**
 * Every call carries the guest token, minting one first if there is none, and
 * keeps the renewal an answer may carry, so a guest lasts while it plays. ⚠️
 * **A 401 is recovered from once**: the token was expired or the key rotated,
 * so it is forgotten, a new guest minted, and the call made again -- once, so a
 * server that refuses every token cannot loop.
 */
async function request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const token = await guestToken(mintGuest);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await send(path, { ...init, headers });
  const renewed = response.headers.get('x-guest-token');
  if (renewed) renewGuestToken(token, renewed);

  if (response.status === 401 && !retried) {
    forgetGuestToken(token);
    return request(path, init, true);
  }
  if (response.ok) return response;

  const why = await reason(response);
  if (response.status === 404) throw new HttpError('notFound', why);
  if (REFUSALS.includes(response.status)) throw new RejectedError(why);
  throw new HttpError('unreachable', why);
}

export async function getJson<T>(path: string): Promise<T> {
  return (await request(path)).json() as Promise<T>;
}

// ⚠️ Always JSON, `{}` when there is nothing to say: the server refuses any
// POST that is not, so that every write needs a preflight.
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await request(path, jsonPost(body));
  return response.json() as Promise<T>;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Not on GameServer: that interface is scoped to a single match, and listing
// or creating isn't. A plain object rather than an interface -- there's only
// ever going to be one implementation of "call this endpoint".
export const api = {
  /** The name the menus offer: the guest's own, or a suggestion. */
  async name(): Promise<string> {
    return (await getJson<MeResponse>('/me')).name;
  },
  maps: {
    list(): Promise<MapSummary[]> {
      return getJson<MapSummary[]>('/maps');
    },
    /** The board a match on this map would start from. Creates nothing. */
    preview(id: string): Promise<MapPreview> {
      return getJson<MapPreview>(`/maps/${encodeURIComponent(id)}/preview`);
    },
  },
  matches: {
    list(): Promise<MatchSummary[]> {
      return getJson<MatchSummary[]>('/matches');
    },
    /** Anything left out takes the server's default. */
    create(request: CreateMatchRequest = {}): Promise<MatchSummary> {
      return postJson<MatchSummary>('/matches', request);
    },
    join(request: JoinMatchRequest): Promise<MatchSummary> {
      return postJson<MatchSummary>('/matches/join', request);
    },
    /** A game still waiting for its opponent. */
    async cancel(id: string): Promise<void> {
      await request(`/matches/${encodeURIComponent(id)}/cancel`, jsonPost({}));
    },
  },
};
