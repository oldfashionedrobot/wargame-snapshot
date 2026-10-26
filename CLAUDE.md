# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The spec comes first

Two living documents, kept accurate in the same commit as the code they
describe:

- **`.plan/architecture.md`** — what the code does *now*. No rationale, no
  history, no plans. Read the relevant section before changing anything
  structural, and update it with the change.
- **`.plan/roadmap.md`** — what is designed but unbuilt: the remaining epics,
  accepted limits, and, at the bottom, *Ideas* — features wanted but not
  scheduled. Nothing in it describes current behaviour.

When something ships, it moves out of the roadmap into the architecture doc and
is deleted from where it came. Neither keeps a changelog; `git log` is the
history.

⚠️ There was a third, `sidequests.md`, for work that was wanted but was not a
phase. **Don't recreate it.** A standing list of someday-work is not wanted —
small self-contained jobs either get done or get raised when they come up, and a
file of them only rots. Anything that genuinely has no place in the ordering
goes in the roadmap or nowhere.

## Commands

| | |
|---|---|
| `bun run dev` | migrates, then Vite (5173) + server (3001); the client calls the server cross-origin, as it will from a portal |
| `bun run gate` | every leg below, each reporting its exit code — what CI runs |
| `bun run test` | `bun test` for shared+server, then Vitest for client |
| `bun run typecheck` | `tsc -b` — but see the stale-cache trap below |
| `bun run lint` / `bun run build` / `bun run format:check` | all exit non-zero on failure |
| | `format:check` skips Markdown (`.prettierignore`), so these docs are not covered |
| `bun run db:generate` / `db:migrate` | **from the repo root only** — see traps |
| `git push origin main:production` | ⚠️ **a release**: CI deploys the server to Fly and the client to itch. Only when asked |

Single test file: `bun test packages/server/src/match.test.ts` (add `-t 'name'`
to filter); client: `cd packages/client && bunx vitest run src/net/gameServer.test.ts`.

## The gate — before every commit

Lint, tests, format and build must all be green. Two rules with history behind
them:

- **Check exit codes, not output.** `bun run typecheck | tail -3 && echo OK`
  chains the `&&` to `tail` and prints OK on failure. That happened.
- **`tsc -b` can pass stale** — its `.tsbuildinfo` may believe work is current.
  `bunx tsc -b --force` is the real check.

`bun run gate` runs every leg — forced typecheck, lint, tests, format, build,
and a check that no development hook reached the bundle — and ends with each
leg's exit code. CI runs the same script on every push to `main`, and the
`/gate` skill wraps it. For
anything visual, the `/run-app` skill launches the app and drives it in a
headless browser — the renderer has no test coverage (WebGL), so a browser is
its only check.

## Architecture in one breath

Three bun workspaces split by **authority**, not subject: `shared/` is the pure
rulebook (zero deps — no I/O, no RNG, no React/Babylon, no `Date.now()`),
`server/` is the authority (owns the DB, keeps the event log, and rolls the
luck in `rollLuck.ts`),
`client/` is presentation. Installs are isolated, so a stray `import 'react'`
in server code is a resolution error, not a review catch. Cross-package imports
go through `@wargame/shared`'s `exports` map — `.` is the rulebook barrel, and
`./testing` is fixtures for tests. `server/` is an app, not a library: no
barrel, `http.ts` is the entry point.

The pipeline: `validateCommand` (the only constructor of a branded `Action`) →
`resolveAction` (returns **events, not state**) → `applyEvents` (the only
mutator). `Command` is client intent, `Action` is server-accepted, `GameEvent`
is broadcast fact — clients render facts, never resolve outcomes. Deterministic
preview yes, random resolution no. Events are **absolute values, never
deltas**, and independently applicable — that's what makes replay and the
`initial_state + log = current_state` test hold.

The server holds nothing between requests — SQLite (libSQL + Drizzle) is the
only mutable state, with one named exception: transient state — the rate
limiter's counts and who is here — which is not game state and is lost on a
restart without anything that matters going with it. Transport is plain HTTP polling with a `seq` cursor; no
push, no WebSockets, ever. Rule-rejected commands answer **422**; every non-2xx
body this code writes is `{ error: string }`.

Movement: `exploreMovement` searches, `validatePath` checks a client-supplied
route, and both call `entryCost` — one function decides what a tile costs, so
the client's overlay and the server's check cannot disagree.

## Traps that bit before

- **`db:*` scripts run from the repo root.** drizzle-kit resolves its config's
  paths against the cwd, and `db:migrate` loads `.env` from it. A relative
  `file:` URL is safe either way — `createDb` resolves it against the repo root
  — which is what stopped `bun run --filter` once creating a second, empty
  database beside the real one.
- **One `.env`, at the repo root.** Bun doesn't walk up; server scripts pass
  `--env-file=../../.env` explicitly.
- **Don't pin the server's wording in client tests.** Assert the failure's
  *kind* — the reason text belongs to the server and changes without the
  failure mode changing. Asserting that a reason the fixture supplied arrives
  intact is a different thing and is fine; that is passthrough, not wording.
- **`http.test.ts` is a black box** over real `fetch` against `createServer`.
  Keep it that way — it survived a routing rewrite untouched precisely because
  nothing in it knows how URLs dispatch.
- **Tests must not touch the real dev database.** Server suites use `:memory:`;
  `db.test.ts` uses a temp directory. A relative `file:` URL resolves against
  the repo root, so a careless one opens `packages/server/wargame.db`.
- **`http.test.ts` serves a fixture dist, never the real build.** `dist/` is
  gitignored and `bun run test` does not build it, so tests written against it
  quietly change meaning depending on whether someone ran a build.
- `strict` is on in every program `tsc -b` builds. **`shared` has two configs
  and they check different halves.** Its `tsconfig.json` is for editors and has
  no program — the *rulebook* is checked inside `server` and `client`, which
  import it. `tsconfig.dev.json` is a real program, referenced from the root, and
  covers the parts nothing imports: `scripts/` and `src/**/*.test.ts`. So every
  file is checked, and giving that config bun types does not weaken invariant 2 —
  the client program checks `src` too and has no bun globals at all, so
  `process.env` in the rulebook still fails the build. The rest of invariant 2
  — `Math.random`, `Date`, `console`, `fetch`, timers — compiles there, and is
  refused by a lint block on `packages/shared/src` instead.
  `erasableSyntaxOnly` forbids constructor parameter properties;
  `verbatimModuleSyntax` requires explicit `import type`.

## Commits

Small, one concern each, message style `area: what changed` in lowercase with
the reasoning in the body — read `git log` before writing one. Plan-doc updates
ride in the same commit as the code they track.

⚠️ **No trailers.** Not `Co-Authored-By`, not `Claude-Session`, not any other
`Key: value` footer. Claude Code adds both by default and this overrides that:
the message ends with the last sentence of the reasoning. Older commits carry
them — 179 and 125 of them respectively — and those are **left alone**, because
they are published and a force-push to strip metadata is a bad trade. Do not
backfill and do not rewrite to match.
