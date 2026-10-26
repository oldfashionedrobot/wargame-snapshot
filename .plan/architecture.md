# Wargame — Architecture

Turn-based strategy game, American Revolutionary War theme. React + TypeScript
+ Babylon.js, built with bun.

**This document describes the code as it is.** No rationale, no history — the
reasoning lives in `git log`, where the commit that made a decision is the thing
that explains it. What is planned but unbuilt lives in
[`roadmap.md`](roadmap.md).

**Values live in the modules, not here.**

**What plays today:** two players against a real server process, from the
opening move to a winner — on one device, or each on their own: one starts a
multiplayer game and waits under a code, the other joins with it, and each
plays their own army on their own turn. Select a unit and see the tiles it can reach across terrain;
click a destination to pin the route there and click it again to send the unit
walking. Where it arrives a panel asks what it is doing — hold, attack or charge,
listing only the ones it can actually do and skipping itself when that leaves
one; a unit that could attack or charge from where it stands gets the panel the
moment it is selected, with a Move row to move it instead — after which a held
unit is pointed somewhere, since facing decides whether an attack is answered. A unit beside an enemy is **in contact**: moving into
contact ends the move, and a unit that starts its action in contact may move or
attack, not both. An attack or a charge cuts away to the two units and plays the
exchange; a charge is earned by attacking, faster for horse than for foot. A
unit that cannot act — the enemy's, or one of yours that has acted — can be
inspected: what it could attack from where it stands, then where it could move.
Every unit acts once, walking on the spot until it has, and the turn ends when
the last of them has gone; when a player loses its army or its general, the match is over
and says so.

Two players, each fielding the same default army — a general with guns, horse
and foot — on a map chosen when the match is created. `/maps` shows the boards without starting
one.

**Where it plays:** on itch, on a restricted page, against a server on Fly — and
on that server's own address. See *Deployment*.

## Packages

Three bun workspaces, split by authority. Installs are isolated rather than
hoisted — `bunfig.toml` pins the linker — so a package can only import what it
declares.

| Package | Depends on | Holds |
|---|---|---|
| `@wargame/shared` | nothing at runtime | The rulebook: types, content tables, queries, movement, validation, resolution, the event fold, and the wire protocol. No I/O, no RNG, no React, no Babylon, no `Date.now()`. |
| `@wargame/server` | `shared` | The authority: the database, the event log, match construction, and the HTTP surface. |
| `@wargame/client` | `shared` | Presentation: Babylon rendering and glTF loading, input, React, and the HTTP `GameServer`. |

`shared` has two entry points, no build script, and emits nothing — `exports`
point at TypeScript source, which bun runs natively and Vite compiles:

- `.` → `src/index.ts`, the rulebook barrel. Holds only what `server` and
  `client` consume.
- `./testing` → `src/testing.ts`, fixtures, imported by tests only.

`server` has no barrel and no `exports`; `src/http.ts` is an entry point that
gets run. Nothing imports `server`.

Where things live. What a module exports is its own business — open the file
rather than look for a list here.

```
packages/
  shared/src/
    types.ts          every shared type: coordinates, units, state, commands, events
    coordinate.ts     grid arithmetic, directions, distance, and neighbours
    queries.ts        lookups over a GameState
    legality.ts       what may be selected, and what has acted
    movement.ts       the search, the path check, and the cost model both call
    terrainGrid.ts    character rows into a tile grid
    armyGrid.ts       character rows into unit placements
    action.ts         command validation and resolution, and the Action brand
    move.ts           the move command
    endTurn.ts        the end-turn command
    surrender.ts      giving up: the other player wins
    turns.ts          the action budget, and whose turn is next
    combat.ts         both attacks: damage, ranges, the counter rule, charge
    victory.ts        who has won, and whether anyone has
    applyEvents.ts    the event fold
    protocol.ts       the GameServer interface, the wire shapes, and parsing
    testing.ts        fixtures (makeState, route, at, unitAt, fullMeter), tests only
    index.ts          the barrel
    data/             the static content tables — unit types, terrain, combat
  shared/scripts/
    matchups.ts       prints hits-to-kill
    charges.ts        prints each charge's certain line and odds beside an attack
  server/
    src/
      http.ts         createServer() — Bun.serve routes, /api/* plus the client build
      guest.ts        guest tokens — minted and checked with a key, stored nowhere
      limiter.ts      the limits' counts, in memory, behind a one-method interface
      presence.ts     who has asked about a match lately, in memory
      match.ts        MatchStore — the only reader and writer of matches, and the actor rule
      names.ts        generated player names, made here so the word lists stay out of the client
      joinCode.ts     the six-character codes a waiting game is joined by
      rollLuck.ts     the dice: the only randomness, taking its source as an argument
      db.ts           libSQL client + Drizzle, pragmas, and migrate()
      migrate.ts      the one thing that changes the schema — db:migrate, and the release step
      schema.ts       matches · resolutions · users · seats, typed from shared
      matchState.ts   instantiates a map into the board a match starts from
      maps/           the map registry, and the maps themselves
      const.ts        env-derived defaults
    drizzle.config.ts drizzle-kit config for db:generate, with no credentials
    drizzle/          generated migrations, committed
    schema.sql        the whole current shape in one file
  client/
    index.html  vite.config.ts  public/  scripts/compressDist.ts
    scripts/models/  converts the period figures for public/models/units (Blender)
    src/
      main.tsx    the entry point; App.tsx is the route table beside it
      routes/     the top-level screens
      net/        the HTTP client and the polling GameServer
      game/       the session hook and the canvas component
        interaction/  click handling, pure
        render/       everything Babylon touches
```

## Commands

Run from the repo root. All exit non-zero on failure.

| | |
|---|---|
| `bun run dev` | Vite (5173) + server (3001); the client calls the server cross-origin, as it will from a portal |
| `bun run gate` | `scripts/gate.sh`: forced typecheck, lint, tests, format, build, and no development hook in the bundle — every leg run, each one's exit code on the last line. What CI runs |
| `bun run test` | `bun test` for shared + server, then Vitest for client |
| `bun run typecheck` | `tsc -b` — use `bunx tsc -b --force` for a real check, since `.tsbuildinfo` can report stale |
| `bun run lint` | ESLint across the repo |
| `bun run build` | `tsc -b`, then bundle and compress the client |
| `bun run format` / `format:check` | Prettier (Markdown and exported glTF are excluded) |
| `bun run db:generate` | drizzle-kit writes a migration from `schema.ts` — **from the repo root only** |
| `bun run db:migrate` | applies pending migrations with Drizzle's migrator, through `migrate.ts`; `bun run dev` runs it first |
| `bun packages/shared/scripts/matchups.ts` | Tuning harness: hits-to-kill for every matchup on every terrain |
| `bun packages/shared/scripts/charges.ts` | Tuning harness: the most health each charge is certain of from all three sides, beside what an attack kills, and its odds against full health — by ground and charger health |
| `bun packages/server/scripts/simulate.ts [games] [map] [opener] [budget] [blueArmy] [redArmy]` | Plays the game against itself with a greedy bot and reports outcomes, match length, damage, kills and charges by unit type, attacks by the ground the defender stood on, and whether each mechanic fired. An army is comma-separated rows; omitted, both sides take the default deployment. Its bot closes on the enemy by route length over the bare terrain, not by straight-line distance |
| `bun run preview` | `vite preview` — the built client, calling the server at `API_ORIGIN` like any other copy |
| `bun run --filter '@wargame/client' models [name...]` | Converts the period figures and the houses from the packs into `public/models/units` and `public/models/buildings`, through Blender — by hand, never in a build. `BLENDER` and `AWI_MODELS` say where Blender and the packs are |
| `bun run --filter '@wargame/server' start` | The production shape: one process serving the API and `dist` together |

Single test file: `bun test packages/server/src/match.test.ts` (`-t 'name'` to
filter); client: `cd packages/client && bunx vitest run src/net/gameServer.test.ts`.

⚠️ **The simulator is a temperature check, not an opponent**, and its bot shapes
what it can say. Both sides run the same policy, so a departure from an even
split is the board or the deployment — that is what it says robustly. It
subtracts the expected riposte from each attack's score, so counters look rare
because it avoids them; it never stands a unit anywhere to block; and it never
chooses ground, so its attacks by ground say where fights landed, not what cover
is worth. ⚠️ **Most one-star changes to `defense` move no hits-to-kill at all**
— a star is a percentage and the grid is whole hits — so `matchups.ts` is how to
tell whether one did anything.

`db:*` must run from the root: `file:` URLs in `DATABASE_URL` resolve against
the repo root, and running them through `bun run --filter` sets the cwd to the
package and loses the single root `.env`.

## The pipeline

```ts
validateCommand(state, command, actor)  → { ok: true, action } | { ok: false, reason }
resolveAction(state, action, rolls)     → GameEvent[]
applyEvents(state, events)              → GameState
```

`rolls` is an argument, never a field on `Action`: `shared/` produces no
randomness (invariant 2), so the server rolls and passes them in. `endTurn`
ignores the argument.

| | Direction | Contents |
|---|---|---|
| `Command` | client → server | Intent only. No actor, no dice. Can be rejected. |
| `Action` | inside the server | An accepted `Command`, plus `actor`. Carries a `unique symbol` brand that is never exported, so it can only come from `validateCommand`. |
| `GameEvent` | server → clients | A fact that already happened. What clients animate. |

`validateCommand` checks `actor === state.currentTurn` first, then refuses
everything if the game is over, then dispatches to the per-command validator.
`resolveAction` accepts nothing but an `Action`.

The terminal refusal sits one line above the dispatch rather than inside each
validator, so it covers command types that do not exist yet. The order is
identity, then terminal state, then the per-command check.

## Rules that hold

1. **The database is the only mutable state.** No module-level mutable state
   exists in `server/`; every request reads, computes, and writes back. ⚠️ **One
   named exception: the rate limiter's counts**, held in memory by the server
   that made them. They are not game state, so a restart losing them costs
   nothing, and in the database every limited request would spend a write from
   the quota the limits protect.
2. **`shared/` is pure** — no I/O, no RNG, no Babylon, no React, no `Date.now()`.
   Two checks hold it. The compiler catches `process`, `window`, `document` and
   React or Babylon imports, since the programs that check `shared/src` lack one
   or another of them; the rest — `Math.random`, `Date`, `console`, `fetch`,
   timers, `queueMicrotask`, `crypto`, `performance`, `navigator`, web storage,
   `WebSocket`, `Worker`, `bun` and `node:*` — compile under one program or
   both, and a lint block on `packages/shared/src` refuses them. Tests and
   scripts are exempt.
3. **`GameServer.submit()` is async.**
4. **`GameState` is JSON-serializable** — no `Map`, `Set`, class instance,
   `Date`, or function is reachable from it.
5. **An unvalidated action is unrepresentable** — `validateCommand` is the only
   constructor of an `Action`.
6. **Single source of truth.** A unit's position lives only in `unit.position`;
   occupancy and selection are derived by query.
7. **Ephemeral UI state stays out of `GameState`** — hover, selection, camera,
   animation progress.
8. **The client never resolves outcomes.** It may read any deterministic part of
   `shared/` to preview (what is selectable, where a unit can move); the server
   re-checks all of it.
9. **`applyEvents` is the only thing that mutates state.** Every event is
   **independently applicable** to the state before it and carries **absolute
   values, not deltas**, so applying one twice is a no-op. Idempotence is tested
   per event type; independent applicability by replaying log prefixes.
10. **The client and server share one movement cost model** — `entryCost` in
    `movement.ts` is the single function both the search and the path check
    call.

## State model

```ts
Coordinate  { col, row }
TileType    'plains' | 'road' | 'bridge' | 'forest' | 'hills' | 'river' | 'sea'
            | 'structure'
Facing      'north' | 'east' | 'south' | 'west'      // read by the counter rule; see Combat
PlayerId    string                                   // never a union of colours
PlayerColor 'blue' | 'red'                         // the army a side fields
Player      { id, name, color }                      // colour is display-only
Unit        { id, position, facing, unitTypeId, owner, health, chargeMeter,
              hasActed }
GameState   { grid, units, players, currentTurn,
              winner }                               // grid is [row][col]; winner is null while playing

Command       MoveCommand { type, unitId, path, facing, targetUnitId?, attackKind? }
            | EndTurnCommand { type }
            | SurrenderCommand { type }
Action        (MoveCommand & Validated) | (EndTurnCommand & Validated)
            | (SurrenderCommand & Validated)
              -- a union of intersections, not Command & { actor }: the
              latter would admit an endTurn carrying a path
GameEvent     UnitMovedEvent { type, unitId, path, facing }
            | TurnEndedEvent { type, nextPlayer }
            | UnitsHealedEvent { type, units }
              -- units is [{ unitId, health }], each the healed value
            | BattleResolvedEvent { type, kind, attacker, defender, answered }
              -- attacker is { unitId, health, chargeMeter }, defender
              -- { unitId, health }, every value resulting
            | GameEndedEvent { type, winner }
              -- never emitted beside a TurnEndedEvent

ValidationResult  { ok: true, action } | { ok: false, reason }
CommandResult     { ok: true, seq, events, state, clocks? } | { ok: false, reason }
StateResponse     { seq, state, you, code, clocks, endedBy, opponentHere }
EventsResponse    { seq, events, state?, code, clocks?, endedBy?, opponentHere }
                                       // clocks and endedBy with state
Clocks            number[] | null      // each seat's ms left as answered, by seat
ClockReading      { remaining, at }    // Clocks as a client received them
EndedBy           'board' | 'surrender' | 'clock'
MatchSummary      { id, createdAt, seq, currentTurn, mapId, winner,
                    code, opponent, yourTurn }
CreateMatchRequest { mapId?, mode?, seat?, name?, clock? }  // mode 'hotSeat' | 'remote',
                                                            // clock one of CLOCK_MINUTES
JoinMatchRequest  { code, name? }
MeResponse        { name }                           // GET /api/me
MapSummary        { id, name, width, height }        // GET /api/maps
MapPreview        { id, name, state }                // GET /api/maps/:id/preview
ErrorResponse     { error }                          // the body of every non-2xx
```

**A turn is a budget of actions**, `ACTIONS_PER_TURN` in `turns.ts`, and the
turn ends itself once the budget is spent. It is **`null`** — no cap: every
unit acts once, the player picks the order, and the turn ends when the last of
them has gone. A number caps it instead.

⚠️ **Under a cap, nothing forces rotation.** `turnEnded` refreshes `hasActed`
for the incoming player's whole roster, so at a budget of one the same unit may
act on consecutive turns indefinitely while the rest never move. Uncapped this
is invisible — the roster *is* the budget, so everyone acts once by
construction. It is a property of the budget rather than a separate rule, and
it is what a cap has to reckon with.

⚠️ **The budget is reachable as an argument**, on `actionsAllowed`,
`actionEndsTurn` and `resolveAction`, each defaulting to the constant. Tests
pass it explicitly and cover both regimes, so moving this line moves the game
without moving the suite.

`null` rather than `Infinity`, because `Infinity` does not survive
`JSON.stringify`. The branch tests `=== null`, not `== null` — the loose form
would swallow an explicitly passed `undefined`, which has to fall through to the
default.

```ts
actionsTaken(state)    // this player's units with hasActed set
actionsAllowed(state)  // min(ACTIONS_PER_TURN, this player's roster)
actionEndsTurn(state)  // does one more action finish the turn
```

The `min` covers a player with fewer units than the budget: "everyone has acted"
finishes a turn as surely as "the budget is gone".

`actionEndsTurn` needs no state fold — an action sets `hasActed` on exactly one
unit that lacked it, so the count afterwards is the count now plus one.

The budget is a **default argument** rather than read from the module, so tests
can exercise the arithmetic at any value.

`resolveAction` appends `turnEnded` to a move that spends the turn, reusing
`resolveEndTurn` so exactly one place decides who plays next. **Two events,
never one carrying both effects** — invariant 9.

**The turn's start is part of the hand-over.** `resolveEndTurn` follows
`turnEnded` with `unitsHealed` when the incoming player has a general and any of
their units on the four tiles beside it are hurt: each gains `GENERAL_HEALING`,
never past `MAX_HEALTH`. The general does not heal itself, and nothing is
emitted when nobody heals. ⚠️ **It reads the board the turn ends on** — a move
that spends the turn passes the state after its own events, so a unit the last
move killed is not healed.

**The End Turn command is the early exit**: a player may stop before committing
every unit they are allowed to. At a budget of 1 it is a pass.

Turn order is array rotation over `GameState.players`, wrapping via modulo.
`hasActed` is one flag per unit, set by `unitMoved` and reset by `turnEnded` for
the incoming player only.

`winner` is `null` until somebody wins, and **additive: `currentTurn` is never
cleared beside it**. `getCurrentPlayer` throws when `currentTurn` names nobody,
and the client's turn label calls it every render. `winner` is nullable on the
state and not on the event.

`facing` is **carried, not derived**: the player picks it, so it need not agree
with the direction of travel. The client proposes the travel direction as a
default (`directionBetween`), the command carries the answer, and `parseCommand`
refuses anything but one of the four. A single-element path plus a facing is a
**turn in place**, and it spends the unit's turn like any other action.

**A defender's facing is never changed by being attacked.** It answers from
where it was left looking.

## Content — `shared/src/data/`

Static tables keyed by `Record`, so adding a member makes every incomplete table
a compile error. **The values are the modules' — read them there.**

**`unitTypes.ts`** — `{ id, name, char, movementType, movementRange, range, slow,
melee, attacksToCharge }` per type. `range` is `{ min, max }` tiles, inclusive, read by
`refuseAttack`, `tilesInRange` and `wouldCounter`. ⚠️ **It classifies
nothing:** there is no direct/indirect flag, and a minimum range describes a gun
rather than naming a kind of one — which is what lets a single rule ask "is the
attacker inside my own range" and get an answer for every unit.

⚠️ **`slow` and `melee` are what no distance could express**, so they are flags.
`slow` governs a *turn*: a slow unit may move or attack, never both, and never
answers an attack — see *Slow* below. `melee` governs a *weapon*: a melee unit
fights hand to hand, so it cannot answer a ranged attacker, though its own
attack is answered as any other is. Cavalry and the general are melee; infantry
and guns are not. `attacksToCharge` is how many attacks fill a unit's charge
meter, or `null` for a type that cannot charge — guns; see *Charge*. ⚠️
Required, so a new unit type has to say.

**The general** is cavalry in all but name: a horse, cavalry's range, flags and
charge meter,
and cavalry's row and column in `BASE_DAMAGE`. What sets it apart is outside the
catalog — losing it loses the match (see *Victory*), and units beside it heal as
their turn begins (see the hand-over above). `generalOf` in `queries.ts` is the
one place the rules name its type.

`movementType` is `foot`, `horse` or `wheels`, and picks a column out of the
terrain cost table; `movementRange` is the budget that column is spent against.
Also `MAX_HEALTH`, a constant beside the interface rather than a field on it:
nothing varies it, so a per-instance copy would be one number written once per
unit. ⚠️ It lives here so that the day some unit is tougher than another, it
becomes a column of `UnitType` and the edit is local. `GENERAL_HEALING` sits
beside it, a fifth of it.

**`combat.ts`** — every number combat reads, and nothing else. Two tables:
`BASE_DAMAGE` (attacker → defender, as a percentage of a full-health target,
read by attacks and charges both; the general's row and column copy cavalry's) and `CHARGE_FACING` (what a charge's damage is
multiplied by, per side). Then the scalars, each explained where it is used
rather than here: `LUCK_MAX` in *Combat*.

⚠️ `BASE_DAMAGE` is a matrix rather than an attack stat and a defence stat: no
pair of scalars can express rock-paper-scissors, since any `f(attack, defence)`
is transitive.

**`terrain.ts`** — `{ char, defense, cost }` per terrain. `char` is the symbol a
map is drawn with; `defense` is stars of cover, read by `computeDamage` on
Advance Wars' scale — each takes a point off a hit per band of the defender's
health. Road, bridge, river and sea carry none. ⚠️ **How many stars ground may carry
is written nowhere as a number**: the *no living attacker is harmless* sweep is
the limit, and it follows from the damage table. `cost` is
movement points to *enter*, one per movement type, with `null` for impassable —
which makes a river a wall to wheels, a toll to boots, and most of a turn to a
horse. Costly and impassable are different answers: hills are expensive for
horse and `null` for wheels. **Sea is `null` to everyone**, and fire crosses it
as in Advance Wars. **A structure is the stoutest cover yet costs every arm the
same as road**, as Advance Wars prices a city — so a gun can hold one.

⚠️ **`road` and `bridge` are identical in *both* columns**, so they are
indistinguishable to every rule that reads them — the split exists only so the
renderer can draw a crossing over water.

`getUnitType` and `getTerrain` throw on an unknown id.

## Maps

Every grid comes from parsing a character map; there is no other construction
path. `parseTerrainGrid(rows: string[]): TileType[][]` inverts the terrain
table's `char` column and throws on an unknown character or a ragged row.

Maps are modules in `server/src/maps/`, registered by id:

```ts
interface GameMap {
  id: string;
  name: string;
  rows: string[];                                       // parsed by parseTerrainGrid
}
```

**A map is terrain and nothing else.** Units are deployed onto it by
`createMatchState`, which takes a **`Deployment` per player** — that player and
the army they field — defaulting to one hardcoded pair beside the hardcoded
`PLAYERS`, because nothing *chooses* an army yet. ⚠️ **Players are named by
seat**, `player-1` and `player-2`, and the colour is a field beside the id —
seat 1 blue and seat 2 red for now — so nothing that identifies anyone says a
colour. `playerInSeat` and `seatOf` are the one tie between a seat's number and
its player: seat *n* is the *n*th player in the state. `holdsTheTurn` asks
whether some seats include the one to move — the server's actor rule and the
client's *is it my turn*, one answer. ⚠️ **Every match is between `PLAYERS`**,
so the list answers whose turn a row records from `current_turn` and that
roster, without reading the board.

```ts
interface Deployment { player: Player; army: string[] }
interface DeploymentZone { width: number; depth: number }
```

⚠️ **The army binds to the player; the seat stays positional.** Pairing the two
is what stops a second array agreeing with `PLAYERS` by index — but the *edge*
is still read off list order: first deploys on the near edge looking north,
second on the far edge looking south. **The two sides need not match**, in
composition or in count.

⚠️ **An army is not on `Player`, and what decides that is who reads it.**
`Player` lives in `GameState`, which is JSON in two columns on every write, and
no rule reads an army — once units carry `owner` it has done its job and is
derivable by grouping them.

**Units are placed in a `DeploymentZone`**, `DEPLOYMENT_ZONE` in `matchState.ts`:
a rectangle against the player's own edge, wherever along it the map puts it.
⚠️ **An army
grid is exactly the zone's size, not merely bounded by it** — padded with
empties, which is what makes an *offset* deployment expressible at all:

```
'iiii......'    // four foot on the player's own left
'...iiii...'    // the same four, centred
```

⚠️ **Where an army stands is therefore the zone's and the map's, never the
army's.** Nothing about placement varies with what is fielded, so `armyWidth` is
read as a *check* — is this grid the zone's width — rather than as an input to
the sum. A grid of the wrong size is refused, naming the player whose army it
is.

**The zone's size is the same on every map, and where it sits is the map's.**
`GameMap.zoneStarts` gives the board column of each seat's westmost zone
square, near seat first; a map that says nothing is centred, the far zone being
the near one turned, so on a board with an odd spare column it sits a column
east. A declared start that is not a whole number, or leaves the zone off the
board, is refused naming the seat. The rows nearest each edge are taken, on a
board of any size that fits both zones — `createMatchState` refuses one that
does not. **The size is reachable as an argument**, the shape `ACTIONS_PER_TURN`
has and for the same reason: the suite deploys onto boards this game never
ships.

Parsed by `parseArmyGrid` over a `char` column on `UnitType`, the same shape
terrain has. ⚠️ `.` means *empty* in an army and *plains* in a map — one
character, two grids, and no row is ever parsed as both.

Each army is laid from its own edge, and the second is **turned within its own
zone** — not copied into it, which would run both lines the same way down the
board. Facing is toward the enemy: north for the first player,
south for the second. Unit ids are `p${seat}-${n}` in **army scan order**, row
then column, **within that player's own army** — so each side numbers from 1
whatever the other fields — and are deterministic because `initial_state` plus
the log must replay identically.

**A board too small for the zones is refused, not clamped.** ⚠️ Placing a zone
wider than the board would deploy units at negative coordinates — a state that
parses, stores and replays while being wrong from the first frame. The depth
check sums the zones rather than doubling one.

**What a map owes a player is a zone they can fill.** `wheels` cannot enter river
or hills at any price, nor anything sea, so a board that draws them inside a
zone strands whatever is put there. ⚠️ **`maps.test.ts` checks every square of both
zones, for every movement type the terrain table prices** — not the squares one
army happens to occupy. That is the stronger property, and it caught a pond
inside a zone on `lakeland` that the army-based check could not see. Each
movement type deployed must also reach more than half the board's **land** from
where it starts — land rather than tiles, since a board may be mostly sea.

⚠️ **Map ids are immutable.** A match records the id it was built from, so
changing a map's terrain under its id retroactively changes what every existing
match claims to have been played on. A changed map gets a new id.

`getMap` throws on an unknown id, and **`rows[0]` is the row nearest the
camera** — row index increases north, so a map written out top-down is upside
down in the source.

**Boards are skirmish-sized**, those drawn for this game and those drawn from
Advance Wars alike, with a smaller `tester-2`. A board may be any size that fits
both deployment zones, and `createMatchState` refuses one that does not; a map
that does not declare its zones has them centred. ⚠️ **`maps.test.ts` also
holds every board to a few limits**: a longest side — deep enough for a couple
of turns to set up and take ground before the armies meet, and as wide as the
default army fills; only a few buildings, since cover everywhere is cover
nowhere; water a tile wide drawn as river, never as sea; and no water open on
three sides with land at a diagonal between two of them, which no piece in the
tile set draws without a square corner.

**A board from Advance Wars** is drawn from one of Dual Strike's maps, by way of
Advance Wars By Web's copy (awbw.amarriner.com), turned so the two headquarters
face each other across the near and far edges — a rotation, never a mirror —
and redrawn at a skirmish board's size. What makes it that board is kept — its
ridges, its water, the shape of its roads — and the rest drawn fresh; its
buildings are the few that guard a gap, a crossing or a junction. Its mountains
and pipes are hills, a pipe's seam a gap; its properties are structures; and
its shoals are plains, since every land unit crosses one at a plain's cost.
Each board's comment names its source and what is particular to it.

**Four rules hold across the boards drawn for this game**, and they are design
rather than code — nothing enforces the last two but the eye. The boards drawn
from Advance Wars keep the first three and take their ground from their
originals:

- **Deployment zones carry nothing but plains and road**, so no side starts in
  a wood or on hills, and `maps.test.ts` refuses ground a unit cannot stand on
  there.
- ⚠️ **Roads are one tile wide, everywhere.** A two-lane road was never a wider
  road — it was two roads — and it doubled the width of every corridor it drew.
  The renderer does not care: `bridgeTurns` turns a deck toward whatever is not
  water at its ends, which answers at any width.
- **Every board has road reaching into both zones.** `wheels` pays less to
  enter road than plains, so a road multiplies a gun's reach for the turn —
  which makes where the road goes the same question as where artillery can be,
  and a board with no road one that arm cannot play. ⚠️ **The multiplier is not
  a fixed number**: it falls out of `movementRange` against those costs, so
  retuning the gun moves it.
- ⚠️ **Broken ground belongs in the middle rows, and in pieces.** Cover beside a
  deployment zone decorates a start; cover in the contested middle is a position
  somebody has to take. Discrete masses rather than a blanket, so one side can
  hold one and the other has to answer it at range.

| | |
|---|---|
| `classic` | A river across the middle with a single crossing. Infantry ford anywhere, cavalry at a price, and `wheels` not at all — so the bridge is the whole board. ⚠️ **The approaches are different ground**: a wood beside the road on the near bank, a rise beside it on the far one |
| `crossroads` | A road network closed into a figure of eight, with a wood in two of its cells. No water and no high ground, so nothing is impassable and cost is the only thing shaping a move — which makes it the board artillery likes. The woods sit diagonally opposite, one per player |
| `two-bridges` | One river bent through a right angle with a crossing on each arm. ⚠️ The only board carrying **both deck orientations**, so it is the only one that exercises all of `bridgeTurns`. Broken ground is all on the east side, leaving the west a road corridor |
| `lakeland` | A lake ringing a **wooded** island, and a road down the west shore. The island is where the water's price shows: infantry wades across in one turn, cavalry needs two and spends the night in open water at zero defence, and artillery never arrives at all — so it is cover no gun can ever take, only shell |
| `meadow` | Open field with one **lateral** road straight across and a spur down to it from each side. A road across rather than along helps you redeploy along your own line more than it helps you advance, and ⚠️ **the two spurs do not line up**, so neither player has a straight run at the other |
| `common` | Open field with the road up the middle — the fast way *at* the enemy — and a rise on one flank of each approach, ⚠️ **diagonally opposed** so the same plan does not work from both ends. A wood beside the road at the centre is the only real cover anything can occupy, and it is equally far from both |
| `missile-plains-12` | From Dual Strike's *Missile Plains*. Two ridges across the board, each with one gap, staggered, and one road threading both — wheels zigzag from gap to gap while foot climbs straight over |
| `twin-isle-12` | From Dual Strike's *Twin Isle*. Two shores of a strait, each a ridge inside a ring road, joined by one neck — the only way across for anything. Each half the other turned |
| `ridge-island-12` | From Dual Strike's *Ridge Island*. A ring road round two staggered ridges, and a bay in two opposite corners, the zones declared clear of them. Each half the other turned |
| `mirror-islands-12` | From Dual Strike's *Mirror Islands*. A river bending across the middle, bridged at either end of the bend, and a ring road either side of it. Each half the other turned |
| `little-lion-12` | Drawn after Dual Strike's *Little Lion*. The armies in opposite corners, a ridge and a lake in each of the other two, and one road from each army meeting in the middle; the zones declared toward the corners |
| `tester-2` | A 10×10 board for playtesting: the road straight down the middle, a river two tiles wide across the midline under a long bridge, a wood beside the road on the near bank and a rise on the far one. The smallest board, so the armies meet soonest |

⚠️ **A river may only leave the board where a deployment zone is not.** The
zones are the two rows at each end, as wide as the zone and where the map puts
them, and `wheels` cannot enter water or rock, so neither may be drawn there. `two-bridges` shows it: its
north–south arm stops one row short of the edge. ⚠️ This is now **checked rather
than kept by hand** — see `maps.test.ts` above.

`StartScreen` picks between them and `POST /api/matches` carries the choice;
omitting it takes `DEFAULT_MAP_ID`.

The test fixture `makeState` accepts either map rows or a size, and a size
generates a plains character map and parses that. ⚠️ Plains carry a star of
cover, so a test that means *no cover* draws its own rows with road.

## Movement

```ts
exploreMovement(state, unit, movementRange, movementType) → Movement
  .reachable                   // Coordinate[] — where the unit may stop
  .settled                     // Coordinate[] — everything the search touched
  .pathTo(destination)         // Coordinate[] | null — cheapest route
```

The budget and movement type are arguments; callers resolve them from
`getUnitType`. The search relaxes over a FIFO queue: a neighbour already
recorded more expensively is lowered and re-queued.

⚠️ **The four touching tiles come from `orthogonalNeighbours` in
`coordinate.ts`**, which is the same argument `tileDistance` makes in its own
comment: written inline at each caller, it is that many chances to disagree
about a diagonal. It was inline three times — this search, the client's facing
choices, and the terrain tiler's flood fill — and one of the three was spelled
`neighborsOf`, the only American spelling in the codebase, so a grep for the
others missed it. ⚠️ It is **unclipped**: the search rejects a tile by cost and
the panel by the board's edge, so folding either filter in would make the other
pass bounds it has no use for. The tiler's `neighbourMask` still writes its four
out longhand, because there the order *is* the meaning — they pack into bits
`N=1, E=2, S=4, W=8`.

`reachable` and `settled` are different sets, and they answer different
questions. A friendly unit's tile is settled and walkable-through but is not a
destination — unless it stands in contact, which makes it a dead end — so `pathTo` answers for a larger set than `reachable` lists. The
unit's own tile stays in the map — every path chain terminates there — and
`pathTo(unit.position)` is `[position]`.

**`settled` is what the range overlay draws; `reachable` is what decides a
click.** Not everything lit is clickable: the overlay answers *how far can I
go*, `handleTileClick` answers *may I stop here*, and a click on a friend
selects it instead.

`settled` is **exactly** the set `pathTo` answers for, and a test says so.

An enemy blocks the tile *and* the route; a friend blocks only the tile.

**Contact ends a move.** A unit is in contact on any of the four tiles
orthogonally beside an enemy — any enemy, guns included — which `inContact` in
`queries.ts` decides. Such a tile may be entered but not passed through, so
getting past or round the enemy takes a berth wide enough to stay out of
contact. ⚠️ **The origin is exempt**: a unit that starts in contact may walk out
of it, which is why `stops` is recorded per tile entered rather than asked of
wherever the search happens to be. ⚠️ **No catalog field and no marker** — being
beside the enemy is the whole of it.

```ts
validatePath(state, unit, path, movementRange, movementType) → string | null
```

Walks a client-supplied route: starts at the unit, every step orthogonally
adjacent, no tile twice, nothing impassable or enemy-held, no tile in contact
before the last, total within budget, and a destination unoccupied by anyone but
the moving unit. A single-element
path is legal and costs 0. The server never derives a route.

Both the search and the walk call `entryCost(state, unit, coordinate,
movementType)`, which returns `{ ok: true, cost, stops }` or `{ ok: false,
reason }` — the one place that decides whether a tile can be entered, what it
costs, and whether entering it ends the move.

## Combat

`shared/src/combat.ts` holds the rules of both attacks and no state:

```ts
refuseAttack(state, attacker, path, targetUnitId) → string | null
refuseCharge(state, attacker, path, targetUnitId) → string | null
tilesInRange(unit, from, gridWidth, gridHeight)   → Coordinate[]
wouldCounter(defender, attacker)                  → boolean
chargeDamage(state, attacker, defender)           → number   // what a charge is certain of
chargeChance(state, attacker, defender)           → number   // 1..100
chargeReady(unit)                                 → boolean  // the meter is full
resolveBattle(state, attacker, defender, rolls)   → BattleResolvedEvent   // attack
resolveCharge(state, attacker, defender, rolls)   → BattleResolvedEvent   // charge
computeDamage(state, attacker, defender, roll)    → number
```

One private `outsideRange` answers which side of the band a distance falls off,
and both callers use it: `refuseAttack` turns it into a reason, `wouldCounter`
asks whether there is one.

**A counter fires iff the defender survived, is not `slow`, is not a `melee`
unit answering a ranged attacker, has the attacker inside its own range, and was
not attacked from directly behind.** One predicate; reach decides everything but
the two flags.

⚠️ **The `slow` conjunct subsumes the band's lower end**, so the band's *too
close* case is not observable through `wouldCounter`: artillery is the only unit
with `min > 1`, and it is slow. `refuseAttack` reads both ends, and is where
that half is tested.

### Slow

```ts
slow: boolean   // artillery, and nothing else
```

A slow unit may move **or** attack in a turn, never both, and never answers an
attack. The two rules are enforced in different places, because they are asked
at different moments:

- `wouldCounter` returns false outright, before the band and before facing. A
  slow defender never answers, at any distance, from any side.
- `refuseAttack` and `refuseCharge` refuse when the unit has **moved**, which is
  `path.length > 1`. Turning in place is a single-element path and so is not
  moving: a gun may pivot onto a target and fire in one action.

Both refusals take the whole `path` rather than the destination, because where a
unit ends up does not say whether it travelled.

Moving alone is legal. The flag forbids the pair, not the movement.

### Contact

The same refusal has a second cause. **A unit that starts its action in contact
may move or attack, not both** — attack from where it stands, turn in place and
attack, or move and then not attack. `refuseMovingAttack` is the one place the
turn rule lives: `slow` puts a unit under it always, and starting in contact
puts any unit under it, asked of `path[0]` because where a unit ended up does not
say where it began.

A unit that starts in the open moves and attacks as it always has, including
moving *into* contact and attacking on arrival, which is how contact is made. A
withdrawal may end in contact with another enemy. A unit in contact may charge
without moving, since that is attacking from where it stands.

⚠️ **Mutual.** A unit that rides into contact is in contact itself, and is
committed the same way on its next action.

### Facing

**Facing does exactly two things**: an attack from directly behind goes
unanswered, and it scales a charge — what it is certain of, and its odds
against a full-health target. `computeDamage` cannot see facing at all, so
there is no modifier on the *outgoing* attack — position limits the reply, it
does not sharpen the blow.

A single-element path is a **turn in place** — legal at cost 0, and a real
defensive action.

**An attack always ends facing its target.** `validateMove` refuses any other
facing on a command with a target — the dominant axis, the row on an exact
diagonal, as `facingToward` decides — so only a plain move chooses where it
looks. A charge's displacement rides on facing the same way.

### An attack from behind is never answered

Where facing changes an exchange. Position affects *whether* there is a reply,
never what the attack itself does. Front and flank both draw a full counter.

⚠️ **The forecast shows the whole rule.** `attackForecast` reports *they counter
attack* or nothing, and since the only thing facing can do to a reply is remove
it, that is all there is to say.

`wouldCounter` takes the attacker, which carries its own position and type;
facing it reads off the defender. `resolveBattle` is its one caller, and the
client's `attackForecast` and the simulator's bot both ask `resolveBattle`, so
they get every part of the rule without a copy of it.

It negates the counter rather than shrinking it, and only where a counter was
possible at all.

`coordinate.ts` classifies:

```ts
attackSide(defenderFacing, defenderAt, attackerAt) → 'front' | 'flank' | 'rear'
```

⚠️ **`attackerAt` is measured *from* the defender.** The direction from a unit
to its attacker equalling its facing means it is *looking at* the attack, which
is `front`. Read as the direction the attack travels, every case inverts and no
individual result looks wrong. Diagonals inherit `facingToward`'s tie-break.

⚠️ **The counter reads only `rear`; `flank` is read by the charge alone.**
There is no flanking damage bonus.

⚠️ **The test fixture's `facing` is a rule input.** `makeState` defaults units
to `south`, which decides whether a counter happens, so anything asserting one
states the defender's facing rather than inheriting it.

**`hasActed` is not consulted.** Answering an attack is not acting, so a spent
unit still counters. **A charge never asks the counter rule at all.**

`tilesInRange` lives in `shared` so the band is stated once, and the client
paints its overlay from it.

**The client previews the same formula.** `attackForecast` runs `computeDamage`
at roll 0 and at `LUCK_MAX`, which is an **exact range**: damage only ever rises
with the roll, so those are the true floor and ceiling. ⚠️ The width is
`LUCK_MAX` only for a full-strength attacker onto ground with no cover; a
weakened attacker or a defender in cover narrows it. The counter's *magnitude* is
absent — it is computed on the defender's post-damage health, so it depends on
how the attack roll lands. `answered` is read at the **worst** roll, so it means
*they will counter attack unless you kill them*.

The client is told the shape of the outcome and never the roll.

`Rolls` is `{ attack, counter, charge }` — named members rather than a tuple.
`attack` and `counter` are luck rolls on 0–`LUCK_MAX`; `charge` is 0–99, read
against a charge's chance. ⚠️ **Every command draws all three, whether or not
any is used** — an end of turn uses none, an attack leaves the charge roll
unread — so the number of draws never depends on the rules. `resolveBattle`
takes only the pair it reads, so a forecast or the bot resolving an attack
passes two.

⚠️ **`from` is where the attacker *ends up*, not where it stands.** A command is
move-then-attack. `validateMove` passes the last tile of the path.

⚠️ **`resolveBattle` is given the attacker as it is *after* moving**, because a
counter-attack reads the *attacker's* terrain, which is the destination's.

All three are pure and take the roll as an **input**.

```
band(hp) = ceil(hp / 10)                    // 1..10, never 0 while alive
damage   = floor(floor((base + luck) × band(attackerHP) / 10)
                 × (100 − stars × band(defenderHP)) / 100)
```

**Health is stored and shown 0–100.**

⚠️ **Both health terms in the formula read the ten-point band, never the raw
value.** Feeding raw health in makes a unit on one point attack at 1% instead of
10%, and the floors swallow it entirely — there is no minimum-damage rule, and
the banding is what stands in for one. The cost: a unit at 91 health and one at
100 fight identically.

⚠️ **Luck joins the base before anything scales it** — Advance Wars' order in
every game in the series. The attacker's band and the defender's cover then scale
luck with the rest, so a wounded unit's luck shrinks with it and a unit on its
last band cannot luck its way into an extra tenth. A dead attacker needs no guard:
`band(0)` zeroes the luck along with the base.

⚠️ **No clamp stops cover exceeding a whole hit**, and none is needed: the *no
living attacker is harmless* sweep in `combat.test.ts` fails as soon as cover
floors the weakest hit to nothing, which comes well before cover could reach a
whole hit and heal. That sweep is the limit on stars.

Three behaviours fall out rather than being rules: a wounded attacker hits
softer, a wounded defender loses its cover (the terrain term scales by *defender*
band, so damaged units cannot turtle on a peak), and striking first compounds.

The counter is `computeDamage` called a second time in the other direction, on
the defender's *post-damage* health. **The attacker's blow lands even when the
reply kills it.**

**One battle is one event.** `battleResolved` carries both resulting healths,
the `kind`, and `answered`.

⚠️ **There is no `unitDied` and no `died` flag.** *A unit at zero health leaves
the board* is stated once, in `applyEvents`, and that reducer's filter is
broader than "whoever this event killed" — which is what keeps applying the
event twice a no-op.

`answered` is carried rather than derived: reconstructing it means re-running
the counter predicate against a rebuilt state.

⚠️ **The event union is exhaustively checked.** `applyEvents`' default branch
assigns to `never` before throwing, so a new member is a **compile error** until
it is handled. The throw stays, because events arrive as JSON.

**Randomness lives in `server/rollLuck.ts`**, in `rollLuck` — the only
`Math.random()` in the codebase. No seed is stored: events carry resulting
values rather than inputs. ⚠️ **The rolls are recorded** in `resolutions.rolls`,
because luck joins the base before two floors and so cannot be read back out of
the damage it produced. Replay never needs them — it reads outcomes — and they
never go in an event, since events reach both players and a client is told an
outcome and never its roll.

### Charge

An attack earned by attacking: certain against a target worn down far enough,
and a gamble against a stronger one.

```
D      = floor(computeDamage(state, charger, target, LUCK_MAX) × CHARGE_FACING[side] / 100)
end    = CHARGE_CHANCE_AT_FULL × CHARGE_FACING[side] / 100
pinned = 100 − (100 − end) × (targetHealth − D) / (MAX_HEALTH − D)
chance = targetHealth ≤ D ? 100 : max(1, floor(pinned × chargerHealth / MAX_HEALTH))
a charge is legal  ⇔  chargeReady(charger), in contact, ground it can stand on
it breaks through  ⇔  rolls.charge < chance
```

**The charge meter.** `Unit.chargeMeter` fills a point for every attack the unit
makes, up to its type's `attacksToCharge`, and a charge spends all of it,
whether it breaks through or not. Answering an attack fills nothing. It rides
as an absolute value on the **attacker's** side of `battleResolved`, the only
side that carries one, so the fold stays exact. ⚠️ **A unit that cannot charge
never fills one**: a `null` size decides both, and the meter stays 0. ⚠️
**`chargeReady` is *at least* full**, so a meter above its size — a match
stored before the size came down — is ready, and its next attack brings it
down to the size. A unit read back without the field is never ready, since
`undefined >= n` is false.

**Breaking through** takes the target to zero health — an ordinary
`battleResolved`, so the reducer's `health <= 0` filter removes it — leaves
the charger's health as it was, and the charger rides onto the tile.
`answered` is false.

**A failed charge is met by a free attack**: the defender's own `computeDamage`
on the charger, with the counter roll, whatever the counter rule would say —
a gun, a melee unit and a defender charged from behind all hit back. It is the
defence every unit has, and it can kill the charger. The target is unhurt, the
charger stays where it charged from, and `answered` means *repelled*.

**Offered whatever its odds**, which never fall under 1%. `refuseCharge` asks
only whether the unit can charge and is ready, contact, and ground the charger
can stand on;
the target's strength sets the chance, and the chance is what the player weighs.

**`chargeChance` is the one home for the odds**, read by `resolveCharge`, the
client's forecast, the bot and the harness. Certain at or under `D`; above it a
straight line down to `end` at full health — `CHARGE_CHANCE_AT_FULL` scaled by
the side's `CHARGE_FACING` — and then the whole of it multiplied by the
charger's own health, so a wounded charger's gamble is a long shot. ⚠️ **The
price of scaling the whole curve is a cliff just over the line**: a wounded
charger certain of one target is a long shot against one a few points
healthier. Accepted; scaling only the end left a badly wounded charger breaking
a healthier unit most of the time. ⚠️ **Worked in whole numbers**, hundredths of a percent
until one floor, and never rising as the target gets healthier — checked over
every charger, target, ground, side and pair of healths.

**`chargeDamage` is the attack formula, not a second one**: `computeDamage` at
the best roll, `LUCK_MAX`, then multiplied by `CHARGE_FACING` for the side.
Cover and the charger's own health therefore work exactly as in an attack. A
charge is sure of its damage where an attack only might roll it, and the flank
and rear finish more, so getting round a unit is what a charge is for. The best roll rather than a rolled one, because the line
the odds fall from has to be known before anything is rolled. The multiplier
goes on the final damage, so nothing inside `computeDamage` changes.
`chargeChance` and the harness read it.

⚠️ **The side is read from where the attacker will be standing.** `resolveMove`
hands `resolveCharge` the unit at the path's last tile, and the client's
forecast builds the same one — so the server and the panel price the same
tile. This is `attackSide`'s second reader and the only
one to consult `flank`; the counter's rear rule uses only its `rear` case.

⚠️ **Capability is `attacksToCharge`.** Artillery's is `null`, which is the only
place *artillery cannot charge* is stated. Any unit is still a valid
**target**. ⚠️ **`BASE_DAMAGE` tunes charges too**, so raising an entry raises
what a charge is certain of — and a charge from the rear can be certain of a
full-health unit, which is accepted as what getting behind it with a full meter
is worth.

**A charge never consults the counter rule**: one that breaks through kills,
and one that fails is met by the free attack above.

**Contact, not a range band.** A charge has to reach the target, whatever the
charger's own range — infantry shoots two tiles and charges at one.

⚠️ **The displacement is a second `unitMoved`, appended after the battle**, on
every charge. The defender leaves the board when its health hits zero, so
displacing first would put the attacker on an occupied tile — breaking invariant
9's *makes sense against the state immediately before it*. It is the only place
two `unitMoved` for one unit appear in one batch. `playEvents` skips a move
whose mesh already stands at the destination, which is true of the previewed
approach and false of the displacement; that asymmetry is what makes it work.

⚠️ **`terrainAdmits` is split out of `entryCost` for this.** A charge displaces
onto the target's tile, so the attacker must be able to stand there — and
`entryCost` refuses that tile for being *enemy-held*, the one objection a charge
is not troubled by. Sharing the terrain half is what stops movement and charge
disagreeing about what ground a unit may be on.

### The combat cutaway

A battle staged as two ensembles on one ground, drawn in a modal over the board
while it resolves — two framed panels side by side, as Advance Wars lays out a
battle — with a DOM readout printed in each. `render/cutawayPlan.ts`
decides what happens, `render/cutaway.ts` stages and plays it, and
`playEvents` plays it as its own branch on `battleResolved`.

**The plan is pure, and tested.** From the two unit types, each side's health
before and after, the battle's kind and `answered`, `planBattle` returns each
side's members, a list of timed cues, and when each side's blow lands. The
renderer builds it and hands it to the stage, so the readout can use those times
too.

- ⚠️ **Each band of health is a figure** — `band`, the health ring's own count —
  a figure a band for infantry (ten men) and cavalry (ten riders), one for two
  bands for a general's escort and a gun's crew. The gun stands while its unit
  does, and a general is kept to the last, as each ensemble's keeping order
  says: the tail of it falls first, so a weakened unit stands as a block and
  its losses come off the flanks.
- **An attack**: foot present and fire, a gun fires and its gunners ram, and
  horse ride right up to the enemy's front rank — the lines just overlapping,
  `STAGE.reach` apart — and cut; the defenders flinch and as many fall as
  bands were lost, one after another, and if the attack is answered the
  survivors strike back, a melee answer cutting where it stands since the
  lines have met. ⚠️ **A mounted attacker then rides back** to where it stood
  and turns to face the enemy again, rather than staying among them.
- **A charge** runs at the enemy. ⚠️ **One that breaks through always kills**,
  so every defender falls as it passes, and it runs on off the back of their
  ground. ⚠️ **One that fails is met by a free attack** as it reaches their
  line: it stops, its losses fall, and the rest turn and flee off their own
  ground.
- **Beats, not animations.** A cue says `ready`, `strike`, `flinch` and so on;
  a table per body says which animation answers, and a body with no answer sits
  the beat out — the gun does not flinch, crew do not strike, only gunners
  reload. `strike`, `reload`, `flinch` and `fall` play once and hold their last
  frame; ⚠️ **the fallen stay down** until the cutaway closes.
- No two figures start a beat at once: each is a stagger behind the last, and
  each member stands off the grid by a hand-set nudge.
- **The timings are one block of constants**, `TIMING`, with the speed of a run
  by body; the stage's distances are `STAGE`.

⚠️ **One camera over one ground, framed as two panels.** Each side has a half
of the ground, the seam between them at the modal's middle, so a charge runs
from one half into the other; the page draws each half's frame and a solid
divider over the seam, so the two read as two shots. The camera looks back
along −z, so screen-left is east: the attacker stands east of the seam facing
west, and the defender west facing east.

⚠️ **Each side stands turned as it faces on the board**, against the enemy:
square on, flank on, or with its back turned — the renderer counts the quarter
turns from the unit's facing to `facingToward` the enemy, the same comparison
the rules make for front, flank and rear. Any figure that readies, rides up,
strikes or charges turns to face the enemy first, so a line taken in the flank
turns to answer, and one taken in the rear, never answered, takes it in the
back.

⚠️ **Every line slants the same way across the screen.** A rank runs across the
stage, straight away from a camera square to the battle, so five men read as a
column; slanted, the line lies across the screen and every man shows. The same
way on both sides, so two lines that meet meet along their length.

**Where the modal is, `render/band.ts` says**: two square halves and the
divider, as tall as three quarters of the canvas unless the canvas is too
narrow, centred. The renderer computes the box, sets the camera's viewport to
it and hands it to the page with the battle — and again if the canvas resizes
— so the camera and the panels the page draws over it cannot disagree.

⚠️ **A second camera — not a second scene, and not the board's camera moved.** A
second scene would load every model again. Moving the board's camera would
fight its locked radius, its clamped tilt and `holdTheBoard` re-clamping the
target every frame, then have to restore all three. ⚠️ **And the board's camera
never gets a viewport**: `holdTheBoard` sizes its ortho extents from the
*canvas* aspect every frame, so a viewport would leave the board fitted to a
shape nobody is drawing. The stage's camera draws over the full-canvas board.

**Each side stands on its own tile, drawn at the figures' scale.** The cell is
the board's own, from `composeTerrain`'s result, and the half is built from it
with `TerrainModels.instantiate`:

- Its ground stretched over the half — a road as grass with a straight road
  under the line, since a road piece bends with its neighbours; a river as
  open water, its figures standing knee-deep in it, below the surface.
- What a unit stands on — a hill's rock, a bridge's deck —
  stretched under the line from the seam out, so two sides' footings meet,
  wide and deep and no taller than `RISE` says. A bridge is the kit's flat
  middle span, since a one-tile bridge ramps down at its ends; a hill's rock is
  raised to about a man's height, since at its own half a man its sides read as
  a path round a field. Figures stand on it at the height `standHeight` gives —
  the board's own formula, beside `TerrainCell` — with the footing risen, and a
  runner takes the height of whichever half it is over.
- Scenery at its true size beside a man — trees a few men tall close behind
  the line and two at its outer end, tufts and flowers at the knee — as much of
  it as the kind of ground carries, placed the same way each time, only where
  the camera sees, and kept off the ground under the line. A village's own
  houses, the ones on its tile, stand in a row behind the line at true size,
  their doors to the camera: the street the unit fights in, its upper storeys
  above the frame.
- ⚠️ **The gun is drawn larger than true**, beside its crew, since at true size
  it is a toy among them.

**The camera looks down at 30°** and is fitted to what stands on the stage:
every figure, by its kind's size, at the height its ground stands, as close as
the modal's shape allows. ⚠️ Each figure's corners are projected into the
camera's view before they are measured; the framing is centred on the seam, so
the divider falls on it, and refitted whenever the canvas resizes. The
readout's strip is reserved in the **camera**: the figures fill the top of the
view and the ortho bounds hang below them. A **backdrop plane** stands far
behind the stage along the line of sight.

**Built per battle and torn down after**, rather than pooled: a figure is about
a millisecond to build and half a megabyte to hold, so a battle's few dozen
cost a frame or two as it opens and nothing once it closes.

⚠️ **One clock.** The cues, the runs and the board's death blink all advance on
the scene's animation time, through `render/clock.ts`, never on timers. A hidden
tab draws no frames, so nothing advances; on return Babylon advances by the
whole time away in one frame, and the battle completes and closes rather than
freezing or replaying.

**The readout is DOM.** A full bar at the true health with the number beside it,
not the board's ten bands, with the band lines drawn over it. ⚠️ **It holds at
the health before until its side's blow lands**, the plan's own moment, and
falls then, with the figures rather than before the first shot. ⚠️ It carries a
battle **id** so each side remounts rather than correcting itself in an effect.

⚠️ **It ends when its plan has played**, with no click and no early exit. The
overlay still covers the canvas and swallows pointer events, since a click
during a battle would be read against state the board is not yet showing.

**The dead fall on the board after it.** Once the modal closes, a unit the
battle killed — a participant missing from the state the battle folds to, the
rulebook's answer read rather than restated — plays its `fall` where it stands,
its ring and counter gone first, and blinks out, so `syncUnits` then removes
nothing anyone can see. ⚠️ **They fall while the batch goes on**: a charge that
breaks through is a `battleResolved` and then a `unitMoved` into the dead
unit's square, and the charger walks in as the defender goes down. A later
battle in the batch waits for them, and so does the batch's end.

## Victory

`shared/src/victory.ts`:

```ts
victor(before, after) → PlayerId | null  // who has won with this action
isOver(state)         → boolean          // whether the marker is set
```

Two ways to lose: **a player with no army** — no unit besides its general —
and **a player whose general fell**. On a board with no general the first is
plain elimination, since every unit counts. `victor` reads both states for the
second, because a board without a general says nothing on its own — the general
may have fallen, or the army never fielded one. A general that fell earlier
ended the match then, so only this action's can matter. `isGeneral`, beside
`generalOf` in `queries.ts`, is the one place the rules name the type, and the
simulator's bot asks `victor` whether a kill wins rather than knowing for
itself.

⚠️ **`victor` reads the roster; `isOver` reads the marker.** A board can
satisfy the condition before any resolution has recorded it, and that gap is
where `resolveAction` asks.

`victor` is the N-player predicate, not "the one who isn't the loser". An empty
board answers `null`. At most one player loses per resolution, because
`wouldCounter` is false at zero health, so a single battle kills exactly one
unit — an army's last soldier, or a general, never both.

⚠️ **`resolveAction` folds to ask.** Units leave the board in `applyEvents`, so
the question cannot be answered from `state`, which predates the death. It is
the only fold in resolution, and the turn's hand-over reads the same folded
board. `endTurn` does not ask, because ending a turn removes no unit and fells
no general — its heal only adds health.

⚠️ **`gameEnded` is emitted alone, never with `turnEnded`** — an early return
guarantees it, so the loser's `hasActed` flags are not refreshed for a turn that
never comes.

**A surrender is the one other ending**, and the one command `validateCommand`
lets past its turn check: either player may give up on anyone's turn, so it asks
only that the actor plays in this game, and the other player wins. ⚠️ **Two
players**, so *the other* is one player; a third would make it an elimination,
and `resolveSurrender` throws first. The store accepts a surrender past the cap
on commands, so a game that used every command can still be ended.

### What each surface does with it

⚠️ **One guard, in `submitCommand`, covering all three callers** — End Turn, an
attack and a move inherit the same answer to "may I still play", rather than
each relying on its own button being `disabled`.

⚠️ **`clickTile` keeps a guard of its own.** Selecting a unit, drawing a route
and walking a preview submit nothing, so `submitCommand` never sees them. It
reads the **live** state rather than the rendered copy.

Neither is the rule — `validateCommand` is what refuses. These stop the round
trip and the rejection banner.

⚠️ **Walking reads it too**: a unit walks on the spot while `canSelectUnit` says
it can act *and* the game is not over, since `gameEnded` leaves `currentTurn`
where it was and the winning side would otherwise walk on the final board.

⚠️ **The status bar asks `isOver`, not whether the winner resolved to a player.**
Asking `isOver` first also keeps `getCurrentPlayer` out of a terminal render,
which matters because it *throws* when `currentTurn` names nobody and runs every
frame. End Turn is disabled off the same answer, and off `holdsTheTurn` — the
other seat's turn, in a game shared with somebody. There the bar also names the
army this client commands, and its turn as *Your turn*; hot-seat holds every
seat, so it is always your turn and the bar names only the army to move.

⚠️ **In the lobby the winner *displaces* the turn rather than joining it.** A
finished row showing both would read *player-1 · player-2 won* — true, since
it is still whose turn it would have been, and useless. The board resolves the id
to a display name; the lobby shows the id, having no roster to resolve against.

## HTTP

Plain request/response over `Bun.serve`'s own `routes` table. No SSE, no
WebSockets, no server push. The client is always cross-origin to it — Vite's in
development, a portal's CDN in production — and calls the address compiled
into it as `__API_ORIGIN__`, from the one variable `API_ORIGIN`; unset, that is
the local server on `PORT`.

```
POST /api/auth/guest                  → { token }                201
GET  /api/health                      → 204                      (touches no database)
GET  /api/maps                        → MapSummary[]
GET  /api/maps/:id/preview            → MapPreview               (stores nothing)
GET  /api/me                          → { name }                 (writes nothing)
GET  /api/matches                     → MatchSummary[]           (the guest's own, newest 50)
POST /api/matches                     → MatchSummary             201
     { mapId?, mode?, seat?,          | { error }                400 unknown map, mode,
       name?, clock? }                |                              seat or clock
                                      | { error }                409 too many unfinished
                                      | { error }                429 · 503 limits
POST /api/matches/join                → MatchSummary             200
     { code, name? }                  | { error }                404 nothing waits under it
                                      | { error }                409 your own · beaten to it
                                      |                              · too many unfinished
                                      | { error }                429 limit
GET  /api/matches/:id/state           → { seq, state, you, code, clocks, endedBy,
                                          opponentHere }
GET  /api/matches/:id/events?since=N  → { seq, events, state?, code, clocks?,
                                          endedBy?, opponentHere }
POST /api/matches/:id/commands        → { ok: true, seq, events, state }   200
                                      | { error }                         409 the game moved on
                                      | { error }                         422
                                      | { error }                         429 limit
POST /api/matches/:id/cancel   {}     → 204
                                      | { error }                         409 already started
POST /api/matches/:id/archive  {}     → { error }                         403 to everyone
OPTIONS /api/*                        → 204 preflight
'/api/*'  → 404, including a method an endpoint does not serve
'/*'      → the client build
```

Every `/api/matches` route and `/api/me` needs a guest, and answers **401**
with `WWW-Authenticate: Bearer` without one.

**Creating takes every field as optional** — the default map, hot-seat, and
the guest's own name or a generated one — which is also exactly what a client
from before modes sends. A `remote` game seats its creator in `seat` and waits
under a `code` for somebody to join it; `you` on a state answer is the seats
the guest holds, and `code` is present while the game waits. ⚠️ **`code` is on
every poll, the caught-up ones too**: a join moves no `seq`, so that is how
the waiting player learns the game began. A join is read forgivingly — case,
spaces and dashes ignored — and spends from the same allowance a create does,
which is also what makes guessing codes slow. A sent `name` is trimmed and
bounded, and one with nothing in it is the same as none. `clock` is one of
`CLOCK_MINUTES`, each player's for the whole game; left out, there is none.
`clocks` and `endedBy` ride every answer that carries a state.

**Presence and the limits are transient state**: held in memory, each behind
a small interface, as the named exception to the server holding nothing
between requests — not game state, nothing lost in a restart that matters,
and a write per request if they were in the database. ⚠️ **Presence is a
heartbeat**: every state fetch and poll, the caught-up ones included, marks the
guest heard from in that match and answers `opponentHere` — whether anybody
else in it has asked within `AWAY_AFTER_MS`, which outlasts a hidden tab's
thirty-second poll so that away means gone. Keyed by guest, not seat, so
hot-seat, with nobody else, is never anybody's here. Shown, never acted on. ⚠️
**It holds because there is one machine**: a second would keep its own copies.

Status carries the outcome: a missing match is **404** — and so is one the guest
holds no seat in, or an archived one, from the same query, so an id says nothing
about whether it exists. A malformed body, a body that was never a
command, and a bad `since` query parameter are all **400**, a POST that is not JSON is **415**, a well-formed command the rules refused, or one past the match's cap, is
**422** with the reason in the body — as is any command to a game still
waiting — and creating or joining a match while holding `Limits.unfinishedMatches`
that are neither won nor archived is **409**. The limit is counted and then
created, so two creates in one round trip can both pass it. A command that lost
a race to another write is **409** too, *the game moved on*, having changed
nothing. ⚠️ **Archiving is 403 for everyone**: `archived_at` is match-wide, so
with two players either could erase the game from the other's list; the route
is kept for the admins who will be let through it. A limit on an
address is **429**, and the day's ceiling on new matches **503** — see *Limits*
below. ⚠️ **An unknown map id is a 404 at `preview` and a 400 at
create**, which is a distinction rather than a slip: asking to look at a board
that does not exist is a missing resource, asking to *build* on one is a bad
argument. `findMap` is `getMap` without the throw and serves both. Every non-2xx body this code writes is an `ErrorResponse`;
the one exception is bun's own 413 from `maxRequestBodySize`, which it answers
before a handler runs.

**Limits.** `Limits` is a `createServer` option, defaulted for production, so a
test loosens or tightens any of them: the cap on unfinished matches above, and
three allowances — new matches and commands from one address, and new matches
from everyone together, a circuit breaker far above any real day. Each is a
fixed window in `limiter.ts`, whose `take` spends one or answers the seconds
until it could; the server builds one in `createServer`. A route checks its own
allowance, first thing — a command's before its body is read — except the
ceiling, which a create checks last, so only a match about to be made spends
from it. A refusal answers `Retry-After` and puts the wait in its reason too:
the reason is what a client shows, and a cross-origin client cannot read a
header nobody exposed. Minting a guest is not limited — it writes nothing. ⚠️
**The address is `Fly-Client-IP` only when `trustFlyClientIp`**, which
defaults to production, where Fly's edge sets it; anywhere else a client could
write a fresh one per request, so the socket's address from Bun's server —
which every handler is handed — is the key.

`state` is present on an events response only when `seq` advanced past the
requested `since`. ⚠️ **A caught-up poll reads no board**: it asks for the
match's `seq` and the seats this guest holds, and answers `{ seq, events: [] }`
without the board or the log.

**Payload limits:** `maxRequestBodySize` is 64 KB; `MAX_PATH_STEPS` in
`parseCommand` is 256. `parseCommand` validates shape and field types at
runtime and rebuilds a fresh object, so extra properties are dropped.

**CORS, for a client served from anywhere.** `publicRoute` wraps every API
route: it puts `Access-Control-Allow-Origin: *` and the build header,
`X-Build` — exposed by name with `X-Guest-Token`, since a cross-origin response
hides any header CORS does not list — along with `Cache-Control: no-store` and `nosniff`, on
whatever the handler answers
— errors included, or a client would read a 422 as a network failure — and
turns a thrown error into a 500 that still carries it. ⚠️ **`*` rather than an
allowlist**: every itch game is served from one shared origin, so an allowlist
naming it would admit all of them, and with no cookies `*` lends nothing.
Preflights land in the `/api/*` catch-all, since no route serves `OPTIONS`, and
answer 204 allowing `GET`, `POST`, `Authorization` and `Content-Type`, cached
for two hours — Chrome's cap. ⚠️ **A POST must be JSON or it is a 415**: plain
text is a request any web page can send without a preflight, so requiring the
content type puts every write behind one; the client sends `{}` when it has
nothing to say. A browser caches a preflight per URL, so each poll that finds
new events, moving `since`, costs one more — a request that touches no database.

**Guests, and no cookie.** `POST /api/auth/guest` mints a token anyone may
have; every match route then needs one, sent as `Authorization: Bearer`. No
cookie survives a portal's iframe, so none is set anywhere. Every API route is
wrapped one way or the other — `publicRoute` for what anyone may ask,
`guestRoute` for what needs a guest — which is what makes the table
default-deny, and `http.test.ts` checks it from outside by asking every match
route without a token.

`guest.ts` signs a random id and an expiry, `GUEST_LIFETIME_MS` out, with the
server's key, so **minting writes nothing and checking reads nothing**: on a database
that bills every row, a row per guest and a read per request would both be
charged for. Revoking is rotating the key, which signs every guest out. ⚠️
**`GuestId` is a type of its own**, because `PlayerId` names a player in one
match and a guest holds seats — every seat, in hot-seat. Which player a request
acts as is the store's to decide; see *Data store*. ⚠️ **The key is fixed
outside production**, so a restart does not sign every development guest out.
⚠️ **A guest lasts while it plays**: once a token is `GUEST_RENEWAL_AGE_MS` old,
`guestRoute` answers it with `X-Guest-Token`, a token for the same guest with a
whole lifetime, so a guest ends only when nothing has used it for a lifetime;
the age is what keeps a polling client from being handed a new token on every
answer. The server's clock is an option, which expiry and renewal read, so a
test moves time.

**The page's CSP is in the build**, a meta tag Vite's `contentSecurityPolicy`
plugin writes first into `index.html`'s head, so the copy itch serves and the
copy this server serves carry one policy: everything from `'self'`, images also
from `data:` and `blob:` — a model's textures reach the GPU through one — and
`connect-src` adding `API_ORIGIN`. ⚠️ **Enforced, and only in a build**: a meta
tag cannot report only, and the dev server's hot reload needs inline script, so
a new kind of source works in development and is refused in a build until the
plugin lists it. `frame-ancestors` cannot be set by a meta tag, which is why
the server sends `X-Frame-Options`.

**Serving the client build:** `'/*'` serves `packages/client/dist`. ⚠️ **A path
that is no file redirects to `/`**, rather than getting the page: the client's
routes live in memory and its asset paths are relative, so there are no deep
links, and a page served from a deeper path would find none of its assets. `clientDist` is a
`createServer` option. Requests resolve against the dist directory and are
confirmed to stay inside it. When `Accept-Encoding` allows, the `.br` then `.gz`
sibling is served with `Content-Encoding` and the *original* file's
`Content-Type`. `Vary: Accept-Encoding` rides every response, compressed or
not. `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`;
everything else `no-cache`. Every client answer carries `PAGE` — `nosniff`, no
referrer, COOP `same-origin`, a permissions policy refusing devices the game
never uses, and ⚠️ **`X-Frame-Options: DENY`**: itch embeds its own copy of
the build, so a frame of this one is somebody else's page.

## Data store

SQLite via the libSQL client and Drizzle. `DATABASE_URL` and
`DATABASE_AUTH_TOKEN` are the only difference between a local file and hosted
Turso.

```sql
matches      (id, created_at, initial_state JSON, current_state JSON,
              current_seq, current_turn, map_id, winner, archived_at, code,
              deadline, ended_by,
              PRIMARY KEY (id))
              UNIQUE INDEX matches_code (code) WHERE code IS NOT NULL
seats        (match_id, number, occupant, color, clock_remaining_ms,
              PRIMARY KEY (match_id, number),
              FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE)
              INDEX seats_occupant (occupant)
users        (id, name, created_at, PRIMARY KEY (id))
resolutions  (match_id, seq, actor, action JSON, events JSON, rolls JSON, created_at,
              PRIMARY KEY (match_id, seq),
              FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE)
```

**A guest's matches are the seats it holds.** A match has a seat for each of
its players, numbered from 1, and seat *n* is `state.players[n - 1]` —
`playerInSeat` and `seatOf` in the rulebook. A seat's `color` is the colour its
player was built with; nothing else writes it yet. `create` makes hot-seat by
default: the creator occupies every seat. `createMatchStore` takes the guest
along with the database, so a store is one guest's matches: `list` and
`unfinished` ask for matches with a seat it occupies, which `seats_occupant`
serves, and a hot-seat match counts once. ⚠️ **Finding a match and checking it
is yours is one read**: `loadMatch`, and the lean read every poll makes before
it, ask for the seats this guest holds as a subquery on the match row, and no
seat is the same `null` as no match. Mode and status are never
stored; an occupant in every seat is hot-seat, a code is waiting, a winner is
finished. ⚠️ **Those subqueries are built with Drizzle, never written in
`sql`**: Drizzle strips the table from every column in a one-table select's
fields, so a hand-written `matches.id` reaches SQLite as a bare `id`, which
binds to the innermost table that has one.

**A remote game** seats its creator in the seat it chose and leaves the other
empty, with a `code` from `joinCode.ts` — unique among waiting games by a
partial index, and drawn again on the rare collision. `submit` refuses every
command while there is a code, a surrender included: the state is built at
creation, and without that the creator could play alone. ⚠️ **Joining is one
batch of conditional statements**: the empty seat is taken only while the code
is still there and the game not cancelled, and the code is dropped and the
joiner's name written only once the joiner holds the seat — so of two joins
racing, or a join and a cancel, the one that loses changes nothing.
Joining your own game is refused rather than made hot-seat. **Cancelling** is
archiving a game that still waits — `archived_at` set, the code dropped — and
only its creator holds a seat in one.

⚠️ **Who a request acts as is one rule, `actorFor`**: the player whose turn it
is, if the guest holds that seat — `holdsTheTurn` — and otherwise its first seat — where the
rulebook refuses anything but a surrender as *not your turn*. Hot-seat holds
every seat, so there it is always the player whose turn it is.

**`users` holds a guest once it holds a seat**, written in the batch that
seats it — creating or joining — and conditional on the seat, so a lost join
writes no row. A name sent replaces the one kept; with none sent, a guest's row
keeps its name, and a new one gets a generated name from `names.ts`. `name()`
answers the menus' prefill: the kept name, or a fresh suggestion for a guest
with no row, writing nothing. ⚠️ **Never at minting**: minting is unlimited
and writes nothing, and creating and joining are what the limits guard.

**Archiving is a soft delete.** `archive` stamps `archived_at`, and every lookup
skips a stamped row, so to its players too an archived match is missing — there
is no unarchive — while the row and its log stay. `unfinished` counts the
guest's matches with neither a winner nor a stamp, for the cap at create.

`initial_state` is written and never read. `current_state` is a checkpoint;
events are authoritative. `current_turn` is denormalised so listing matches
parses no boards. `map_id` is read only to label a match in the list — replay
never needs it, because `initial_state` already holds the instantiated board.
`action` and `rolls` are written and never read; `rolls` is nullable, so rows from
before it existed stay valid.

`winner` is denormalised for the same reason as `current_turn`, and is
**nullable** where `map_id` took a default: null means *still being played*. It
is written on **every** submit rather than only when it changes.

**Paths:** a relative `file:` URL in `DATABASE_URL` resolves against the repo
root, not the cwd. `DEFAULT_DB_URL` lives in `src/const.ts`.

**Migrations** are generated by `db:generate` from `schema.ts`, committed, and
applied by `migrate.ts` — `bun run db:migrate`, which `bun run dev` runs before
starting. `schema.sql` is refreshed by `db:generate` too. ⚠️ **The server never
migrates**: `createServer` takes a database or opens one, and a server started
on an unmigrated database fails on its first query rather than quietly fixing
it. `migrate.ts` makes the production configuration check before touching a
database, the same one the server makes at start. ⚠️ **Drizzle applies a
migration only if its journal timestamp is later than the last one applied**,
so one generated on another branch and merged after a newer one would be
skipped without an error — migrations are generated on `main`.

**Pragmas:** `journal_mode = WAL` is set in `migrate()` (a property of the
file); `busy_timeout` is set in `createDb` (per connection). Both are skipped for a
non-`file:` URL.

**The clock is chess style**, kept in two places: the match's `deadline`, when
the mover's time runs out, and each seat's `clock_remaining_ms`, its time left
as of the end of its last turn — null throughout for a game with none.
⚠️ **Only a turn's end moves it** — `clockAfter`: the mover keeps the deadline
less now, and the next deadline is now plus the next mover's time, or none once
the game is over; a move within a turn writes no clock. Elapsed time is never
stored, since the deadline implies it. It starts when the game does: at
creation for hot-seat, and in the join's batch for a remote game. `clocksAt`
answers each seat's time as of the answer — the mover's from the deadline —
and the client counts that down; its count decides nothing.

⚠️ **A clock that runs out is settled lazily**, since nothing runs between
requests: `current`, which every lookup but the caught-up poll goes through,
issues the mover's surrender — through `validateCommand`, as anyone's — before
whatever the request came for. So the first request to look after the deadline
ends the game: in practice the other player's next poll, and a command arriving
late finds the game already lost. The caught-up poll reads the deadline beside
`seq`, and takes the long way only when it has passed. The list shows a run-out
clock as nobody's turn, and writes nothing to settle it. `ended_by` records how
a game ended — on the board, by a surrender, or on the clock — once there is a
winner.

**Writes:** `submit` reads state and seq through `current`, refuses once `seq` has reached
`COMMANDS_PER_MATCH` — an `ok: false` like a rule's refusal, so a 422 — and
validates; `commit`, which a timeout goes through too, resolves and folds — all
pure — then runs one `batch` in `'write'` mode containing the log insert, the
match update, and the mover's seat when the turn changed. The update carries `AND current_seq = ?` and throws if it matched
nothing. ⚠️ **Two writers claiming the same seq violate `PRIMARY KEY (match_id,
seq)`**, and the loser's batch rolls back whole, so `commit` answers `MOVED`
rather than failing — a surrender beside the mover's command, two players at
once, or two polls settling the same timeout, where the loser reads what the
winner wrote.
Statements are built by Drizzle and executed by the raw driver, because Drizzle's
own `batch()` cannot pass a transaction mode.

## Client

**`net/api.ts`** — the server's address, JSON, and the one place a response
becomes `notFound`, `unreachable`, or a rejection. `HttpError` carries a
`FailureKind`; `RejectedError` is a separate type for the answers that are
refusals rather than failures — `REFUSALS`: a cap, the rules, or a limit. Also holds `api`,
the endpoints that are **not** scoped to a single match, which is why they are
not on `GameServer`.

**`net/guest.ts`** — the browser's guest token, in `localStorage`, so a closed
tab comes back to its matches. ⚠️ **Readable by every itch game**, which itch
serves from one shared origin — accepted, since a token buys only that guest's
games and its name. Every call carries the token, minting one first if there is
none, and calls made together share one mint. A renewal an answer carries
replaces the token it renewed, and only that one, so two renewals arriving
together do not trade places. ⚠️ **A 401 is recovered from once** — the
token was expired or the key rotated — by forgetting that token, minting, and
asking again; only the refused token is forgotten, so two calls refused
together do not mint twice. ⚠️ **Storage that throws is caught**: Chrome
refuses storage to a cross-site iframe when third-party cookies are blocked,
Incognito's default, so the token is held in memory and the game still starts.
A refresh there starts a new guest, an accepted edge case. The client's test
setup seeds a token, so only the suite about identity scripts a mint.

**Knowing it is out of date.** Every answer — a refusal included — carries the
server's build in `X-Build`, and `outOfDateStore` turns one newer than the
client's own `__BUILD__` into a banner: "A new version of the game is
available", with Reload. ⚠️ **In a frame it asks for the page to be reloaded
instead**: itch gives each upload an address of its own, so a frame reloading
itself asks the old build's address again and gets the old build, banner and
all, and a cross-origin frame cannot reload the page around it. One-way: a
client goes out of date and stays so until reloaded. A banner, not a block — the server stays compatible with the client
it replaced, and a move the old rules would allow is still refused with a
reason. ⚠️ **It promises no timing**, because on a portal a reload brings the
new client only once the portal has finished processing its build. ⚠️ **No
minimum client build**: a breaking change that needs one can treat a client
sending no build at all as older than any that does, so nothing is wired in
ahead of it.

**`net/gameServer.ts`** — `connectGameServer(matchId, { onConnectionChange?, onStart?, onPresenceChange? })`
returns `{ ok: true, server, code, opponentHere } | { ok: false, kind, reason }`. `server.you`
is the seats this client holds, fixed for the connection. `code` is the one a
waiting game is joined by, and `onStart` fires on the first poll that comes
back without it — read off every poll, since a join moves no `seq`. ⚠️ **The
match is fetched once more then**, because its clock started with it, and a
reading from before would count the wait against the mover. `getClocks()` is
the last `Clocks` an answer carried, with when it arrived, and `getEndedBy()`
how the game ended. `onPresenceChange` fires when a poll's `opponentHere`
differs from the last.
`onConnectionChange` reports a `ConnectionStatus` of `'connected' | 'retrying'`,
which surfaces as a reconnecting banner. It fetches initial state
before returning, so `getState()` is synchronous. Polling every 2s, doubling to
30s on failure and resetting on success; a hidden tab polls at the slowest
interval and a `visibilitychange` listener resets and polls immediately on
return. No poll is scheduled once the match is over, since a finished match
never changes. Updates are deduplicated by `seq` before reaching any listener.
`dispose()` stops the loop, clears listeners, and removes the listener.

**`routes/`** — held in a `MemoryRouter`, and nothing ever writes to the URL: a
portal serves the build at a deep path it controls, where no path route would
match, and inside its iframe a URL cannot be seen or shared — a change would
only add Back-button entries to the portal's page. A match is resumed from the
list, and links back to it — the only way back, since the browser's Back button
never leaves the page. `/` is `StartScreen`: the list, a **New Game** menu and
a **Join Game** menu, one open at a time. New Game picks the mode — two players
on one device, or multiplayer by code, with the computer shown and disabled —
the map and the clock, and for multiplayer the seat and a name; its map picker does not
appear if `GET /api/maps` fails, and creating then takes the server's default.
Join Game takes a code and a name. ⚠️ **The name is asked for once**, from
`GET /api/me`, when the first menu opens, and both menus share it; a name typed
before it lands is kept, and an empty one is sent as none, for the server to
keep or make up. A row says where its match stands: who won, waiting with its
code, against whom and whose turn, or — in hot-seat — who is to move. `/maps` is `MapViewer`. Both pickers name a map by
`mapLabel` — its name, then its size, width first. `/:matchId` is
`MatchRoute`, which is keyed on the id so a param change remounts the
connection. It owns the async connect, renders `GameCanvas` only once a server
is ready, and disposes on unmount including a connection that resolves after
teardown. It holds the opponent's presence as it holds the connection status,
and hands both to `GameCanvas`. ⚠️ **A waiting game renders its waiting room instead** — the code to
send, and a Cancel button — while the connection polls behind it, and becomes
the game on `onStart`. A code rather than a link, because the client keeps its
routes in memory and itch's page is not known to hand its address to the
game's iframe; a code works on every copy. A failure renders one of two things, which is what `FailureKind` is
for: `notFound` offers a link back and no retry, `unreachable` offers a working
Retry that re-runs the connect.

⚠️ **`/maps` ranks above `/:matchId` whatever the order they are written in** —
react-router scores a static segment above a dynamic one — so a match whose id
were literally `maps` would be unreachable. Ids are uuids, so that is a
curiosity rather than a bug.

### The map viewer

`MapViewer` is a picker over `GET /api/maps` and **the game's own renderer**
built on `GET /api/maps/:id/preview`. ⚠️ **It draws a whole `GameState`, not a
terrain grid**, which is why the endpoint returns one: a second way to draw a
board would be a second thing to keep in step with `composeTerrain`, and it
would be the copy nobody notices has gone stale. **It shows the map alone**: the
viewer hands the renderer the preview with its units emptied. The endpoint still
sends the deployment, and `maps.test.ts` still asserts against
`createMatchState`, since a deployment square drawn onto a river is a property
of the *pair*.

**Nothing is wired for input**: `onTileClick` is never registered, so the canvas
orbits and zooms and answers nothing else. That is the whole difference from
`GameCanvas`.

⚠️ **One effect does the fetch *and* the build**, so a single `disposed` flag
covers both halves of one attempt. Split in two — state into `useState`, a
second effect watching it — a map switched twice in flight can resolve out of
order and leave the scene showing the first answer.

⚠️ **The canvas is keyed on the map id**, so each scene gets a fresh element.
Babylon takes the canvas's WebGL context at construction and gives it back on
`dispose`; building a second engine on the same element asks for a context that
has just been handed back, which is a black canvas on some drivers and fine on
others.

**The viewport is roughly square.** `holdTheBoard` sizes the frustum from the
board's ground-plane *half-diagonal* — the worst case over every camera angle —
so a wide box spends the surplus on background, and boards are square.

**`game/useGameSession.ts`** — the session: render replica, rejection state,
in-flight guard, selection, and submits. Takes `onEvents` and `onSnap` callbacks
held in a latest-ref, so the subscription depends on `server` alone.

Selection is React state and is **returned** rather than pushed through a
callback, so it has one copy: whoever renders it and whoever reads it to compute
the next click see the same value. `pendingRef` stays a ref — it is a mutex
against a second submit landing before the first resolves, and has to be
synchronously current rather than rendered.

`clickTile`, `chooseAction`, `chooseMove` and `endTurn` are the verbs. The
panel's buttons are the only thing in the game that is not a tile.

Otherwise a plan is pinned, confirmed *and* abandoned by a click on the board —
whatever is lit does something and everything else is the way out. A refused
submit rolls back to the unit **selected**, not to the destination the server
just refused.

⚠️ **Confirming a pinned route** — a second click on the tile it already ends at
— starts a **preview walk**: the unit moves on screen while nothing has been
sent. `onPreview(next | null)` drives it. There is no commit verb: a confirm and
an incoming update both end with `onSnap` writing an authoritative position over
the mesh. It *is* called on a rejection, the one ending that produces no update.

⚠️ `walking` is true until the preview settles, and **nothing is answerable
during it** — `playEvents` skips a move only once its mesh stands at the
destination, so committing early would replay the committed move from halfway
along the path. `clickTile` closes over `walking` rather than reading it from a
render that may predate the walk, and the guard sits at the top rather than
inside a phase, because a poll can unpin a plan mid-walk.

Every update runs through a serial promise queue:

```
on update (events, state):
  clear the rejection                       -- immediately, on arrival
  enqueue:
    if worthAnimating(events): await onEvents(events)
    onSnap(state)
    commit state
```

⚠️ **An uncommitted plan does not survive that commit** — either kind, pinned or
arrived, is dropped back to the unit selected, because the board it was drawn
against has moved. This is the first thing to suspect when a pin seems to vanish
on its own. An inspection goes altogether, having no selection to fall back to.

`worthAnimating` is false for an empty batch, while the tab is hidden, and for
a batch of more than **five events**.

⚠️ **A backlog gate, not a duration one**, which is why a plain count suffices.
One action produces at most five events — approach, battle, displacement,
turn-end, heal — so a turn always animates. It fires only when several resolutions
arrive together, which means the client was away.

A new event type needs no entry anywhere unless it raises that most. Long and
short moves are alike.

A failing animation or snap is caught and logged; the commit always happens.

**`game/interaction/selection.ts`** — pure: no React, no server.

```ts
handleTileClick(state, selection, coordinate) → SelectionState
destinationOf(pinned)                         → Coordinate
confirmRoute(routePinned)                     → DestinationChosen
openInPlace(state, selection)                 → SelectionState      // the panel at selection
enterMode(state, arrived, kind)               → DestinationChosen   // a mode's tiles
readAimClick(state, attacking, coordinate)    → Unit | null        // attack or charge
readHoldClick(state, arrived, coordinate)     → Facing | null
chooseTarget(attacking, target)               → TargetPinned
clearStep(arrived)                            → DestinationChosen   // back to the panel
unpinDestination(pinned)                      → SelectionState      // back to the board
moveCommandFor(arrived, facing)               → Command
```

⚠️ A button reaches `enterMode` (through the hook's `chooseAction`) or
`unpinDestination` (through `chooseMove`); everything else a player does is a
tile click. `clearStep` and `unpinDestination` are the two back-out rules, one
per level.

⚠️ **`canAttack` decides whether the panel offers Attack at all, and it asks
`refuseAttack`** — the server's own rule — rather than counting what stands in
`tilesInRange`. The band is *reach*: it knows nothing about ownership, a minimum
range, or a unit targeting itself, so a panel built on it would offer Attack for a
friend two tiles off and the click would then be refused. One rule asked twice
cannot disagree with itself — and it is what makes `slow` and contact free on
the client: Attack and Charge simply stop being offered to a gun that has moved, or
to any unit that started in contact and moved, because the refusal they ask reads the
path. It walks every unit rather than the band, which is
sixteen against up to sixty and needs no grid bounds. ⚠️ **Unavailable actions
are omitted, not greyed**, following AW — the cost is that *nothing in range* and
*I misread the menu* look alike, and the menu changes height between units.

`destinationOf` answers *where the unit is standing* — which is also the tile a
second click must land on to commit, and the tile the facing choices are drawn
around.

⚠️ `pinned` above is **any** phase carrying a path; `arrived` is only those that
have walked. `unpinDestination` is the sole helper serving both, because
backing out means the same thing in both modes and nothing else does.

`handleTileClick` **never produces a command** — it picks a destination and
nothing more. The phase dispatch that decides whether a click commits lives in
`clickTile` above it.

```ts
| { phase: 'idle' }
| { phase: 'unitSelected'; unitId; position; movement }
| { phase: 'routePinned'; unitId; path; movement }
| { phase: 'destinationChosen'; unitId; path; movement; step }
| { phase: 'inspecting'; unitId; position; view; tiles }   // 'attack' | 'movement'

MenuStep
  | { kind: 'choosing' }                     // panel up, nothing lit
  | { kind: 'attacking'; tiles; target | null }   // the band; null until one is pinned
  | { kind: 'charging'; tiles; target | null } // the neighbours it may charge
  | { kind: 'holding'; tiles }                 // the four beside it
```

`movement` is the whole `exploreMovement` result, snapshotted at selection time.
`reachable` decides whether a click pins; `pathTo` builds the path.

⚠️ **Each mode carries the tiles it lights**, built when the mode is entered.
`showSelection` is therefore a *pure projection of the selection* and needs no
game state to know what to paint. The tiles cannot go stale, because any board
change discards the plan. Which tiles those are is decided in `selection.ts`,
including the board-edge clipping; the renderer colours lists.

⚠️ **`Pinned` is `Extract`ed on carrying a path**, not hand-written as a union
of phase names, so a phase with a path joins it by existing.

⚠️ **`isPlan`'s runtime list is pinned to the type from both directions.**
`satisfies readonly Pinned['phase'][]` rejects a name that is not a phase; a
`never` assertion beside it rejects a phase left *out*, which `satisfies` cannot
see. Same trick `applyEvents` uses on its event union.

**Five phases, and the menu's steps are a field rather than more of them.**
`unitSelected` and `routePinned` both light the range and answer clicks
identically, which is why pinning and re-pinning are one code path.
`destinationChosen` is everything after the walk, with `step` saying which
question is being asked.

**`inspecting` is a unit that cannot act, looked at** — the enemy's, or the
player's own that have acted: whatever `canSelectUnit` refuses, `trySelect`
inspects rather than dropping. ⚠️ **Off this client's turn every unit is**,
its own included: `handleTileClick` takes whether it holds the turn, because
`canSelectUnit` means *belongs to the player to move*, who is then the
opponent — and a selection left from the turn before is let go. Its first view lights the band it could fire
into **from where it stands** — `attackTilesFor` at its position, not Advance
Wars' threat range, so what a move adds is the player's to work out. A second
click on it lights its reach, from the same search a selection snapshots; a
third clears, as does a click elsewhere, and a click on another unit selects or
inspects that one. Clicks the panel and its modes answer first keep their
meanings. ⚠️ **It stores the tiles, not the search**: a member carrying
`movement` would compile through `handleTileClick`'s pinning path, and a second
click on an enemy would pin a route *for the enemy*. No path, so never a plan —
End Turn stays enabled — and a board update clears it to idle, since its
snapshot has nothing to fall back to.

#### The panel picks the intent

**There is no single click reader.** `readAimClick` answers *is this an enemy I
may attack, by the rule of the mode I am in*; `readHoldClick` answers *which way
is this*; neither can be asked in the other's mode, so the collision is
unrepresentable. The two attack modes share one reader, differing only in which
refusal they ask — `refuseAttack` or `refuseCharge`.

**Buttons pick intent; tiles pick targets.** A target pins and confirms exactly
like a route: first click pins it and opens its pane, second commits, a click on
a different lit enemy re-pins. The pane is *informational* and carries no
button: a pinned attack shows its damage, and a pinned charge its odds.

⚠️ **Two rules for backing out, not a chain.** A dark click inside a mode returns
to the panel; a dark click at the panel un-walks the ghost and returns to movement
selection. "Lit does something, dark backs out" reads because at most one set is
ever lit.

⚠️ **Exactly one overlay is lit, and `setStepTiles` is what guarantees it** —
one call taking the lit overlay, so the invariant is in the signature. It is
named for what it paints — `attack`, `charge`, `facing` — rather than for what
the player is doing, which keeps `render/` from importing the interaction layer
to name a colour. `STEP_UI` in `GameCanvas` maps between the two vocabularies
and carries the hint line with it.

The attack band is unfiltered: facing is its own mode, so reach is simply
reach.

**The forecast reads through the step.** `attackForecast` and `facingForTarget`
take a `TargetPinned` — an attack mode with a target pinned — which
`isAttacking` and `isTargetPinned` narrow to. ⚠️ These were `Aim` and `Aiming`,
which read the wrong way round: the gerund sounds like the earlier state and was
the later one, across four symbols separated by three letters. ⚠️ Two predicates, so no caller spells the two-level check
by hand; that is what absorbing `targetChosen` costs, paid once.

⚠️ **`Attacking` covers attacking and charging together** — a charge is a special attack —, because everything between
picking a mode and committing is identical: the same pin-then-confirm gesture,
the same re-pin, the same second click. The kind is read off `step.kind` at the
single place that builds the command, rather than branched on through the
dispatch.

⚠️ **`Forecast` is a union, because the two attacks are knowable to different
degrees.** An attack's damage is a *range* — the roll is unknown. A charge shows
its odds alone, which are **exact**: `chargeChance` is a pure function of state
with no roll in it. What a failed charge would cost is not previewed.

**The charge overlay lights targets, not reach** — the opposite of the attack
band, because a charge is contact-only and has no reach to show. It lights what
`refuseCharge` accepts, so nothing is lit until the meter is full, and then
every enemy in contact, however strong.

`canCharge` is `canAttack`'s twin and asks `refuseCharge`, the rule the click will
ask, so the menu row and the board cannot disagree. Artillery does not charge,
so the rule refuses every target and the row never appears; nor does it until
the meter is full.

**`availableActions` is the one list both the panel and the skip read.** Holding
is always last and always present, so the list is never empty — which makes *one
action* mean **nothing to attack** rather than nothing at all.

⚠️ **It reads a table pinned to `ActionKind` from both directions.**
`PANEL_ACTIONS` pairs each kind with the predicate that offers it; `satisfies`
checks every entry names a real kind, and a `never`-assertion fails the build
when a kind has no entry — the same guard `PINNED_PHASES` carries. Holding's
predicate is a constant `true`, so *always available* is a fact in the table.

**A one-row panel is skipped, in both directions** — on the way in, and on the
way out, since its single row is the mode just left.

**A unit with something to fight opens the panel where it stands.** The session
passes every tile click's result through `openInPlace`, which acts only on a
unit just selected: it pins the unit's own tile and confirms it — the
walk-to-its-own-tile gesture, made for the player — and keeps the panel when
`availableActions` offers more than Hold, the skip's own test. Otherwise the
movement selection stands. Nothing walks, so no preview is started.

**A Move row heads the panel while the unit has not walked** — a one-tile path,
so the panel opened in place or the unit's own tile confirmed. After a walk the
move is made, and a dark click un-walks it. ⚠️ **Move is not an `ActionKind`**:
a mode is something the panel enters and Move leaves it, so the panel renders
the row beside `availableActions` rather than from it, and *one action* still
means *nothing to attack* to the skip and to `openInPlace`. The hook's
`chooseMove` is the row, and the dark click at the panel calls it too.

Either pinned phase is a **plan, not a submission** — nothing has been sent, and
a click that means nothing else discards it without the server hearing. `path[0]`
is where the unit still stands, so unpinning needs no extra field, and the
selected unit's own tile is a destination like any other: acting without moving
needs no gesture of its own. ⚠️ Which means clicking the unit **pins standing
still** rather than deselecting.

⚠️ In `destinationChosen` — and only there — `handleTileClick` returns the
**same object** it was given, so a click already read as a direction causes no
re-render. `routePinned` is excluded, because its clicks are tile clicks.

**In the holding step the tiles around the unit are the menu**: a click on the
destination keeps the direction travelled (`holdFacing`), a click on one of the
four beside it overrides that (`facingChoiceAt`), and **either commits**.
Anything further away is ignored.

⚠️ The two answers cannot collide: `facingChoiceAt` returns `null` for the
destination itself, because `directionBetween` wants a step of exactly one tile.
`holdFacing` is the only one that needs `GameState`, for the case with no last
step to read. The renderer clips the four to the board.

**`game/GameCanvas.tsx`** — the canvas ref, the renderer lifecycle, and the
chrome around it: the clocks, the army this client commands and whether its
opponent is here — in a game shared with somebody — the turn label, End Turn,
Surrender, the rejection reason, the reconnecting banner, and a Toggle
Inspector button under an
`import.meta.env.DEV` guard, plus a hint line during action selection and while
a unit is inspected — `INSPECT_UI` gives each view its overlay and hint, as
`STEP_UI` does for the panel's steps, and both hints say a click clears. Under the
same guard it installs `window.__board`, whose `tileToScreen` passes through to
the renderer, once the renderer is ready, and removes it on unmount — there
rather than in the renderer, since StrictMode builds two in dev and the stale
one could overwrite or delete it. End
Turn is disabled while *either* kind of plan is open, since ending the turn
there would submit around one the player has not answered for. `ChessClocks`
draws each side's time from `getClocks()`, redrawing the mover's four times a
second as it counts down; it reads who is moving from the authoritative state,
taken at the same moment as the reading, rather than the replica, which lags
while a batch animates. **Surrender** asks again on the page, since a portal's
sandboxed iframe can refuse `window.confirm`, and is offered to either side at
any time; in hot-seat the question names the side to move, which is the one
giving up. Once the game is over, `endLine` says who won and how: *You won* or
*You lost* to a player of a shared game, the winning side's name in hot-seat,
and — for a surrender or a clock — who gave up or ran out.

The tile menu lights **on arrival** rather than on confirm, so `showSelection`
is a projection of the selection *and* `walking`: the range stays lit while the
unit walks and comes down as the menu lights.

⚠️ **The route and the confirm pane are one affordance**, drawn on
`routePinned && !walking` and gone the instant a route is confirmed. That
predicate is why `walking` is a display input and not just a guard.

**The confirm pane is DOM over canvas** — a small box anchored above the pinned
tile, mounted only while it applies. ⚠️ React populates refs during the commit,
*before* effects run, so the anchor effect finds the element on the render that
introduces it and `null` on the one that removes it, which is exactly the clear.
`pointerEvents: none`, because the tile underneath **is** the button and a pane
that swallowed the click would block its own confirmation. Its container clips,
since `Vector3.Project` does not: a tile zoom has pushed off screen would
otherwise position an absolute child outside the viewport and add scrollbars.

The hint line and the pane **hand over rather than overlap**: the pane belongs
to movement selection, the hint to action selection and to inspecting.

Its two callbacks read the renderer ref at call time, so a queue task resolving
after unmount finds `null` rather than a disposed renderer.

Selection reaches the renderer as a projection: an effect keyed on it calls
`showSelection`. The tile-click handler, by contrast, is registered **once**, as
a stable wrapper over a latest-ref — `clickTile` changes identity with every
selection, and re-registering it would mean putting it in the construction
effect's dependencies and rebuilding the scene on every click. Registration
cannot be its own effect either: construction is async, so such an effect would
run while the renderer ref is still `null` and nothing would re-run it.

## Rendering

`createGameRenderer(canvas, initialState)` is **async** — it loads the unit
models before any unit exists, so that no window opens in which a unit has state
but no mesh. `GameCanvas` disposes a renderer that finishes building after
unmount.

⚠️ **One engine per canvas at a time**: a build waits until the last renderer
on its canvas has been disposed. A canvas has one WebGL context, and two engines
on it share the GL state while each keeps its own record of what is bound —
disposing one unbinds every texture slot, and the other never binds its
textures again because it believes they still are. The route arrow then sampled
an empty slot and drew as solid tiles.
StrictMode builds twice in dev, which is how two met.

It resolves to:

```ts
onTileClick(handler)      setSelectedTile(coordinate | null)
setRange(tiles)           setRoute(path)
setStepTiles(overlay | null, tiles)   // 'attack' | 'charge' | 'facing'
anchorTo(element | null, coordinate | null)
playEvents(events): Promise<void>
syncUnits(state)          previewMove(unitId, path): Promise<void>
onCutaway(handler)        cancelPreview()
tileToScreen(coordinate) → { x, y } | null
toggleInspector()         dispose()
```

`tileToScreen` is where a tile's surface lands in the viewport — the canvas's
rectangle added — for a browser check to click. ⚠️ It projects through the
board camera's own view and projection, as `placeAnchor` does, never the
scene's current matrix: that is set only while a frame renders, so it is empty
before the first, and during a battle it holds the close-up's camera.

⚠️ **`onCutaway` is the staged battle's half of the seam** — the renderer
stages it and hands the caller what it would otherwise re-derive, because the
readout is text and layout and belongs in the DOM. See *The combat cutaway*.
⚠️ **A battle is staged against the state just before it.** `playEvents` folds
the batch's events onto the last-drawn state as it plays them, with the shared
`applyEvents`, so a move-then-attack stages the attacker where it attacked from
and a second battle in the batch sees the first one's damage. That copy is
display only: `syncUnits` still sets what was drawn, and authority is read from
`server.getState()`.

⚠️ **Coordinates, never a `Movement`.** The renderer is told what to light, not
handed a search to query — presentation gets facts, the rulebook stays upstream.
`setRoute` takes the path *in order*, which a tint does not need but an arrow
would, so that interface survives the rendering changing under it.

`anchorTo` keeps a DOM element sitting over a tile: **the renderer writes its
`transform`** from the render loop while React owns only the content, because an
overlay tracking the board is otherwise a React commit every frame the camera
turns. ⚠️ Projection lands in render-buffer pixels and is scaled to CSS pixels
by the hardware scaling level — equal today only because `adaptToDeviceRatio`
is off.

⚠️ **The element is lifted a tile above the surface, in *world* space**, so the
pane clears the thing it is describing. A pixel margin would drift with zoom; a
world offset is projected like everything else.

**The pane stays on the board.** Each frame the renderer measures the pane and
the canvas and asks `fitPane` (`render/fitPane.ts`, pure and tested) where its
top-left corner goes: centred over the lifted point, shifted in from the left
and right edges, and **flipped below the tile** when there is no room above,
hanging from the lowest of the tile's four projected corners. The last few
pixels of clearance, `PANE_CLEARANCE`, live there rather than in CSS, since a
flipped pane takes them on the other side.

⚠️ **Because the renderer writes only `transform`, everything else about a pane
is CSS** — apart from that clearance. The three anchored panes — menu, forecast, confirm — are
`.board-pane` in `index.css` plus one modifier each, and they read a `--board-*`
token set defined there: surface, edge, lift, ink, hover, damage, track,
radius.

⚠️ **The board's tokens are separate from the page's, and that is the point.**
These sit on a lit 3D scene rather than on the page, so their contrast is
against grass and stone; wiring them to `--bg` would produce a light-mode panel
that is unreadable over the board. `--danger` and `--warn` *are* page chrome and
live with the page tokens.

**One surface token for all three panes**, and one `--danger` for the error red
across both routes and the canvas.

**Row hover is `:hover`, not React state.** There is no disabled row — an
unavailable action is omitted — so hover is the only state a row has.

- **Camera:** `ArcRotateCamera` in `ORTHOGRAPHIC_CAMERA` mode, starting at a
  fixed isometric angle from behind the board's near edge — or, by `ViewFrom`,
  the far one, half a turn round, which `GameCanvas` asks for when this client
  holds only the second seat of a shared game, so each player starts behind
  their own army. Hot-seat and the map viewer look from the near edge. Orbit stays on the default input; **wheel zoom does
  not**. An orthographic camera's apparent size comes entirely from its ortho
  bounds, so moving along `radius` changes nothing visible and only walks the
  camera toward the board until the near plane clips it. The wheel input is
  removed, `radius` is pinned by matching limits — far enough out that orbiting
  never brings a corner of the frame through the near plane — and a listener on
  the canvas scales a zoom factor that the ortho bounds divide by — clamped, and
  removed in `dispose()` alongside the `resize` listener.

  ⚠️ **How much room the board needs is settled once, at build, and nothing
  here ever reads the camera.** `boardRadius` is the ground-plane half-diagonal
  and `boardRise` the height either side of the target, both measured off the
  **board's rectangle** down to the slab's underside — not the slab's own
  bounds, which reach under the frame. The camera fits and pans on what can be
  played. From those: `reachX` is the
  radius, which no `alpha` exceeds, and `reachY` is taken at
  `CAMERA_BETA_TOPDOWN` — the most overhead tilt allowed, and so the one
  needing the most vertical room. Only the **window** and the **wheel** move the
  extent after that.

  ⚠️ **Nothing in the fit may read the camera**, or the board rescales as it is
  turned: a square board is half-width across down an axis and half-diagonal
  across at 45°, and its depth projects by `cos β`. The price is dead space at
  every angle but the worst one — on a 12×12 the board sits in roughly three
  quarters of the height it could fill looking down an axis.

  Each frame the frustum is sized so `zoom = 1` is *the whole board just fits*
  at the worst angle, the **floor** the wheel cannot go below. ⚠️ **The camera
  starts closer than that**: `startZoom` fits the board's own rectangle to the
  window from the starting pose, worked out once, so the frame shows only past
  the board's edges. The target is then clamped per axis to whatever board the
  viewport does not already cover. **Centring is not a rule of its own**: at full zoom-out
  the slack goes to zero and the clamp centres the board.

  Run every frame rather than on a change, since orbit, tilt, zoom and window
  all move independently.

  ⚠️ **Rotation is free; tilt is not.** `alpha` spins without limit, since a
  unit's rear has to be somewhere the player can go and look at. `beta` is
  clamped to **30° to 60° above the horizon, starting at 38.6°**. The shallow end
  is a *legibility* bound rather than a picking one: `screenToTile` searches
  every surface height, so a click stays right however low the camera gets.
- **Tile lookup is math, not mesh-picking**, and the pointer event has to agree
  with that. ⚠️ **The handler listens for `POINTERTAP`, never `POINTERPICK`.**
  Babylon emits `POINTERPICK` only when its ray hits a **pickable mesh**, and the
  terrain sets `isPickable = false` — so `POINTERPICK` delivers a click only
  where some *other* pickable mesh happens to be, with bare ground swallowing the
  rest. `POINTERTAP` fires for any tap that is not a drag.
- Heights: tile lookup is no longer against *one* plane.
  `screenToTile` tries each distinct surface height the board has, **tallest
  first**, and takes the first answer that agrees with itself: the tile found at
  height `h` must be a tile whose surface is at `h`. Tallest first is what lets
  a peak win over the plains it occludes. Cheap, because a board has two or
  three distinct heights. Terrain meshes stay `isPickable = false` and Babylon's
  mesh picking stays out of it. ⚠️ Clicking the *side* of a raised tile agrees
  with nothing, so the flat reading is kept as a fallback.
- **Elevation is visual only; the map data has no height.** A tile's walkable
  surface is `surfaceAt(coordinate)` in `renderer.ts`, the one place any `y` on
  the board is decided — terrain props, units, the walk tween, `syncUnits`,
  `cancelPreview`, every overlay and picking read it, so a raised tile cannot be
  raised for some of them and not others. It is `standHeight` in
  `composeTerrain.ts` applied to the board's cell, the formula the battle
  close-up uses too. Three ways a cell can say how high it is, in order of
  preference:
  - Nothing at all, and `terrainModels.topOf` **measures** the ground model's
    bounding box at load. Derived from the art, so swapping a model moves the
    surface with it. ⚠️ `bottomOf` is its counterpart and answers a genuinely
    different question — how far a tile reaches *down* — which only anything
    positioning itself under the board has any use for.
  - `TerrainCell.standOnProp` — the index of a prop a unit stands **on top of**,
    whose height is likewise measured. Hills are this: an ordinary grass
    tile with a mesa standing on it.
  - `TerrainCell.standOn` — a *declared* offset, for the one case measurement
    gets wrong: standing **partway up** a prop. A bridge deck is 0.15 on a model
    that reaches 0.35, because its own top is the handrail.
  - ⚠️ **`MAX_STAND_HEIGHT` is 0.5, and it is a legibility limit rather than a
    picking one.** Picking now finds a peak however tall it is. What binds is
    the camera: a surface at height `h` *draws* `h / tan θ` tiles up-screen of
    its own tile — `1.25h` at the starting angle, `1.73h` at the shallow end of
    the band — and past about half a tile it visually occupies its neighbour
    whether or not the click lands right. So the mesa covers 0.60 of the tile
    behind it at rest and 0.83 tilted right down. A voxel spike put this at a
    full tile and tile identity fell apart on sight.
- The models are [Kenney's Nature Kit](https://kenney.nl/assets/nature-kit),
  CC0, as GLB — the loader units already use. ⚠️ **The whole kit is in
  `public/models/terrain`, and only what `TERRAIN_MODELS` names is loaded**, so
  a piece a board needs is one name away and the rest cost nothing to play.
  What the code relies on, measured
  rather than assumed: ground tiles are **exactly 1×1 in x and z**, which is
  `TILE_SIZE`, so nothing is scaled; they carry no textures, only flat material
  colours; they are multi-mesh **split by material**, and the set shares a
  small palette of them, which is what makes merging by material worth doing;
  and every model hangs under a node translated **−0.05 in y**, so reading the
  position accessors gives heights a uniform 0.05 too high. ⚠️ `bridge_wood` is
  1.04 square rather than 1.00 and so overhangs its tile by 2% a side. That is
  deliberate — a deck rests *on* its banks — and is recorded here so nobody
  later "corrects" it. ⚠️ **A village's houses are not the kit's**: six houses
  from the Beelim packs, in `public/models/buildings` and loaded beside the kit
  by their `house_` names — textured, where the kit is flat colour, and a man
  to the unit.
- Terrain is built from **glTF models**, one per tile, and then **merged by
  material** — grouping every tile's meshes by material leaves about fourteen
  draw calls for a board, against several hundred as loose copies. ⚠️ That
  number grows with the *palette*, not the board — each genuinely new colour
  costs one, so a doodad painted in a material the board already has is free.
  Merging works because terrain is made once and never moves. ⚠️ **A material
  used once is rewound by hand.** The loader mirrors every model, and Babylon's
  merge rewinds a mirrored mesh's faces only when it has something to merge it
  with — alone, it comes back inside out, culled from the side it faces, and with
  the model's own index array, so the rewind is done on a copy. The close-up's
  one-tile board is mostly groups of one.
  `terrainModels.ts` loads the set and
  shares one material per name across all of them, which is what makes the
  grouping work. ⚠️ Three families are recoloured, because the kit reuses materials
  across things that must not look alike. A **road** shares `dirt`/`dirtDark`
  with a riverbank and gets grey gravel; a **mesa** shares the same warm orange
  and gets grey stone, keeping its grass cap; and **scenery on grass** would
  otherwise be the exact green of the ground it stands on, so it gets a warmer,
  lighter green. An override supplies a *name* as well as a colour, since the
  name is what merging groups on. ⚠️ **A cell may also ask for a `paint`**,
  where these recolour by model: sea is drawn with the river's own pieces, and
  its paint turns their water a deep teal — nothing anyone could wade, and not
  the blue army's colour; and a structure's ground is paved in the road's own
  surface, under the road's material name, so it costs no draw call.
- ⚠️ The loaded PBR materials are **replaced** with flat `StandardMaterial`s
  carrying their albedo. The kit ships `metallicFactor: 1`, and a fully metallic
  surface with no environment map to reflect renders blank white. Flattening
  also puts terrain and units in one lighting model. A house keeps its texture
  and both sides of its walls, which are single planes; it is loaded as the
  figures are, its texture's bytes raw, or a `StandardMaterial` draws it dark.
- `composeTerrain.ts` decides each cell's model and quarter turns, purely: a
  4-bit neighbour mask (`N=1, E=2, S=4, W=8`) indexes a table per family. A
  bridge belongs to **both** families — it is water with a road over it — so a
  river is not broken by its own crossing. Off the grid counts as more of the
  same for both families, so a river and a road run off the rim rather than
  growing a shore or ending in a cap. **Sea
  is the same body of water**, so a river opens into it with no bank across its
  mouth; a bridge takes the sea's paint when it spans sea. A bridge alone is
  one piece ramped at both ends; **a run of bridges along its own length is one
  crossing**, an end piece ramped onto each bank and middle spans between. A terrain it has no
  drawing for is a **compile error**, by the same `never` check `applyEvents`
  uses, rather than a tile drawn as plains.
- **A quarter turn replaces twelve of the sixteen sprites a tileset would need.**
  Base orientations are measured off the geometry, not assumed: `riverStraight`
  runs north–south at rest, `riverSide` banks south, `riverCorner` opens north
  and west. Water uses the *body* vocabulary and roads the *connector* one,
  since a road is never a body of anything.

- **The renderer records the state it last drew**, which is the state *before*
  whatever `playEvents` is animating: the queue awaits `playEvents` and only
  then calls `syncUnits`. A damage animation needs the health it counts down
  *from*, and `battleResolved` carries only resulting values (invariant 9), so
  `playEvents` folds each event onto that record as it goes and stages a battle
  against the fold so far. ⚠️ Not a second source of truth — a display copy,
  with authority still read from `server.getState()`.

  ⚠️ **Measured off the *loaded* mesh, not the file.** The glTF loader flips z on
  its own `__root__`, which leaves a model's bounding box where the raw
  accessors say it is while putting the *relief* on the far side of it — so a
  piece read out of the file faces backwards with its extents looking correct.
- The kit ships **two** water vocabularies — a body set for lakes and a channel
  set (`Bend`, `Split`, `Cross`) for one-tile rivers — and a 4-bit mask cannot
  tell which a cell wants: water north and east is a lake's corner if the
  north-east diagonal is water and a channel's bend if it is land. **The land in
  the crooks between a cell's water sides decides**: a corner with land in its
  crook is a bend, a side with land in both its crooks a fork, and open water
  with land on every diagonal a crossing. Each channel piece rests the way the
  body piece it replaces does, so it takes that piece's turns. ⚠️ A side with
  land in just one crook has no piece in either set and draws a square corner;
  `maps.test.ts` refuses it.
- Three things the mask alone cannot answer: an **inner corner** needs a
  diagonal, so mask 15 with exactly one land diagonal takes a corner model;
  **bridge orientation** comes from the ground at a deck's ends, because a
  two-lane crossing gives its decks masks 7 and 13 rather than 5 and 10 and a
  bridge may land on anything that is not water; and a bridge is
  a model standing *on* water rather than ground of its own, which is why it
  carries the one `standOn` in the renderer.
- Anything standing on a tile rather than being it is a **`Prop`**, and the
  tiler fills in all of it — model, offset, free rotation, scale. `terrain.ts`
  obeys and decides nothing, which is what keeps *where a tree goes* out of the
  drawing code and in the one module that is pure and tested.
- ⚠️ **Never the middle of a tile**, since a unit stands there — that is
  `KEEP_CLEAR`, and it binds anything a unit shares its tile with. The props
  it does *not* bind are the ones a unit stands **on**: a bridge deck and a
  mesa, both dead centre on purpose. Everything is placed from
  a deterministic per-tile value stream, so the board never reshuffles between
  scene builds.
- **A structure is a village**: four houses, one to each corner, round a
  square paved like the road, where a unit stands among them rather than on a
  roof. Each turns its door to one of the two streets that cross the tile, and
  which houses and which streets are the same every build. ⚠️ Drawn far under a
  piece's size, as trees are: at true size one house is three or four tiles
  across.
- **Hills are a mesa on an ordinary tile**, not raised ground. The trade is
  deliberate: a block fills its square and keeps every overlay flush but reads
  as masonry, while a rock does not fill a square — the hover and range tints
  sit at the mesa's height and float past its sloping edges — and reads as
  terrain, which is worth more.
- **A wood is scattered across the tiles it covers, not tile by tile.**
  `woodlands` flood-fills the forest tiles into four-connected groups — matching
  `neighbourMask` and every other neighbourhood question in the module — and
  `scatterWood` seeds one stream per group from its **scan-order first** tile,
  so the result is identical whatever order the fill walks in. Scattered over
  the board in its frame, so a wood at the edge carries on into the frame as
  one wood.

  Five trees a tile, planted **round robin**: one pass per tree, each visiting
  every tile of the group once, the first pass required so no square comes out
  bare. ⚠️ The visiting order rotates each pass, because whichever tile goes last
  has every neighbour's trunk already down to dodge — a fixed order thins the
  same squares every time.

  ⚠️ The spacing that turns a candidate away is measured **across tile
  boundaries**, which is what makes the group the unit of placement rather than
  the tile. `KEEP_CLEAR` still binds every trunk, because a unit may stand on
  any of those tiles — so each square keeps its hole however the wood is shaped.
- **Six tree shapes**, each turned and scaled. Every one is painted `woodBark`
  and `leafsGreen`, so a denser wood costs no draw call — the kit's pines carry
  two more materials each, which is why none is used. ⚠️ **They are scaled down
  hard, and the pieces set that number rather than the trees**: at model scale a
  wood stands several times higher than the army walking through it.
- **Open ground carries light scenery** — grass tufts, a small bush, the odd
  flower, on about a third of plains tiles. ⚠️ None of it means anything: a tile
  with a flower plays exactly like one without.
- **The board is drawn inside a frame** of `FRAME` tiles of land on every side,
  so it reads as a piece of somewhere larger. `frameGrid` extends the grid and
  the result is composed and drawn whole, so rivers and roads tile across the
  seam: each frame tile takes the nearest edge tile and each corner block the
  corner tile, except as `BEYOND` says — a road continues only where it crosses
  the edge, or a road along it would widen into a plaza; a bridge carries on as
  road where its road crosses and as its water otherwise; a structure becomes
  plains. ⚠️ **Drawing only**: it never enters `GameState`, and the renderer
  slices the board's own cells back out for standing heights, picking levels and
  the close-up. No grid lines, hover or overlays reach it, and a pointer past
  the board's edge finds no tile rather than the edge tile behind it.
  ⚠️ **A road that bends along the board's edge is carried off it** as if it
  crossed, since the edge tile's road runs on into the board; it reads as a
  road leading on.
- Grid lines are **one flat grid at the board's floor**, over the board and
  never the frame, mid grey at 7%. Hills
  raise a *rock*, not their ground, so every tile's floor is the same
  plane. Long spans draw each interior edge once rather than twice, so the alpha
  means what it says.
- **A slab under the board** — `boardBase.ts`, sized to the board in its frame
  exactly, so the land ends in a hard edge with its earth showing, as a diorama
  does; not pickable and unknown to `surfaceAt`. ⚠️ Plain, and the lighting is why: every face of a
  cliff model is vertical and the only light is hemispheric from above, so
  relief takes one shade the whole way round. The slab is what makes the board
  an object rather than geometry that stops. ⚠️ It hangs off `bottomOf` — the
  **lowest geometry** on the board — where the grid lines take the highest
  *top*. The two ask different questions, and the reason is that **a tile is not
  flat**: a river is a channel cut *down* into its tile, banks at 0.00 and water
  at −0.05, and a road is recessed the same way. A slab placed by `topOf` is
  therefore drawn straight through both, and the board's water and gravel come
  out slab-coloured — which is not a subtle failure but does look like a
  deliberate palette until someone asks where the blue went. A further 0.01 sink
  clears the ground plane, which has no thickness of its own and would otherwise
  depth-fight a coplanar face in bands that move with the camera.
- A highlight follows the pointer, moved from `POINTERMOVE` inside the
  renderer. React never hears about hover. ⚠️ That highlight is **all** hover
  does — a tint, inert on a touchscreen. The route is selection state rather
  than a hover effect, so it survives on a device with no pointer: the second
  click is what supplies the destination.
- **A unit's health is a ring of ten segments at its base** — `healthRing.ts`,
  extinguishing as it weakens and **absent entirely at full strength**, since a
  ring under every untouched unit is noise. ⚠️ **One segment per band, calling the rulebook's own `band`** — the same
  function `computeDamage` reads, so 91 and 100 show the same count *because*
  they fight identically. Segments extinguish rather than dim, since bands are
  discrete.
  ⚠️ **Parented to the unit's node**, so it rides the walk animation for free and
  is disposed with it. It therefore turns with the unit; accepted, since a ring
  is rotationally symmetric and only the segment boundaries move. ⚠️ **In
  tiles, one size on every piece**: `PIECE_SCALE` sizes a unit's model, never
  the node the ring hangs from.
  ⚠️ Orange-red, deliberately **not** the amber `SELECTED_COLOR`/`FACING_COLOR`
  family, which reads as another selection tint under the piece. One material
  for every ring, cached on the scene by name, which the
  `disposeMaterialAndTextures: false` a figure disposes its node with keeps
  safe.
  ⚠️ **`syncUnits` is its only writer and it never tweens.** The ring is
  persistent state; showing *change* belongs to the cutaway. That keeps it out
  of `playEvents`, where an animation on the ring would be a different target
  from the unit node and would survive `scene.stopAnimation(mesh)`. The one
  exception is a death, which puts the ring out before the figure falls.
- **A unit's charge meter is a small number beside it**, counting up —
  `chargeCounter.ts`, a digit on a dark disc — and an inverted disc once
  `chargeReady`, the same on every type, since a digit is a different distance
  from a charge on each. **Absent at 0**, so a unit that cannot charge never
  shows one. ⚠️ A number rather than three segments around
  the health ring, which has no room outside it on infantry. Made and removed
  with the health ring, and kept current by the same per-unit update that sets
  the ring and the walk; like the ring, parented to the unit node and in tiles.
  ⚠️ **Billboarded**,
  which in Babylon keeps the parent's position and scale but not its turn, so
  the digit faces the camera and an offset baked sideways into its own plane
  holds it to the figure's right on screen whichever way the unit looks. One
  material per digit, cached on the scene by name, for the same
  `disposeMaterialAndTextures: false` reason.
- **The pinned route is an arrow, not a tint** — `routeArrow.ts`, a sibling of
  `tileOverlay.ts` that merges per-tile quads into one mesh the same way and
  adds UVs. A tint says *these tiles*; an arrow says *this way, ending here*.
  Four shapes cover every case, because **a path never branches** so no tile
  connects to three neighbours: tail, straight, corner, head. ⚠️ Orientation is
  a **cyclic shift of the four UV corners**, not a per-tile transform, so every
  quad stays axis-aligned and there is still one draw call. The ring order
  `N E S W` is load-bearing — a rotation is `+1` around it, which is what makes
  orientation arithmetic instead of a lookup table, and the four rotations of a
  canonical `{SOUTH, EAST}` bend cover all four bends exactly.
  **A one-tile path draws nothing**, so standing still needs no fifth shape. The
  atlas is strokes drawn into a `DynamicTexture` with canvas 2D at startup — no
  asset file — in white, with the colour on the material's `emissiveColor`.
  ⚠️ Babylon's
  `ICanvasRenderingContext` has no `lineCap`; the default `butt` is wanted
  anyway, since a flush end is what lets one tile's segment meet the next
  without a seam. ⚠️ **Over the board and under the units**, as Advance Wars
  draws its arrow: among the trees, a route through a wood showed nothing but
  its head. It is drawn in a rendering group after the board's, ignoring depth
  and writing none, and every mesh of a unit — ring and counter included — in
  the group after that. Neither group clears depth, so a unit still stands
  behind a hill.
- **Units are the period figures**, every file loaded once into
  `AssetContainer`s and cloned per figure — a skinned mesh is always cloned,
  with its own skeleton and animation groups. `render/figures.ts`, pure, says
  what there is: a figure's **role** (infantry, cavalry, general, gunner, crew,
  gun), the **body** each role moves as, every animation each body answers to,
  the file a role is drawn from for a side, and `PIECE`, the role that stands
  for each unit type on the board. ⚠️ **A side's colour is its army**, blue
  Continental and red British, and the gun serves both.
  - **What `instantiate` hands out is a `Figure`**: `node`, ours, to place and
    turn and hang the ring and counter from; `model` beneath it, to size; `play`,
    which loops a motion and changes nothing when asked for the one playing;
    `playOnce`, which plays one through, holds its last frame and resolves; and
    `dispose`. ⚠️ **`dispose` takes the skeleton and the animation groups as
    well as the node**: they are the figure's own copies, in the scene, and a
    group left behind animates a dead skeleton. The node goes with
    `dispose(false, false)`, since every figure from a file shares its
    materials. A figure starts standing, since its rest is a T-pose.
  - ⚠️ The node is ours because the loader's `__root__` carries the
    right-handed-to-left-handed conversion as a negative scale, and a facing
    rotation set on it would compose with the flip and turn the unit the wrong
    way. Figures face `+Z`, which is north here, so there is no offset.
  - The loader is told to start no animation, which it otherwise does on the
    container's own nodes, which nobody draws.
  - ⚠️ **Unlit**: each file's materials are swapped once for `StandardMaterial`s
    with lighting off, carrying the same texture, two-sided where the file says
    so. Lit, a figure's sides fall into shadow under a light from above exactly
    where the silhouette has to read. ⚠️ **The loader is told to keep textures
    as raw bytes** (`useSRGBBuffers: false`): by default it puts a colour
    texture in an sRGB buffer, decoded as it is sampled, which only PBR encodes
    again on the way out, so a `StandardMaterial` drew the Continentals' navy
    black. So a texture draws as painted.
  - `unitModels.test.ts` holds every file to its body's whole vocabulary,
    since the converter names the animations and the renderer asks for them,
    in two languages.
- **The buildings** are in `public/models/buildings`, made by the same
  `bun run models` — which writes figures under `units/` and buildings under
  `buildings/`, and takes the names of either to convert only those. `building.py`
  cuts each house out of the file or scene it was modelled in, with whatever
  hangs from it, applies its modifiers and joins its parts, and stands it on its
  own base at the origin with its door turned to the front:
  - **A man to the unit**, from scales that differ file to file: the town and
    harbour scenes share one, set by a supply wagon they have in common with the
    figures' pack, and each pickets house takes its own from the copy of the
    same house in the town.
  - **Its base colour alone**: each material rebuilt matte from the image that
    colours it, named for its house so no two houses merge on the board as one,
    one material to an image, at 256 pixels. The packs' normal and specular maps
    go. A texture is found in its pack by name, whatever its case or extension,
    since the scenes point at their authors' own folders.
- **The period figures** are in `public/models/units` — one GLB per army and
  figure (`british/infantry`, `continental/general`, …) and one `gun.glb`, a
  falconet on a truck carriage, compact enough to stand half a man's height on
  its tile, which both sides field.
  `scripts/models/convert.py`, run by
  `bun run models` through Blender, makes them from licensed packs kept outside
  the repo — in `~/Development/awi-models` unless `AWI_MODELS` says otherwise,
  over half a gigabyte with their zips — so only what the game loads is
  committed:
  - **Each animation is an Action**, posed by `rig.py` from where limbs point
    and where hands go — a two-bone solver puts both hands on the musket —
    with one set per body: `foot.py` for infantry, gunners and unarmed crew,
    `mounted.py` for cavalry and generals, `gun.py` for the gun. A figure can be
    dressed before it is posed — given a sabre or a flag. The foot share
    one skeleton and the mounted another, so a body's set fits every figure of
    it. Directions are read off each model's own rest pose, not written down.
  - ⚠️ **Stepped**: sampled at twelve a second and its samplers marked `STEP`
    after export, since the exporter writes `LINEAR` however the keys were made.
  - ⚠️ **Matte, at 256 pixels**: several sources leave glTF's default metallic
    factor of one, which draws black with no environment to reflect, and every
    texture is replaced by a 256-pixel copy, since a packed image is exported
    from its packed bytes whatever its pixels became. Textures left loose
    beside a model are applied to it.
  - **One scale for all**, `0.25` on the armature, since the packs share one:
    a man on foot is about a unit tall, and horses and the gun keep their
    proportions.
  - **The generals are told from their cavalry** on the board: the
    Continental is a hussar on a pale horse, the British the Queen's Rangers'
    officer in green on a grey. The Ranger holds no sabre, so he is handed
    Mawhood's trooper's, in the donor's own material, since his atlas paints
    something else where the sabre's faces point. The glTF importer's
    bone-shape object is deleted before export.
  - ⚠️ **Both generals carry a flag**, built by `flag.py`: a pole beside the
    rider's left hip and a flag flying back from it, as from a rider going
    forward — broadside from the side, near edge-on from before or behind.
    Skinned wholly to the rider's seat, it rides every animation and falls with
    him. It has a small
    texture of its own, drawn pixel by pixel and sampled nearest — the British a
    crimson standard with the Union of 1606 in the canton, the Continental
    Washington's headquarters standard, thirteen white stars on blue. ⚠️ Its UV
    layer is named after the figure's first, or joining files its coordinates
    in a second layer and the flag draws as one corner of its picture.
- ⚠️ **A unit that can act walks on the spot; any other stands** — the PS1
  idle, in lockstep, and the mark of who is still to move. *Can act* is
  `canSelectUnit` while the game is not over, so the side not to move stands
  even where a unit of it was never used. One per-unit update sets the ring, the
  counter and the motion, from the build as well as from `syncUnits`, because
  the first board sync arrives before the renderer exists. The same walk carries
  a unit along its path.
- Model origins are at the base, so a unit's `y` is the surface it stands on
  rather than half its own height — and so scaling a piece grows it upward off
  that surface rather than sinking it through one.
- **A side's colour is drawn only by the cutaway's health bar**, from
  `render/playerColors.ts`. The board draws none: a side's figures wear its
  army's uniform.
- ⚠️ **Pieces are not at terrain scale, deliberately.** `PIECE_SCALE` in
  `units.ts` is a `Record` per unit type: a unit is a formation drawn as one
  figure, so no size makes it and a tree both correct, and a piece is sized to
  read on its tile. The target is height, capped by the tile: the gun meets the
  tile's depth first and stays lower than the men. ⚠️ **It scales the figure's model, not the unit's node**, so the
  ring and counter hanging from the node are one size on every piece.
- Unit meshes are built at startup and never added mid-match; `syncUnits`, below,
  removes the dead.
- `playEvents` walks `unitMoved` paths one tween per tile, at
  `FRAMES_PER_TILE` over `FRAME_RATE` in `units.ts` — one dial for every unit's
  pace. Each step turns the mesh before it moves, so a unit walks the
  way it is looking; the turn is snapped rather than tweened.
- `syncUnits` makes the meshes match state: it **removes the dead**, then
  positions *and* orients the living with no tween, stopping any running
  animation first. It **ends any preview** before either — authority overwrites
  every position, so there is no separate commit step, and a live preview holds
  a mesh by id that must not be disposed mid-tween.
  ⚠️ **Removal only, never creation.** Nothing can add a unit to a match — units
  enter state once, in `createMatchState`, before the renderer is built.
  Disposal is the figure's own, which keeps the materials its file's other
  figures share.
- **The preview** is one nullable `{ unitId, origin, facing, settle }`. The
  record outlives the walk, because a cancel *after* the unit lands still needs
  to know where to put it back. ⚠️ The promise means *the preview settled*,
  including a cancel or a snap ending it early — `stopAnimation` fires no end
  callback, so a promise tied to the tween alone would hang.
- `playEvents` **skips a `unitMoved` whose mesh already stands at the path's
  destination**. A confirmed preview has walked the unit there, and replaying
  would send it back to the second tile and forward again. Positional rather
  than a flag, and sound because the menu only opens once the walk has arrived.
- `setUnitFacing` is the only writer of `rotation.y`.
- Babylon imports are **per-file**, not from the `@babylonjs/core` barrel. Side
  effect modules are imported where the augmented method is used:
  `Animations/animatable` for `beginAnimation`/`stopAnimation`, `Culling/ray`
  for `createPickingRay`, and `@babylonjs/loaders/glTF/2.0` to register the
  glTF plugin — the `2.0` entry point specifically, since the package root
  would also pull the legacy 1.0 loader. `Debug/debugLayer` and `@babylonjs/inspector` load
  via dynamic `import()` inside an `import.meta.env.DEV` guard, so neither
  ships in production.

## Configuration

One `.env`, at the repo root; bun does not walk up, so server scripts pass
`--env-file=../../.env`, and Vite reads `PORT`, `API_ORIGIN` and `BUILD` from the same file. A
missing `.env` leaves the vars unset and the defaults apply. `.env.example` is
committed. ⚠️ **Under `NODE_ENV=production` the server refuses to start**
without `DATABASE_URL`, `DATABASE_AUTH_TOKEN` and `GUEST_KEY`, naming whichever
are missing, rather than fall back to a local file or the development key.

| | |
|---|---|
| `PORT` | server port, default 3001 |
| `DATABASE_URL` | `file:./packages/server/wargame.db` locally, a `libsql://…` URL on Turso |
| `DATABASE_AUTH_TOKEN` | Turso's token for that URL; unset for a local file |
| `API_ORIGIN` | the server's address, compiled into the client; unset, the local server on `PORT` |
| `BUILD` | a release's build number, compiled into the client and reported by the server; unset, 0 |
| `GUEST_KEY` | the key guest tokens are signed with; fixed outside production, required inside it |

## Testing

Every package is tested. `bun test` runs `shared` and `server`, Vitest runs
`client`, and the root `test` script runs both.

**CI** is `.github/workflows/ci.yml`: `bun run gate` on every push to `main`
or `production`, on Bun from `packageManager` in the root `package.json` and
Node from `.nvmrc` — Vite and Vitest run on Node — both set up by the local
action `.github/actions/setup`. Actions are pinned to commits and the token is
read-only.

The release jobs that follow it on `production` are described under
*Deployment*.

- Server tests use `:memory:`, migrated by the suite itself, since the server
  never migrates. `match.test.ts` takes a fresh database per test;
  `http.test.ts` holds one server for the file and isolates per match.
- `http.test.ts` drives real `fetch` against `createServer({ port: 0,
  database: <migrated :memory:>, clientDist: <fixture> })`. It never uses the
  real client build.
- Two suites use a temp directory and clean it up: `db.test.ts` for real
  database files, `http.test.ts` for its fixture dist. `db.test.ts` also opens
  one probe file beside the server source, to show a relative `file:` URL
  resolving against the repo root, and removes it. Nothing else touches the
  filesystem.
- Client tests use happy-dom and `@testing-library/react`. `src/test-setup.ts`
  registers `cleanup()`, which Testing Library cannot register itself here
  because this repo imports its test functions explicitly.
- `fetch` and timers are faked in `gameServer.test.ts`; every timer advance is
  the async form.

- React components are tested with the renderer mocked, so Babylon never loads.
  What the suites cover is chrome, lifecycle, and what each interaction
  *projects* — never pixels. ⚠️ **Disposal is tested wherever a renderer or a
  connection is built**, including one that finishes arriving *after* teardown,
  because that is the failure which leaks in silence: an undisposed scene holds
  a WebGL context and a render loop, and nothing on screen looks any different
  for several of them.

- **`routeArrow.pieceFor` is tested** as the only part of that module that
  *decides* anything: a wrong rotation on one of the four bends stays invisible
  until somebody routes that way.
- `composeTerrain` is the one piece of the renderer that is pure, and it is
  tested like any other pure module — including that no cell declares a
  `standOn` above `MAX_STAND_HEIGHT`. The other half of that ceiling is how tall
  a *model* measures, which nothing can know without loading it, so
  `warnIfTooTall` checks the whole surface at startup instead. ⚠️ An asset test would need
  `node:fs`, and `client/src` is deliberately a browser-only program with no
  Node types — the same boundary that makes a stray `import 'react'` in
  `server/` a resolution error.

**Not covered:** the renderer itself, which is WebGL — a browser is its only
check, and the `/run-app` skill drives the app headlessly for that, addressing
tiles through the dev build's `window.__board` rather than guessing pixels. `App.tsx` is
a route table with no logic of its own.

⚠️ **Every test file is typechecked**, `shared`'s included — `tsconfig.dev.json`
is what pulls its tests and scripts into a program, and the root references it.
See below for why that config exists and why it does not weaken invariant 2.

**Typechecking** reads `shared`'s source directly: `server` and `client` resolve
`@wargame/shared` through its `exports` and pull that source into their own
programs. `shared` emits nothing. `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
`erasableSyntaxOnly` and `verbatimModuleSyntax` are on in every tsconfig.
`shared` has no program of its own for `src`, and its `tsconfig.json` does two
jobs. ⚠️ **It is the name editors look for** — the language server walks up for
`tsconfig.json` *specifically*, so `src` would otherwise be edited under default
options with no `strict`. ⚠️ **And it is the only place `src` has no bun
types**, which makes the rulebook's purity visible while you type: `process.env`
in `combat.ts` is red in the editor rather than a surprise at the gate.

⚠️ `extends` **replaces** `include` rather than merging it, which is why
`tsconfig.dev.json` names `src/**/*.test.ts` explicitly instead of inheriting
`["src"]`. That is load-bearing: it is what keeps `src/*.ts` out of the
bun-typed program.

The root `tsconfig.json` is a solution file over **three** projects: `server`,
`client`, and `shared/tsconfig.dev.json`. ⚠️ That third one covers everything in
`shared` that is **not the rulebook** — `scripts/` and `src/**/*.test.ts` — with
its own `types: ["bun"]`, which is what gives the harness `console` and the
tests `bun:test`.

⚠️ **Types are per-program, so this does not weaken invariant 2.** `src`'s own
config is untouched, and the **client** program also checks `src` with no node
or bun globals, so giving test files bun types cannot let `process.env` into
the rulebook. The rest of invariant 2 is lint's — see the invariant.

⚠️ An `include` matching an empty directory is `TS18003` and a non-zero exit, so
this config cannot exist before the directory it names has a file in it.
**`@types/bun` is a devDependency of `shared`** — the one package whose defining
property is having none — and that is the price of the test files being
typechecked at all.

## Deployment

The game is hosted, and every part of it is in one of four places:

- **The server** is one Fly.io app, `wargame`, at `https://wargame.fly.dev`: a
  single machine in `iad` that answers `/api/*` and serves the built client for
  everything else. It stops when idle, and the next request starts it.
- **The database** is Turso, in `aws-us-east-1`, beside the app. The server
  holds nothing between requests but transient state — the limiter's counts
  and presence — so the machine can stop, restart or be replaced without
  losing anything that matters.
- **The client** is one `dist`, deployed twice: served by the Fly app itself,
  and uploaded to itch as `g00dgh0st.itch.io/gunpowder-tactics`, channel `html5`,
  Restricted — where it runs inside itch's iframe and calls the Fly API
  cross-origin, at the address compiled into it.
- **The release** is a GitHub Actions workflow, whose release jobs run in the
  repository's `production` Environment, which alone holds the deploy
  credentials.

In development the same shape runs locally: Vite serves the client, which calls
the local server cross-origin, on a local SQLite file.

### Releasing

⚠️ **`git push origin main:production` is a release**, and nothing else is.
`main` is the working branch: a push there runs the gate and deploys nothing.
⚠️ **`production` accepts only a commit whose gate has passed** — GitHub's
ruleset on it requires the `gate` check — so a release is pushed after `main`'s
run for that commit has gone green. The workflow, `.github/workflows/ci.yml`,
then runs three jobs:

1. **`gate`** — `bun run gate` on the commit, with `API_ORIGIN` and `BUILD` set,
   so the build it checks is the build that ships: on `production` it hands
   that `dist` on as an artifact. `API_ORIGIN` is written in the workflow and
   nowhere else; `BUILD` is the workflow's run number.
2. **`deploy-server`** — refuses a commit `main` does not already contain,
   installs a pinned `flyctl` checked against its SHA-256, and deploys with
   Fly's remote builder, passing the Bun version from `packageManager` and
   `BUILD` as build arguments. Fly runs `migrate.ts` as the release step, on a
   temporary machine, before replacing the running one — a failed migration
   stops the deploy with the old machine still serving. ⚠️ **Then it checks the
   release answers**, since the health check touches nothing: the page, a route
   that reads the maps, one that reads the database, and that the build the
   server reports is this one. A broken release stops here, before itch.
3. **`push-itch`** — ⚠️ **only after the server**, so the server is always the
   newer of the two and accepts the client it replaces. It deletes the `.br`
   and `.gz` siblings from its copy of `dist` — only the server serves them,
   and itch counts every file against its limit — fails if more than a
   thousand files remain, and pushes with a pinned butler, checked against its
   SHA-256, labelled with `BUILD`.

⚠️ **The two release jobs hold one secret each and run no npm code**: they
take the gate's `dist` rather than building, so nothing a dependency runs ever
shares a runner with a deploy credential. Each has a time limit.

**Runs on one branch queue**: a newer run waits for the one in progress and
replaces any already waiting, so releases go out in push order and the newest
wins. ⚠️ **`BUILD` counts the workflow's runs**, gate-only ones included, so it
only rises: a client always knows when the server is newer.

**What players see.** The one machine is replaced in place, so a release takes
the game offline for a few seconds, under the reconnecting banner. A tab open
on the old client then shows the reload banner — on itch, asking for the page
to be reloaded. itch processes an HTML5 build
before it goes live — minutes normally, longer during an itch incident — and
refuses another push to the channel meanwhile, so that refusal, and only that
one, is retried for ten minutes; while itch processes, its copy shows the reload
banner to no purpose, since a reload still brings the old client. ⚠️ **The server goes
first, so it has to answer the client it replaces**: old clients are browsers
still running the build they loaded, and the itch copy trails the server while
itch processes. A changed API keeps an old request working through its
defaults — creating with no mode is hot-seat with no clock — until the reload
banner has done its work.

**Rolling back.**

- ⚠️ **Run the workflow by hand from the `production` branch**, naming the
  older commit by its full SHA — the gate refuses anything shorter, which
  checkout would read as a branch name. It releases that commit under a new
  build number, so clients reload onto it. Only a commit this workflow released
  can be rolled back to: the run uses that commit's setup action, gate and
  `Dockerfile`.
- ⚠️ **Never by re-running an old run**, which reuses its old run number and
  takes `BUILD` backwards.
- **Faster, server only**: `fly releases -a wargame --image` lists the images
  of earlier releases, and `fly deploy --image <one of them>` puts one back
  without building — itch keeps its current client, which the older server
  must then accept.

### The image

The root `Dockerfile`: one stage on `oven/bun:<version>-slim`, since nothing is
compiled in it — Bun runs the TypeScript, and the client arrives built in
`packages/client/dist`. ⚠️ **Its Bun version has no default**: the build passes
`BUN_VERSION` from `packageManager`, so the pin is written once.
`bun install --frozen-lockfile --production --filter @wargame/server` installs
the server's runtime dependencies only, inside the image — the isolated
linker's `node_modules` are links into a store, which a copy would not carry.
`NODE_ENV=production` is set there, `BUILD` comes in as a build argument —
0 when none is passed, as everywhere else — and stays as the environment, and
it runs as the image's non-root `bun` user, starting
`bun packages/server/src/http.ts` itself rather than the `start` script, whose
`--env-file` names a `.env` the image does not have.

⚠️ **`.dockerignore` is an allowlist**: `*`, then `!` for exactly what the image
copies — and then, **last, because the last matching line decides**, `.env*`,
database files, `node_modules` and tests out again at any depth, since a folder
let in admits everything inside it. A file nobody has named stays out, wherever it
lands; checked with Docker's own matcher, `moby/patternmatcher`, over the
working tree.

### Fly

**`fly.toml`** describes the app: one `shared-cpu-1x` machine with 256 MB in
`iad`, `auto_stop_machines = 'stop'` with `min_machines_running = 0`, so it
stops when idle and the proxy starts it on the next request; `force_https`; a
health check on `GET /api/health` every 30 seconds, which touches no database;
and `migrate.ts` as the `release_command`. Fly builds the image remotely, so
deploying needs no local Docker.

**Secrets** are set in Fly and appear nowhere in the repository:
`DATABASE_URL`, `DATABASE_AUTH_TOKEN` and `GUEST_KEY`. Without any of them the
server — and the release step — refuse to start. ⚠️ **Rotating `GUEST_KEY`
signs every guest out**, and since a match belongs to a guest, every match
becomes unreachable with it.

CI deploys with an app-scoped deploy token named `github-actions`, which can
deploy `wargame` and nothing else; `fly tokens list -a wargame` shows it.

### The database

Turso, on the Developer plan with **overage off**: a quota is a wall rather
than a bill, and over it queries fail as `BLOCKED` until the month resets —
which the server's limits exist to keep from happening. The local-file
`PRAGMA`s are skipped for a remote URL. ⚠️ **Migrations stay additive**,
because for a moment while the machine is swapped the old code serves against
the new schema.

### itch

⚠️ **butler names the project by its address**, so renaming it on itch means
changing `ITCH_TARGET` in the workflow — the old address only redirects
browsers, and butler calls it an invalid game.

The project `g00dgh0st.itch.io/gunpowder-tactics` is an HTML game: its upload is played
in the browser, embedded at 960×640 — itch's default page width, with room for
the status line under the board — with a fullscreen button, "Mobile friendly"
off, and "SharedArrayBuffer support" off, since it adds isolation headers the
game has no use for. Visibility is Restricted, with a password.

### GitHub

⚠️ **The repo is private, because of the figures.** Beelim's licence allows
using and editing its models in a game but not distributing them, which a
public repo would do. GitHub Pro is what keeps the `production` Environment,
its secrets and the ruleset on a private repo.

The `production` Environment may be used only by the `production` branch, and
holds the only two secrets — `FLY_API_TOKEN` in `deploy-server`, and
`BUTLER_API_KEY` in `push-itch` — so no run from `main`, and no fork, can reach
them. A ruleset on `production` requires the `gate` check, as reported by
GitHub Actions, and refuses force-pushes and deletion, with nobody exempt. The
default workflow token is read-only; every action is pinned to a commit, and
`.github/actions/setup` sets up Node and Bun for the gate. Node is pinned to a
major version in `.nvmrc`, since it only runs the build tools; Bun exactly, in
`packageManager`, since it runs the server.

### Operating it

- **Logs and state**: `fly logs -a wargame`, `fly status -a wargame`.
- **A deploy by hand**, only if CI cannot: build the client with
  `API_ORIGIN=https://wargame.fly.dev` and a `BUILD` one above the last run's
  number, then `fly deploy` with the same `BUILD` and the Bun version as build
  arguments. ⚠️ **The same number in both**, or every client is out of date and
  a reload never clears the banner; and no higher than that, or the releases
  after it look older than what clients already hold.
- **Looking at the hosted database**: the local `.env` keeps the Turso pair as
  `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. ⚠️ **Never as `DATABASE_URL`**,
  which `bun run dev` and the `db:*` scripts read — that would point local
  development at the real database.

### Setting it up again

Done once, by hand, in this order:

1. **Turso**: a database in `aws-us-east-1` and a full-access token.
2. **Fly**: `fly apps create`; the secrets, imported staged; the first deploy
   by hand with `--ha=false`, since a first deploy otherwise makes two machines.
3. **GitHub**: the `production` Environment, limited to its branch; the
   ruleset on `production` — the `gate` check required, no force-push, no
   deletion; `FLY_API_TOKEN` from `fly tokens create deploy`, piped into
   `gh secret set` so it is never printed; `BUTLER_API_KEY` from itch's API
   keys page.
4. **itch**: the project as an HTML game, Restricted; after the first release
   has pushed a build, the embed settings above.
