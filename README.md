# Wargame

> **A read-only snapshot, shared to be read rather than run.** The period
> figures and the houses are licensed from Beelim Solutions and may not be
> redistributed, so `packages/client/public/models/units/` and
> `packages/client/public/models/buildings/` are left out, and the game will not
> load without them. The terrain is Kenney's Nature Kit, CC0, and is included.
> This is the code as of `301a34f`, without its history.

A turn-based strategy game with an American Revolutionary War theme — infantry,
cavalry, and artillery rather than tanks and jets. React + TypeScript +
Babylon.js, built with bun.

- [`.plan/architecture.md`](.plan/architecture.md) — what the code does now.
- [`.plan/roadmap.md`](.plan/roadmap.md) — what is designed but unbuilt.

## Getting started

```sh
bun install
bun run dev        # http://localhost:5173
```

`bun run dev` starts two processes: Vite on 5173 and the server on 3001. Vite
proxies `/api` to the server, so everything is same-origin and the client has no
URL to configure.

Configuration is one optional `.env` at the repo root (`PORT`,
`DATABASE_URL`); see `.env.example`. Without it the defaults apply.

## What plays

Hot-seat against a real server — two people at one device — from the opening
move to a winner. Select a unit and see the tiles it can reach across terrain;
click a destination to pin the route there, and click it again to send the unit
walking. Where it arrives a panel asks what it is doing: hold, attack or charge
— a charge is earned by attacking: certain against a worn-down unit, and
a gamble against a stronger one.
An attack or a charge cuts away to the two units and plays the exchange. Click
an enemy, or a unit of yours that has acted, to see what it could attack and
where it could move. Every unit acts once, greyed once it has, the turn ends
when the last of them has gone, and a player who loses its army or its general
has lost.

Two players, each fielding the same default army — a general with guns, horse
and foot — on a map chosen when the match is created. `/maps` shows the boards without
starting one.

## Layout

Bun workspaces, three packages, split by **authority** rather than by subject:

| Package | Depends on | Contents |
|---|---|---|
| `@wargame/shared` | nothing | The rulebook — types, content tables, queries, movement, validation, resolution, the event fold, the wire protocol. Pure functions: no React, no Babylon, no I/O, no randomness. |
| `@wargame/server` | `shared` | The authority — the database, the event log, match construction, the HTTP surface. |
| `@wargame/client` | `shared` | Presentation and transport — Babylon rendering, input, React, and the polling `GameServer` that talks to the API. |

Installs are isolated rather than hoisted, so a package can only import what it
declares: a stray `import 'react'` in server code is a resolution failure, not
something to catch in review.

Cross-package imports go through `@wargame/shared`'s `exports` map, which has two
entry points: `.` is the rulebook barrel, and `./testing` is fixtures for tests.
`server` is an application rather than a library — nothing imports it, so it has
no barrel; `src/http.ts` is an entry point that gets run.

`shared` has no build script and emits nothing — its `exports` point at
TypeScript source, which bun runs natively and Vite compiles. `server` and
`client` pull that source into their own programs, so it is typechecked as a
byproduct of being imported.

## Scripts

Run from the repo root. All exit non-zero on failure.

| Command | Does |
|---|---|
| `bun run dev` | Vite (5173) + server (3001) |
| `bun run test` | `bun test` for shared and server, Vitest for client |
| `bun run typecheck` | `tsc -b` across the packages |
| `bun run lint` | ESLint across the repo |
| `bun run build` | Typecheck, then bundle and compress the client |
| `bun run format` / `format:check` | Prettier (Markdown and exported glTF are excluded) |
| `bun run db:generate` / `db:migrate` | drizzle-kit — **from the repo root only** |
| `bun run preview` | `vite preview` — serves the built client with **no `/api` proxy**, so it cannot reach a match. To exercise a real build, run the server (`bun run --filter '@wargame/server' start`), which serves `dist` itself |

Three things worth knowing:

- Check **exit codes, not output**. `bun run typecheck | tail -3 && echo OK`
  chains the `&&` to `tail`, which always succeeds, and prints OK on failure.
- `tsc -b` can report success from a stale `.tsbuildinfo`. `bunx tsc -b --force`
  is the real check.
- The `db:*` scripts must run from the repo root. Relative `file:` URLs in
  `DATABASE_URL` resolve against the root, and `bun run --filter` would change
  the cwd and lose the single root `.env`.

Working on one package? `bun run --filter '@wargame/client' bundle` bundles
*without* typechecking — use the root `build` for the real check.

## Tests

All three packages are tested. The renderer is not covered — it is WebGL, so a
browser is its only check; React components are tested with it mocked.

```sh
bun run test                                              # everything
bun test packages/server/src/match.test.ts                # one file
bun test packages/server/src/match.test.ts -t 'newest'    # one test
cd packages/client && bunx vitest run src/net/gameServer.test.ts
```
