# Wargame

> **A read-only snapshot, shared to be read rather than run.** The period
> figures and the houses are licensed from Beelim Solutions and may not be
> redistributed, so `packages/client/public/models/units/` and
> `packages/client/public/models/buildings/` are left out, and the game will not
> load without them. The terrain is Kenney's Nature Kit, CC0, and is included.
> This is the code as of `90c3aa0`, without its history.

**Gunpowder Tactics** — a turn-based tactics game in the manner of Advance Wars,
set in the American Revolutionary War: infantry, cavalry, artillery and a
general rather than tanks and jets, as low-poly period figures on a diorama
board. React + TypeScript + Babylon.js, built with bun.

- [`.plan/architecture.md`](.plan/architecture.md) — what the code does now.
- [`.plan/roadmap.md`](.plan/roadmap.md) — what is designed but unbuilt.

## What plays

Two players against a real server, from the opening move to a winner — at one
device, passing it between turns, or each on their own: one starts a
multiplayer game and gets a code, the other joins with it, and each plays their
own army on their own turn. A player who leaves comes back to the game where it
stood. A game may have a chess clock, a few minutes a side, and either player
may surrender.

Both sides field the same army — a general with guns, horse and foot — on a map
chosen when the match is created; *Browse maps* shows the boards without
starting one. Select a unit and see the tiles it can reach across terrain;
click a destination to pin the route there, and click it again to send the unit
walking. Where it arrives a panel asks what it is doing: hold, attack or
charge. Facing matters: a unit attacked from behind never answers, and a charge
into a flank or the rear is likelier to break through than one into the front.
A unit beside an enemy is in contact, which ends a move. A charge is earned by
attacking: certain against a worn-down unit, a gamble against a stronger one.

An attack or a charge cuts away to a close-up: both units as ranks of figures,
facing as they stood, on the ground they stand on — a wood, a river, a
village — firing, charging, falling and running as the battle went. Every unit
acts once, walking on the spot until it has, the turn ends when the last of
them has gone, and a player who loses its army or its general has lost.

**Where it plays:** on itch, on a page that is restricted for now, against a
server on Fly with its database on Turso. A release is a push to the
`production` branch; see *Deployment* in the architecture doc.

## Getting started

```sh
bun install
bun run dev        # http://localhost:5173
```

`bun run dev` migrates the local database, then starts two processes: Vite on
5173 and the server on 3001. The client calls the server cross-origin, at an
address compiled into it, as it does from itch.

Configuration is one optional `.env` at the repo root — the port, the database,
the server's address for the client, and the rest; see `.env.example`, which
says what each is for. Without it the defaults apply.

**The figures and houses are committed, already converted.** They are made from
licensed packs that are not in the repo — the licence allows their use in the
game, not their distribution — by `bun run --filter '@wargame/client' models`,
which drives Blender. The terrain is Kenney's Nature Kit, CC0.

## Layout

Bun workspaces, three packages, split by **authority** rather than by subject:

| Package | Depends on | Contents |
|---|---|---|
| `@wargame/shared` | nothing | The rulebook — types, content tables, queries, movement, validation, resolution, the event fold, the wire protocol. Pure functions: no React, no Babylon, no I/O, no randomness. |
| `@wargame/server` | `shared` | The authority — the database, the event log, match construction, the dice, the HTTP surface. |
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
| `bun run dev` | Migrates, then Vite (5173) + server (3001) |
| `bun run gate` | Every check below — forced typecheck, lint, tests, format, build, and no development hook in the bundle — ending with each one's exit code. What CI runs |
| `bun run test` | `bun test` for shared and server, Vitest for client |
| `bun run typecheck` | `tsc -b` across the packages |
| `bun run lint` | ESLint across the repo |
| `bun run build` | Typecheck, then bundle and compress the client |
| `bun run format` / `format:check` | Prettier, Markdown excluded |
| `bun run db:generate` / `db:migrate` | drizzle-kit — **from the repo root only** |
| `bun run preview` | `vite preview` of the built client, which calls the server at its compiled address — the local one on 3001 unless `API_ORIGIN` says otherwise. The server also serves the built client itself: `bun run --filter '@wargame/server' start` |
| `bun run --filter '@wargame/client' models` | Converts the figures and houses from the packs, through Blender — by hand, never in a build |

Three things worth knowing:

- Check **exit codes, not output**. `bun run typecheck | tail -3 && echo OK`
  chains the `&&` to `tail`, which always succeeds, and prints OK on failure.
- `tsc -b` can report success from a stale `.tsbuildinfo`. `bunx tsc -b --force`
  is the real check, and the one the gate runs.
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
