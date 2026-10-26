import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, HttpError, RejectedError } from './api';
import { GUEST_TOKEN_KEY } from './guest';

// The stateless half of net/: the server's address, the JSON, and the one place a
// response becomes notFound, unreachable, or a rejection. gameServer.test.ts
// reaches this code incidentally through its fetch stub; these are about the
// classification itself, which is what the connect path's two-case UI and the
// rejection banner both key on.

let respond: (url: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  respond = () => Promise.reject(new Error('no response scripted'));
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = { id: 'm1', createdAt: 1, seq: 0, currentTurn: 'player-1' };

describe('api.matches', () => {
  it("lists from the server's compiled-in address", async () => {
    const seen: string[] = [];
    respond = (url) => {
      seen.push(url);
      return Promise.resolve(json([summary]));
    };
    expect(await api.matches.list()).toEqual([summary]);
    expect(seen).toEqual([`${__API_ORIGIN__}/api/matches`]);
  });

  // ⚠️ JSON even with nothing to say: the server refuses a POST that is not,
  // so that every write sits behind a preflight.
  it('creates with a JSON POST, even with no map named', async () => {
    let seen: RequestInit | undefined;
    respond = (_url, init) => {
      seen = init;
      return Promise.resolve(json(summary, 201));
    };
    expect(await api.matches.create()).toEqual(summary);
    expect(seen?.method).toBe('POST');
    expect(new Headers(seen?.headers).get('content-type')).toBe('application/json');
    expect(seen?.body).toBe('{}');
  });

  it('joins by code and cancels by id, each a JSON POST', async () => {
    const seen: [string, string | undefined][] = [];
    respond = (url, init) => {
      seen.push([url, init?.method]);
      return Promise.resolve(
        url.endsWith('/cancel') ? new Response(null, { status: 204 }) : json(summary),
      );
    };
    expect(await api.matches.join({ code: 'ABC234' })).toEqual(summary);
    await api.matches.cancel('a b');
    expect(seen).toEqual([
      [`${__API_ORIGIN__}/api/matches/join`, 'POST'],
      [`${__API_ORIGIN__}/api/matches/a%20b/cancel`, 'POST'],
    ]);
  });
});

// The token and the mint in flight are module state, so each case starts from
// a fresh copy of the module -- and from a tab with no guest yet.
describe('the guest token', () => {
  beforeEach(() => {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const isMint = (url: string): boolean => url.endsWith('/api/auth/guest');
  const auth = (init?: RequestInit): string | null =>
    new Headers(init?.headers).get('authorization');

  it('mints one on first need, shared by calls made together, and sends it on each', async () => {
    const { api } = await import('./api');
    const mints: string[] = [];
    const sent: (string | null)[] = [];
    respond = (url, init) => {
      if (isMint(url)) {
        mints.push(url);
        return Promise.resolve(json({ token: 'minted' }, 201));
      }
      sent.push(auth(init));
      return Promise.resolve(json([]));
    };

    await Promise.all([api.matches.list(), api.maps.list()]);
    expect(mints).toHaveLength(1);
    expect(sent).toEqual(['Bearer minted', 'Bearer minted']);
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe('minted');
  });

  // An expired token, or a rotated key: the guest is replaced and the call made
  // again, so the player sees nothing but a fresh start.
  it('replaces a refused token and tries once more', async () => {
    localStorage.setItem(GUEST_TOKEN_KEY, 'expired');
    const { api } = await import('./api');
    const sent: (string | null)[] = [];
    respond = (url, init) => {
      if (isMint(url)) return Promise.resolve(json({ token: 'fresh' }, 201));
      sent.push(auth(init));
      return Promise.resolve(
        auth(init) === 'Bearer fresh' ? json([]) : json({ error: 'expired' }, 401),
      );
    };

    expect(await api.matches.list()).toEqual([]);
    expect(sent).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe('fresh');
  });

  // A guest lasts while it plays.
  it('keeps the token an answer renews it with, and sends that next', async () => {
    localStorage.setItem(GUEST_TOKEN_KEY, 'aging');
    const { api } = await import('./api');
    const sent: (string | null)[] = [];
    respond = (_url, init) => {
      sent.push(auth(init));
      const response = json([]);
      if (auth(init) === 'Bearer aging') response.headers.set('x-guest-token', 'renewed');
      return Promise.resolve(response);
    };

    await api.matches.list();
    await api.matches.list();
    expect(sent).toEqual(['Bearer aging', 'Bearer renewed']);
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe('renewed');
  });

  it('keeps the first of two renewals that arrive together', async () => {
    localStorage.setItem(GUEST_TOKEN_KEY, 'aging');
    const { api } = await import('./api');
    let renewals = 0;
    respond = () => {
      const response = json([]);
      response.headers.set('x-guest-token', `renewed-${++renewals}`);
      return Promise.resolve(response);
    };

    await Promise.all([api.matches.list(), api.matches.list()]);
    expect(localStorage.getItem(GUEST_TOKEN_KEY)).toBe('renewed-1');
  });

  it('gives up after one retry rather than looping on a server that refuses every token', async () => {
    const { api } = await import('./api');
    let calls = 0;
    respond = (url) => {
      if (isMint(url)) return Promise.resolve(json({ token: `t${calls}` }, 201));
      calls++;
      return Promise.resolve(json({ error: 'no' }, 401));
    };

    await expect(api.matches.list()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(calls).toBe(2);
  });

  // Chrome's answer to a cross-site iframe when third-party cookies are blocked.
  it('holds the token in memory when storage refuses it', async () => {
    const refuse = (): never => {
      throw new DOMException('Access is denied for this document.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    const { api } = await import('./api');
    let mints = 0;
    respond = (url) => {
      if (isMint(url)) {
        mints++;
        return Promise.resolve(json({ token: 'remembered' }, 201));
      }
      return Promise.resolve(json([]));
    };

    await api.matches.list();
    await api.matches.list();
    expect(mints).toBe(1);
  });
});

// The store is module state, one-way by design, so each case starts from a
// fresh copy of the module.
describe("the server's build", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const answering =
    (build: number, status = 200) =>
    () =>
      Promise.resolve(new Response('[]', { status, headers: { 'x-build': String(build) } }));

  it('marks this client out of date once the server is newer, and says so once', async () => {
    const { api, outOfDateStore } = await import('./api');
    const heard = vi.fn();
    outOfDateStore.subscribe(heard);

    respond = answering(__BUILD__);
    await api.matches.list();
    expect(outOfDateStore.get()).toBe(false);

    respond = answering(__BUILD__ + 1);
    await api.matches.list();
    await api.matches.list();
    expect(outOfDateStore.get()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('reads it off a failure too', async () => {
    const { api, outOfDateStore } = await import('./api');
    respond = answering(__BUILD__ + 1, 404);
    await api.matches.list().catch(() => {});
    expect(outOfDateStore.get()).toBe(true);
  });

  it('ignores an answer that names no build', async () => {
    const { api, outOfDateStore } = await import('./api');
    respond = () => Promise.resolve(json([]));
    await api.matches.list();
    expect(outOfDateStore.get()).toBe(false);
  });
});

describe('failure classification', () => {
  // The distinction MatchRoute's UI is built on: one offers a way back, the
  // other offers Retry, and a thrown error that conflated them would make the
  // caller guess.
  it('marks a 404 notFound and everything else unreachable', async () => {
    respond = () => Promise.resolve(json({ error: 'not found' }, 404));
    await expect(api.matches.list()).rejects.toMatchObject({ kind: 'notFound' });

    respond = () => Promise.resolve(json({ error: 'boom' }, 500));
    await expect(api.matches.list()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('marks a dead network unreachable', async () => {
    respond = () => Promise.reject(new TypeError('fetch failed'));
    await expect(api.matches.list()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  // A rejection is an answer, not a connection problem, so it must not be an
  // HttpError -- that is what keeps it out of the connect path's two-case UI.
  it.each([409, 422, 429, 503])(
    'makes a %i a RejectedError carrying the server reason',
    async (status) => {
      respond = () => Promise.resolve(json({ error: 'the reason it gave' }, status));
      const failure = await api.matches.list().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RejectedError);
      expect(failure).not.toBeInstanceOf(HttpError);
      expect((failure as Error).message).toBe('the reason it gave');
    },
  );

  it("reads the server's reason, falling back to the status when the body is not ours", async () => {
    respond = () => Promise.resolve(json({ error: 'client not built' }, 404));
    await expect(api.matches.list()).rejects.toThrow('client not built');

    // A proxy answered, not our server.
    respond = () => Promise.resolve(new Response('<html>502</html>', { status: 502 }));
    await expect(api.matches.list()).rejects.toThrow('server returned 502');
  });
});
