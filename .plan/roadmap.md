# Wargame — Roadmap and design

Forward-looking only: what is designed but not built. Order is the table
below. What the code does *today* is in
[`architecture.md`](architecture.md); nothing here describes current
behaviour.

---

## Order

**This table is the only place order lives.** Everything below is an *epic* — a
chunk of work, not a step in a sequence — and the sections are in whatever order
they were written in.

⚠️ **A phase number is an identifier, not a position.** The numbers below are
kept because links, commits and cross-references already use them, and they say
nothing about what comes next. Epics added from here on get a **name and no
number**. Reordering is editing one row of this table and nothing else.

| Order | Epic | |
|---|---|---|
| 1 | **Presentation** (11) | The PS1 look, then sound — the period figures are in |
| 2 | **UI and interaction** | The chrome, and how it feels to give an order |
| 3 | **An AI opponent** | A side the game plays, for one person on their own |
| 4 | **Security and infrastructure hardening** | What a public server needs after its first deploy — and what multiplayer has shown it needs |
| 5 | **The itch page** | What a stranger meets — the page, its credits, how to play, a way to say what went wrong — and opening it to them |
| | ━━ **Early access** ━━ | *Everything above the line is what testing at scale needs* |
| 6 | **Content** (14) | Maps in a table, an editor, and the numbers |
| 7 | **Accounts and sign-in** | An identity that outlives a browser, for what a player keeps |
| 8 | **Platforms** (15) | The portals that gate, review, or supply accounts |

**The line is a milestone, not an epic.** Above it is everything solid testing
needs: a link that can be sent to anyone, who can then play — against another
person, or alone against the AI — and a page that could open on itch as early
access, to see whether anyone plays — and looking like the game it is. Below
it is what makes the game broad, decided once real players have said what it
needs.

Wanted but unscheduled is under *Ideas*, at the bottom.

⚠️ **One ordering constraint is real**: *Accounts and sign-in* → *Platforms*,
because the portals that supply their own accounts need somewhere to put
them. Everything
else is a preference, and preferences change.

⚠️ **Cross-references name an epic rather than number it.** The rule has been
earned twice — inserting a phase once turned six pointers in *Known compromises*
at the wrong thing, and moving *Presentation* to the front broke every surviving
number in the section below. A name survives a reorder; a number is something
somebody has to remember to recount, and nobody does.

## Known compromises

Deliberate limits of the current design, and what each would take to lift. Distinct from *Out of scope for v1* below, which is unbuilt features rather than accepted limits.

| | Current state | What it needs eventually |
|---|---|---|
| **Session identity** | A signed guest token in a header, held by the browser and renewed while it plays; the server stores nothing of it but a name, once it makes a game | *Accounts and sign-in* — Better Auth, with sign-in through itch, Google or Discord. No passwords at any point |
| **The guest token is readable by every itch game** | It lives in `localStorage`, and itch serves every game from one origin, so any of them can read it and play that guest's matches — for as long as it keeps using the token, since use renews it. Accepted while a guest's games and its name are all a token buys | A real sign-in, whose session is worth protecting — and then the choice below is made again |
| **Async play** | Works already — a returning client fetches current state and resumes, and the list says whose turn it is. What's missing is being told, away from the page | *Turn notifications*, under *Ideas*. Not new mechanics |
| **Ruleset versioning**, and with it **old matches are expendable** | None. ⚠️ `current_state` and `initial_state` are JSON columns with `.$type<GameState>()`, which is a **compile-time cast and no runtime check** — so a match stored before a field existed reads back missing it while the types insist otherwise. A shape change therefore does not migrate rows; it abandons them, and that is **accepted policy until a ruleset id exists** rather than an oversight. The dev database is gitignored scratch: delete it. ⚠️ The failure is silent where it matters — a `Unit` with no `health` is `undefined`, and `undefined` arithmetic is `NaN`, so the first symptom is a damage number rather than an error | Stamp a ruleset id on the match so old logs replay under the rules they were played with. That is also what retires the policy above: a match that knows its ruleset can be refused rather than quietly misread |
| **Maps live in code, not a table** | Modules in `server/maps/`; `map_id` is a plain text column with no foreign key. Picked from at match creation, and browsable at `/maps` | ✅ **Decided** — a `maps` table plus an editor, in *Content*. ⚠️ The other condition — enough maps to choose among — has already been met, so this is due a re-read rather than a wait; see below |
| **Elevation is visual only, and capped at 0.5** | Height is a look, never data. A mesa and a bridge deck raise where a unit *stands*, but `shared/` has no idea: there is no height on a tile, `entryCost` never asks about one, and no rule reads one. ⚠️ Both halves of the old technical objection are now gone — `screenToTile` tries every surface height tallest-first, so a click finds a peak where it is drawn, and `surfaceAt` is a lookup that knows each tile's height. What caps height now is the *camera*: at 38.6° a surface at height `h` draws `1.25h` tiles up-screen, and past about half a tile it occupies its neighbour | ⚠️ **Nothing — this is where it stays.** It was once written here as waiting on machinery, which stopped being true when picking learned about height, and elevation as a *rule* is now declined for v1 rather than queued. Mesas are enough at this board size. The reasons, and the two findings worth keeping if it is ever reopened, are in *Out of scope for v1* |
| **Shared build step** | TS source consumed directly, bun-only | A build if the server ever moves off bun |

### Duplication left on purpose

From the code-health review that gave each rule one home. These looked like
duplication and were left alone, because the copies cannot disagree today or
the fix would cost more than the risk — DRY and KISS together. Revisit one when
its reason stops holding.

- **`band()` dividing by the number of bands**, a band's width only because
  `MAX_HEALTH` is 100. Not silent: `combat.test.ts` pins `band(MAX_HEALTH)` to
  `BANDS`, so changing `MAX_HEALTH` fails the build, and that is when to fix it.
- **An `ATTACK_KINDS` list for the protocol's `'attack' | 'charge'` check.** A list
  beside the union would be a second home rather than one, and a new kind
  already fails loudly, as a 400.
- **The lobby's `winner === null` rather than `isOver`.** It asks *is there a
  winner to name*, not *is it over* — after a draw they would differ — and it
  keeps TypeScript's narrowing of `winner`.
- **The movement budget, looked up by three callers** (`validateMove`, the
  overlay, the bot). A catalog lookup rather than a rule; worth one home only if
  a budget ever comes to depend on state.
- **The attacker after its move, built by hand five times without its new
  facing.** One spread; nothing reads an attacker's facing — only a defender's —
  and `validateMove` already decides what an attack ends facing.
- **Adjacency asked as neighbours in one place and as distance 1 in another.**
  Identical on a square grid by definition.
- **`hitsToKill` applying damage by hand.** It counts unanswered hits on
  purpose, and `health − damage ≤ 0` is the whole of the rule it uses.
- **`health <= 0` in four places.** The plainest statement of one fact; a
  helper would not be simpler.
- **`MAX_ANIMATED_EVENTS` derived from what `resolveAction` emits.** A pacing
  choice, not a rule; a new event type costs at most one snapped animation.
- **The client's `ok: false` meaning both a refusal and a network failure.**
  Client-internal, and the panel shows the reason either way.
- **The menu reading the display copy while the forecast reads the server's.**
  They cannot differ while the selection resets on every submit.
- Unfrozen server constants, duplicated test helpers, and the charge harness
  naming approaches by hand: cosmetic.

### Maps in a table

✅ **Decided: maps become a table.** The trigger condition below was met a
while ago and the decision is now taken rather than pending. ⚠️ It also grows a
second half that was never in the original argument — **a map editor**. Rows in
a table are only better than modules if something other than a text editor
writes them, and an editor is what turns "maps are content" from a claim into a
fact. That is a phase of its own and belongs in *Content*, not here; what
belongs here is that the storage decision no longer waits on anything.

⚠️ **The original argument, unchanged, and its condition:** It said *revisit when there are enough maps to choose among* —
there are enough to choose among, and **two** screens now pick between them:
`StartScreen` chooses what to play on and `/maps` exists only to look through
them. That is the picker
this section names as what turns maps into a library rather than a constant, and
a library of selectable rows is what a table is for. ⚠️ The viewer arrived after
this was written and makes the case louder rather than differently — a second
reader of the registry is a second thing a `maps` table would serve.

What follows is the argument as it stood at one map. None of it has been
refuted, and the one real risk it named — editing a map changing what old
matches were played on — was closed by making map ids immutable. What has *not* happened is the other half — maps that stop
being written by developers, which is what user-authored maps, random selection
or filtering would bring.

The tempting argument against — *content lives in code, like `terrain.ts` and
`unitTypes.ts`* — does not actually hold. Those are **fixed global lookups**:
one table each, always loaded, never chosen between. Maps are a **collection
you select from**, which is a different shape and a more database-shaped one.
What holds instead is narrower:

- The character-grid format exists to be read in a diff. A `TEXT` column keeps
  the format and throws away the reason for it.
- There is no seeding machinery. Migrations are schema-only and nothing inserts
  data at boot, so a table means inventing an idempotent seed step.
- The foreign key would protect metadata that cannot corrupt anything —
  `initial_state` holds the instantiated grid, so a match replays correctly
  whatever `map_id` points at. A dangling id is a wrong label, not a broken
  match.

## Out of scope for v1

- **A `playerEliminated` event.** With two players it states the same fact as
  `gameEnded` twice. It becomes the right shape with three, and is purely
  additive when it comes, because nothing in `GameState` marks elimination for
  an absent event to desync.
- **Transports.** `Unit.position` becomes `{ kind: 'onBoard'; coordinate } | { kind: 'carried'; by: string }` so the invalid state is unrepresentable, with cargo derived by query rather than stored on the transport.
- **Elevation as a rule.** Height stays presentation only: `surfaceAt` lifts a unit onto a mesa and picking finds it there, but no rule reads a height and no tile carries one. Declined for four reasons, in the order they bite. **Terrain already says it** — hills are stout cover and dear to reach, which is "high ground is worth holding and dear to reach" under another name, so a height *defence* bonus would tune one dial twice. **Two original mechanics already interact** — charge and facing both needed play to move three things before they sat right, and a third interacting axis multiplies that. **The camera caps it** — at 38.6° a surface at height `h` draws `1.25h` tiles up-screen, and a spike showed tile identity collapsing by a full tile, so real relief needs a lower, rotating camera. And **it changes the pace**: "can I get up there" becomes a question on every move, which is Final Fantasy Tactics' game rather than Advance Wars'.

  ⚠️ Two findings worth keeping if it is ever reopened. `entryCost` takes a *destination*; height would make it take a **step**, which is a real signature change but a contained one — `exploreMovement` and `validatePath` are its only callers, and invariant 10 is what guarantees that. And if height ever did enter combat, the door is an **attack** bonus for striking downhill rather than a defence bonus for standing high, because terrain does not express the former and already expresses the latter.
- **Manual routing.** Dragging out a deliberately non-optimal path. Unblocked by the protocol carrying a path and the server validating it — purely a matter of building the UI for it. ⚠️ The substrate now exists and did not before: a route is **pinned, re-pinnable, and drawn as an arrow**, so waypoints have something to hang off rather than needing the whole idea built at once.
- **A blocky / voxel art style.** Tried on a branch with [KayKit's Block Bits](https://kaylousberg.itch.io/block-bits) and rejected — recorded so it is not re-litigated from the screenshots alone. It works: every terrain maps onto a block, and **the autotiler turns out not to be load-bearing** — a cube has no shoreline, so a one-tile river bends through a right angle with no mask arithmetic at all, and `composeTerrain` drops from ~250 lines to ~60. What killed it is the camera. The style lives on block *sides*, a near-top-down board shows only tops, and stepping by whole blocks to expose the sides is the elevation problem above. So it is a real option, but only alongside a different camera — not a swap.

## The epics

**Order is in the table at the top of this file**, not here. Each section below
is self-contained; read the one you are about to work on.

⚠️ **Platform mechanics are not written down here.** They are per-platform,
dated, and change — see the *Publishing Pipeline* doc in Drive, which
carries the gate, exclusivity, identity and size rules for each portal with the
date each was verified. Anything copied into this file is a second copy to keep
in step, and the last audit of this document was mostly about exactly that.

### UI and interaction

**The chrome, and how it feels to give an order.** Split out of *Presentation*:
models and audio are a different job from the surface a player actually
operates. It runs after it, so the chrome is designed around the look it sits
on. ⚠️ **Named, not
numbered**, per the rule at the top of this file.

⬜ **The scope is half-known.** What follows is the part already identified; the
interaction half is meant to be filled from **playing**, not from reasoning at a
terminal, and it is deliberately short until then.

- **A UI pass.** The board's chrome reads `--board-*` tokens, so this is editing
  a palette rather than hunting literals. ⚠️ The *page's* own tokens exist and
  are used by nothing — a second set that never got adopted, which is either a
  job to finish or a thing to delete.
- **A roster of cards per player**, one card a unit, marking which can still
  act. It is the fuller form of a unit standing once it has acted, which stands in until then,
  and where the board's charge counter would move to. Which cards are *yours*
  depends on who is looking — `server.you` — and in hot-seat that is both
  sides.
- **A finished game in the list says who won by name.** A row reads *player-1
  won*, the raw id, where it could say *You won*, or *Ada won*: the list has
  no roster and no seats to resolve the id against, so the server would say it
  on each row — whether the guest won, beside `yourTurn`, or the winner's name
  beside `opponent`.

⚠️ **Interaction is where play is the authority, the same as tuning.** The
usability work already done was found by reading the code; what is left will be
found by someone using it, which is why it runs in front of everything that
adds surface.

### 11 — Presentation

**Gunpowder Tactics, on itch, as a colonial-era war tactics game**, built around
Beelim Solutions' American Revolution figures — low-poly people, not fantasy —
and a PS1 look. ✅ **Part 1, the figures, is built** — posed and animated, the
board's pieces and the cutaway's ensembles, all in the architecture doc — and
two parts remain, in order. ⚠️ **UI left this epic** — see *UI and
interaction*, which runs after it, so the chrome is designed for the look it
sits on.

#### Part 2 — The PS1 look

- **Rendering in the style**: small textures sampled without smoothing, vertices
  snapped to a coarse grid, a low internal resolution scaled up, and dithering.
  ⚠️ **Affine texture warping needs a perspective camera** — it is the one
  signature an orthographic camera makes a no-op, since `w` is 1 everywhere —
  so it is the cutaway's alone, if the cutaway takes one.
  ⚠️ **The board stays orthographic and unfogged.** It is looked down on, so
  there is no depth for fog to show; tried, it reads as a vignette, and the
  board in perspective reads worse than flat.
- **Lighting and materials** for the style. ⚠️ **Shadows are a style question**:
  the PS1 had vertex lighting and blob shadows, no shadow maps. The figures
  are unlit for now, their textures as painted, and whether they take light
  again depends on this.
- **Effects**: musket smoke and flash from the muzzle bone the figures already
  carry, shot and cannonballs in flight, hit puffs and dust.
- **The land beyond the board**: the frame furnished from the scenery packs —
  woods, fields, camps — and ending at the slab's edge, as a diorama does. No
  skybox: the board's camera looks down too steeply to see much sky.
- **Cutaway dioramas** that show the tile being fought on — a wood, a river
  bank, a village — built from the scenery packs. They replace the stretched
  tile each side stands on now, where a hill is a raised slab of rock and a
  bridge a deck as long as the stage; a village has its houses already, in a row
  behind the line, on bare paving.
- **Depth of field, perhaps**: a light tilt-shift on the cutaway diorama. The
  PS1 had none and it costs passes, so it is decided when the rest is in.
- **A performance pass**: texture sizes, draw calls, and memory on a phone,
  against the portals' download limits.

#### Part 3 — Sound and finishing touches

- **Sound.** Nothing in the codebase makes any and there is no audio path at
  all — a new capability rather than a pass over an existing one: volleys,
  cannon, hooves, drums, music and the interface's own. ⚠️ A browser plays
  nothing until the player has interacted, and a mute belongs with it.
- **Finishing touches** — a title, a victory flourish, and whatever playing the
  first two parts shows is missing.

### Security and infrastructure hardening

**What a public server needs after its first deploy.** The hosted build has
ownership, CORS and caps; what follows is what it leaves for later,
collected here so it is picked up rather than rediscovered. ⚠️ **Named, not
numbered**, per the rule at the top of this file.

- ⬜ **Per-IP limits beyond the first deploy's.** The limits are held in memory
  on the one machine, behind an interface made to be replaced, keyed on `Fly-Client-IP` — never
  the leftmost `X-Forwarded-For`, which the client writes. More machines make
  those per-machine, and a rule at an edge proxy in front of Fly is what holds
  one limit across all of them without spending the database's quota.
- ⬜ **Presence beyond one machine.** It is in memory too, and a second machine
  would answer from its own half of the heartbeats — so that is when it moves
  to a shared store, Upstash Redis, which `fly redis create` provisions, behind
  the interface it already has.
- ⬜ **Deleting old matches, when storage asks for it.** They are kept as tuning
  data for now; a scheduled job reaching Turso directly would clear them, with
  no endpoint to expose. ⚠️ Each match's log deleted explicitly with it —
  foreign-key enforcement on Turso is not something to rely on.
- ⬜ **Dice from a CSPRNG** once a match has stakes — ranked play, a
  leaderboard, anything worth cheating for. `rollLuck` draws from `Math.random`,
  whose future follows from a little internal state, and a player sees outcomes
  that say something about the rolls behind them: a damage number, whether a
  charge broke. Recovering the state from those is hard — they are blurred by
  the scaling luck goes through, and every match draws from the same stream — so
  for casual play it barely matters. ⚠️ **One line when it does**: `rollLuck`
  already takes its source as a parameter, so only the default changes, to
  `crypto.getRandomValues`, and the simulator keeps its seeded one.
- ⬜ **Static serving contained by real path**, not by string: a symlink in
  `dist` would be followed out of it. And a missing `/assets/*` file answers
  404 rather than a redirect to the start.
- ⬜ **CSP violation reports**, which a meta tag cannot send, and `bun audit`
  failing CI on any advisory that reaches the runtime image.
- ⬜ **Operations**: logs and an alert on the 5xx rate, a restore from the
  database's point-in-time backups actually tried once, and a rotation path for
  every secret.
- ⬜ **A preview environment for `main`**: every push to the working branch
  deployed somewhere of its own, to play before fast-forwarding `production`.
  Its own Fly app and its own database, so nothing it does touches what players
  have.
- ⬜ **An embedded read replica only if reads ever matter.** A poll reads a few
  rows, and the read quota is far larger than the write quota, which a replica
  does nothing for — every write still goes to the primary. And it costs a
  volume or a resync at every cold start, with reads that can trail a write
  just made. The Turso dashboard says when, if ever.
- ⬜ **Over quota, the database refuses everything** — queries fail as `BLOCKED`
  until the month resets, so abuse that gets past the limits takes the game
  offline. An alert well before the quota, from Turso's usage figures, is the
  warning that does not exist yet.
- ⬜ **The Fly copy downloads its models again on every visit.** Files outside
  `/assets/` are `no-cache`, and Bun's file responses carry no `ETag` or
  `Last-Modified` to revalidate against — so the models, most of what a visit
  fetches, come in full each time. The itch copy is cached by itch's CDN.
- ⬜ **Pins kept current.** The actions, `flyctl`, butler, Bun and the base image
  are all pinned, which is the point, and nothing updates them: a periodic
  look, or Dependabot for the actions.
- ⬜ **Before the page goes public**: scale-to-zero, which costs a second or two
  on the first call after a quiet spell, against an always-on machine at a few
  dollars a month; and Fly's `bluegreen` strategy, which would start a release
  beside the running machine and take away its few seconds offline.
- ⬜ **The release after the banner's fix is the check on itch.** Build 36
  showed the banner on itch, and its Reload brought it straight back — the
  frame reloading the old build's own address, not the CDN holding an old
  `index.html`. With the page open on a build that has the fix, the banner
  should ask for the page to be reloaded, and reloading it after itch finishes
  processing should clear it.

#### A custom domain, as a one-variable change

A custom domain is wanted soon after the first release, so nothing here may
assume the Fly hostname:

- **The API's address appears in one place**, `API_ORIGIN` in the release
  workflow. The client's API constant and its CSP are both derived from it at
  build time, and nothing else names it.
- **The server never needs to know its own hostname.** CORS answers `*`, there
  are no cookies, and nothing builds an absolute URL to itself. The Fly app
  answers on whatever names it is given.
- **The switch, then**: add the domain to Fly (`fly certs add`, which issues the
  certificate), point DNS at the app, change `API_ORIGIN`, and release. ⚠️
  **HSTS comes with it** — a header the server does not send today, since
  `*.fly.dev` is covered by its own preload and a custom domain is not.
- ⚠️ **The `fly.dev` address keeps answering afterwards**, so tabs and itch
  builds still compiled against it carry on until they reload — the same rule
  as server-before-client, applied to an address. Guest tokens are signed, not
  tied to a host, so they survive the move.

### The itch page

**Everything a stranger meets, and opening it to them.** The page on itch is
where the game is found, read about and played, and it stays Restricted behind
a password until this is done — which is why it is last before the line. It
grew out of *Player feedback*, now one part of it. ⚠️ **Named, not numbered**,
per the rule at the top of this file. ⚠️ **The server's half of going public is
not here**: limits, operations and the machine that answers are *Security and
infrastructure hardening*'s, which runs first — *Before the page goes public*
among them.

- ⬜ **Credits.** Beelim Solutions asks to be credited for the figures and the
  houses, and Kenney's Nature Kit is CC0, its licence already in
  `public/models/terrain`: a line for each on the page, written there rather
  than in the code. ⬜ Whether the libraries the bundle ships — Babylon.js,
  under Apache-2.0, among them — want a notices file beside the build is
  checked at the same time.
- ⬜ **The page itself**: a line that says what the game is and a description
  that says how it is played — hot-seat, or online by code, and alone once
  there is an AI — with a cover image at the 630×500 itch asks for, screenshots
  and a short clip of a battle, a genre and tags, and its status as in
  development.
- ⬜ **How to play**, for someone with nobody beside them to explain: the rules
  that are not Advance Wars' — facing, flanks and the rear, contact, the charge
  and its meter, the general. On the page at the least; where the game's own
  half lives is *UI and interaction*'s to say.
- ⬜ **The embed, settled.** 960×640 with a fullscreen button now. "Mobile
  friendly" stays off until the game has been played on a phone — touch to
  orbit, pan and pick, and the chrome at that width — and is turned on only if
  it holds up.
- ⬜ **What is kept, said plainly**, in a line on the page: a guest's chosen
  name and its matches, kept to tune the game, and no account, cookie or
  tracker. Addresses are counted in memory, for the limits.
- ⬜ **Knowing whether anyone plays**, which is the point of opening it: itch's
  own analytics for views and plays, and the matches table for games actually
  started and finished — a small script over it, rather than a third-party
  tracker the CSP would have to widen for.
- ⬜ **Opening it**: Restricted to Public, the password gone, comments on for
  whoever would rather say something in the open, and a devlog post to say it
  is.

#### Player feedback

**A player says what went wrong without leaving the game, and the developer
hears it** — early access being when there are players to hear from.

- **Our own route, `POST /api/feedback`**, rather than a hosted form. Behind the
  guest token and the per-address limits like every write, so it is no easier
  to spam than a create. ⚠️ **It carries where the player was**, which no hosted
  form can without help: the build, the match and its `seq`, whose turn it was,
  the mode, and the browser — so a report needs no description of its setting.
- **Kept in a table** in the database there already is: a message is a single
  small write, nowhere near a quota.
- **The page stays as it is.** Posting to our own server needs no change to the
  CSP's `connect-src`, there is no third-party script, and the player never
  leaves the frame — which itch's iframe may not even allow.
- **A button on the start screen and in a game**, opening a short form: what
  happened, and optionally how to reach the player.

⬜ **Open: how the developer hears of it.** Researched and tabled:

- **Sending mail straight from the server is out.** Fly's addresses have no
  reverse DNS and offer none, and Gmail requires it of every sender, with SPF or
  DKIM besides — so mail from a Fly machine is refused or filed as spam.
- **The developer's own Gmail, as the relay** — an App Password, sending from
  them to them. Free, no new account, and it arrives. ⚠️ **The price is the
  secret**: an App Password opens the whole mailbox, not only sending, so a leak
  of that Fly secret is a leak of the inbox.
- **Resend**, whose test sender needs no domain and delivers only to the
  account's own address — which is the case here. A key that can only send, on a
  free tier far above tester volume, at the cost of one more account.
- **A Discord webhook**, if feedback is better read in a channel than an inbox.
- **None** — kept in the table and read by a small script, with nothing saying
  when one arrives. Enough while there are a handful of testers.

Rejected: hosted forms opened as a link (Tally, Google Forms) — they leave the
game and know nothing of the match — and form-to-email services posted to from
the page (Formspree, Web3Forms, FormSubmit), which widen the CSP and publish a
key or an address in the bundle.

### 14 — Content: maps, and the numbers

A track, not a queue — it depends on nothing above and it is what moves the
metrics a portal actually gates on. The numbers live in `shared/src/data/`, and
the harnesses that read them are in the architecture doc's *Commands*; this is
the phase that keeps changing them. New units and an army budget are under
*Ideas*.

- **Whatever play says next** — which has more than once turned out to be a
  rule rather than a dial.
- **Maps into a table, and an editor over it.** Settled in *Maps in a table*
  above. The storage half is a migration and a foreign key; the editor is the
  half that makes it worth doing, and it is the first tool in this repo written
  for an author rather than a player. ⚠️ Almost all of it already exists:
  `parseTerrainGrid` reads the rows, `maps.test.ts` already knows what makes a
  board valid — deployable, crossable, one army each way — and `/maps` already
  draws one. An editor is those three joined by a paint tool. ⚠️ **A map is a
  balance surface, not just content**, which is the argument for the editor:
  the fastest way to fix a board is to be able to change it and re-run.
- ⚠️ **New terrain is worse than nothing until a number reads it.** Terrain has
  exactly two mechanical dimensions — `cost`, which movement reads, and
  `defense`, which `computeDamage` reads — so a type differing only in `defense`
  is invisible in play, and one differing only in `cost` mostly duplicates
  `river`. ⚠️ **And `road` and `bridge` count once**: they are mechanically
  identical, differing only in the character that draws them and the model
  that renders them. Sea and structure both pass — sea the one ground nobody
  enters, structure the stoutest cover at a road's price. Revolutionary-war
  terrain is a real want — fields, woodlots, orchards, marsh, and stone walls
  above all — but the first three are a **palette** job touching no rule, and a
  wall is not a tile at all: cover *from one direction* is an **edge** feature
  against a grid that only has cells, and it multiplies with facing.

### 15 — Platforms beyond itch

itch is where the game is already hosted, and is not repeated here; this is the portals
that gate, review, or supply their own accounts. Worth attempting only once
*Presentation* and *Content* have moved playtime and retention — the one portal
publishing a bar publishes a specific one, and the game is judged against it
rather than against a portal-wide average.

- **Per-platform SDK work**, which is mostly identity, room/invite plumbing and
  an ads hook. What each one demands is in the Publishing Pipeline doc.
- **Nobody offers matchmaking**: a game is joined by its code, which is ours
  wherever the game runs, and a queue would be too. What a portal adds here is
  its own room and invite plumbing around a code.
- ✅ **No exclusivity, decided.** One target is web-exclusive and blocks external
  requests by default; a game with its own server cannot take that deal without
  an exemption, and the deal is worth less than the other portals together. The
  order is itch, then CrazyGames, then whoever else fits — and every
  non-exclusive licence checked so far permits exactly that.
- ⚠️ **The genre is against the grain and this is known going in.** The one
  portal publishing numbers says hypercasual and puzzle dominate, with strategy
  landing with older players; a turn-based keyboard-and-mouse game is not what
  these audiences are built around. Online multiplayer doubles long-term
  retention there.

### Accounts and sign-in

**An identity that outlives a browser, for when there is something to keep on
it.** A guest is enough to play, and on itch a guest who loses their browser's
storage simply starts again. Accounts earn their place when a player has more
than games to lose — the armies they build and keep, first. ⚠️ **No passwords,
ever.** ⬜ **Open: how other itch games handle identity**, to research before
this starts. The names players type get filtered then; until then a name is
trimmed and bounded and nothing more.

✅ **`Authorization: Bearer`, no cookie, on every platform** — decided, and
shipped. A cookie cannot survive a portal's iframe reliably, and a header
attached deliberately is never sent automatically, so CSRF is not a category.

- **Providers: itch, Google and Discord.** ⚠️ **itch offers only the implicit
  flow** — the token comes back in the address's fragment — so itch is a small
  handler of ours: read the token, ask `api.itch.io/profile` who it belongs to,
  attach that account.
- ⚠️ **Spike first: can itch's iframe open a popup?** Providers refuse to be
  framed, so signing in happens in a popup, and an iframe needs permission to
  open one. It is unconfirmed for itch, and the sign-in plan stands or falls on
  it. If it cannot, the fallback is signing in on the game's own Fly page and
  carrying the session to the itch copy by a short code — the shape a TV's
  "enter this code" sign-in has.
- ⚠️ **The popup reports back through the server, not the page.** The game asks
  the server for a sign-in request, opens the popup with it, and polls until
  the server says it is signed in. Our page's COOP header — and the providers'
  own — cut a popup off from the game that opened it, so anything that needs
  `window.opener` would fail; polling is what everything here does already.
- **Signing in carries a guest's games onto the account.** Better Auth's
  anonymous plugin makes the signed-in user and hands both to `onLinkAccount`,
  which moves the guest's seats across; on a second device it finds the
  existing account, and that device's guest games join it. The session is
  reissued at sign-in, so a pre-sign-in token never becomes an account's.
- **Display names**: a guest picks one or is given one; a signed-in player starts
  with their provider's.
- ✅ **The token stays in `localStorage`**, readable by every itch game and now
  tied to a person: another game could play as them here, though nothing
  outside this game. Accepted — itch's shared origin is itch's to fix.

✅ **Better Auth**, spiked and a fit: a fetch handler, Drizzle on SQLite, the
providers, a bearer plugin, and an anonymous plugin for guest-to-account. It
owns the people tables — `user`, `session`, `account` — and its users are what
seats point at; accounts can grow from there, to the armies a player keeps.
⚠️ **Today's `users` is already that shape**, a guest's id and name, so a
sign-in adds columns beside them and nothing moves off a seat.
⚠️ **Its sessions live in the database, so game requests do not use them.**
Its JWT plugin issues a short-lived token, checked against a public key the
server holds in memory — no read, as with today's token — and the client
trades its session for a fresh one when it runs out, which costs one read
every few minutes rather than one a poll. Its cookie cache does not apply,
with no cookies; its secondary storage would mean running Redis, or signing
everyone out whenever the machine sleeps. ⚠️ **This replaces today's signed
guest token and its renewal.**

⬜ **What the itch copy offers**, *open*: accounts will grow features the itch
copy may not have, so whether itch offers sign-in at all — or keeps to guests,
with sign-in and the account's features on the game's own site — decides how
much the popup spike matters, and whether the two copies stay one build that
hides what itch lacks or become two. One build is what the hosted build ships,
and is worth keeping.

**Portals that bring their own accounts**, such as CrazyGames' signed token,
fit the same seam: one endpoint per platform trades its credential for ours at
the door, after which nothing branches on platform again — see *Platforms
beyond itch*.

### An AI opponent

**One person, on their own, against a side the game plays.** Hot-seat needs two
people at one device and a remote game two at once; a visitor to a portal
usually has neither, so without this the early-access page is a game most of
them cannot play.

**What exists is a temperature check, not an opponent.** The simulator's bot,
in `packages/server/scripts/simulate.ts`, scores every legal action with the
rulebook's own forecasts — `resolveBattle`, `victor`, `exploreMovement` — and
plays the best. The architecture doc lists what it never does: it never stands
a unit anywhere to block, never chooses ground for its cover, and steers clear
of counters by pricing the riposte in. It is where this starts, and what it is
measured against.

What it needs:

- **A seat the server plays.** A match records which seats are people and which
  is the AI, and on the AI's turn the server plays it. ⚠️ **Its commands go
  through `validateCommand` like anyone's**, and its events into the log like
  anyone's, so replay and the clients see nothing new. ⚠️ **It is a seat with
  the AI as its occupant**, in the seats a match already has, under the actor
  rule that lets anyone act. The New Game menu already shows it, disabled.
- **The policy in `shared/`**, beside the forecasts it reads: pure, and the same
  game for the same seed, so it is tested the way the rulebook is, and the
  simulator and the opponent are one bot rather than two that drift. The server
  supplies its randomness, as it does the dice's.
- **Better than the greedy bot where a player would see it**: holding a line,
  blocking with contact, standing in cover, keeping the general out of reach,
  and charging when a charge is ready. ⚠️ **Fun over strength** — an opponent
  that always finds the best move is not what a first-time player wants.
- **Difficulty**, at least two levels, from how far it looks ahead and how often
  it settles for less than the best.
- **The simulator plays it**, so a change to the opponent is measured the way a
  change to the numbers is.

**Open:**

1. ⬜ **Where the thinking runs, and when.** The server holds nothing between
   requests, so the AI's turn is played inside one — most simply the request
   that ends the person's turn, answering once the AI has moved, with the
   client animating the result as it would an opponent's. How long one turn may
   take on one shared CPU decides whether that holds. The alternative is the
   client thinking and the server only checking — free compute, but then a
   person's browser commands the AI's seat, and the matches stop being honest
   tuning data.
2. ⬜ **How deep it looks.** Every unit acts once a turn, so a turn is a long
   sequence of choices and the tree is wide; greedy with better heuristics, a
   shallow search over each unit's options, and a search over whole turns are
   very different amounts of work.
3. ⬜ **Whether difficulty belongs to a match or to a player.**

## Ideas

Wanted, not scheduled. An idea that is picked up moves into an epic, or becomes
one, and leaves this list.

- **Commanders.** Global bonuses for a side, as Advance Wars' commanders give.
  Both sides field the same general for now; a commander chosen per player can
  carry modifiers without the general unit changing.
- **Army composition and custom deployment.** A player chooses what they field
  and where it stands in their zone, rather than taking the default army where
  the map puts it.

  ⚠️ **Composition alone made a ladder, not playstyles**, when the simulator
  swept it: more guns won and more horse lost, on every board. The bot never
  stands a unit anywhere to block, though — contact lets one stop an enemy that
  moves beside it — so whether screening makes horse worth more is for play.
  ⚠️ **Where an army stands moves the opener's edge a long way**: two armies
  directly across from each other give whoever strikes first a full line.

  **An army budget** is the shape composition would take: every unit type gets
  a cost, and a player spends a fixed budget on what they field. ⚠️
  **Warhammer's answer rather than Advance Wars'** — points spent *before* the
  match, not income earned during it — which is the far cheaper half: no bases,
  no capture economy, no production queue, and nothing new during play. ⚠️ **It
  is the lever Advance Wars uses on indirect fire and this game does not
  have.** AW prices its 3–5 range weapon at fifteen infantry; here guns come
  free, in every army. Cost is what makes fielding a second gun a decision
  instead of a default.

  ✅ **The mechanism is built**: per-player armies and the deployment zone, and
  a simulator that takes an army a side, which is what pricing needs. What is
  left is a cost column beside the catalog, a budget constant to tune like any
  other dial, an army builder — UI, so *UI and interaction*'s — and validation
  that answers rather than throws: `createMatchState` and `parseArmyGrid` throw
  on a bad army, right for a server constant and a 500 for a client-supplied
  one. It becomes match data, so it lands with the ruleset-versioning question
  rather than before it. ⚠️ **A larger army is what would justify a wider
  board**, never a deeper one: the boards' depth is set by how long the armies
  take to meet, which does not change with what they field.
- **Choosing colours, and armies before the game.** A seat's colour is on its
  row, so a chooser is a writer rather than a migration. An army chosen before
  the game means building the state when the game starts rather than at
  creation, and a waiting game then has seats and no state — a schema change;
  `initial_state` already records what each seat fielded. More than two
  players needs a map whose `zoneStarts` is a list of seats, each with its
  edge, rather than `[near, far]`.
- **A queue, or a public list of open games.** Both read the waiting state a
  code does. With a few testers a queue mostly finds nobody, and a code is how
  testers meet.
- **Turn notifications** — being told a game is waiting on you while away from
  the page. It needs somewhere to send one, which is an account's or a
  portal's.
- **Dragoons.** Horse with carbines. The `melee` flag makes room for them.
- **Props for the gun's three unarmed crew** in the cutaway — a ball, a
  handspike, a match.
- **Better animation than scripted**: an animator, or a library of motion such
  as Mixamo's — which has musket-shaped rifle sets and no horses, and needs the
  musket cut out of the soldier's mesh first, since it is skinned to his hand.
- **Tuning from real games.** Matches are kept, and each one's log holds every
  command, event and roll, so a script over them can say what the simulator
  cannot: how people actually play each board, which mechanics they reach for,
  and where games are decided.
- **More unit types.** The catalog is built for this: `Record<UnitTypeId, …>`
  means adding one is a compile error in every table that needs an entry, and
  `maps.test.ts` already checks a new movement type can cross every board. The
  unit catalog's flags are required too, so a new unit has to say whether it is
  slow, fights hand to hand and charges.
- **Settlements of more than one kind.** A structure is one rule — the
  stoutest cover, at a road's price — and could take several looks without
  another: a lone tile a farmstead, two or three a village, more a town, one
  beside a river a mill, worked out from the map the way roads and rivers
  already join. Only true landmarks would need marking — a meeting house, a
  courthouse, a fortified house like Germantown's Chew House. The packs have no
  church, barn, mill or earthworks. A fort may want stronger cover of its own.
  ⚠️ **Nothing fights over them yet.** Advance Wars' cities matter because they
  are captured for income and heal what stands on them, and this game chose a
  budget over a capture economy, so a settlement is cover until a rule reads
  it — healing whoever holds one, say, or points for holding them at the end.
