import {
  canSelectUnit,
  chargeChance,
  refuseCharge,
  computeDamage,
  facingToward,
  LUCK_MAX,
  refuseAttack,
  resolveBattle,
  tilesInRange,
  coordinatesEqual,
  directionBetween,
  exploreMovement,
  getUnit,
  getUnitAt,
  getUnitType,
  isWithinGrid,
  orthogonalNeighbours,
} from '@wargame/shared';
import type {
  AttackKind,
  Command,
  Coordinate,
  Facing,
  GameState,
  Movement,
  Unit,
} from '@wargame/shared';

// A discriminated union rather than nullable fields: "reachable tiles with no
// selected unit" was representable and meaningless. Phase 9 adds an attack
// target to `destinationChosen` -- a click it already reads, not a new member.
//
// Everything on a selected member is a snapshot taken at selection time --
// `position` exactly as `reachableTiles` always was. That is what lets the
// renderer push be a projection of the selection alone, with no game state in
// hand and no choice about which state to read.
export type SelectionState =
  | { phase: 'idle' }
  | { phase: 'unitSelected'; unitId: string; position: Coordinate; movement: Movement }
  // A route is drawn and nothing has moved. The unit still stands on `path[0]`,
  // the range is still lit, and a click on any tile in it re-pins -- so this is
  // a plan in the fullest sense, discarded by a click on the dark.
  //
  // ⚠️ The *second* click on this destination is what commits it to the walk.
  // That exists so the route is state rather than a hover reaction: the
  // renderer used to draw it from `POINTERMOVE` and React never heard, which
  // meant a touchscreen never saw a route at all.
  | { phase: 'routePinned'; unitId: string; path: Coordinate[]; movement: Movement }
  // The unit has walked and is choosing what to do. Still nothing sent: a click
  // on the dark discards it without the server ever hearing about it.
  //
  // ⚠️ **One phase, and `step` says which question is being asked.** These used
  // to be two phases -- this one and `targetChosen` -- carrying identical data
  // apart from the target, which made the menu's steps siblings in two different
  // type constructs. They are the same *selection*: same unit, same walked path.
  // What differs is the question, which is a sub-mode.
  | {
      phase: 'destinationChosen';
      unitId: string;
      path: Coordinate[];
      movement: Movement;
      step: MenuStep;
    }
  // A unit that cannot act, looked at: the band it could fire into from where it
  // stands, or the tiles it could reach. Nothing pinned, nothing to commit.
  //
  // ⚠️ **The tiles, not the movement search.** A member carrying `movement`
  // would pass straight through `handleTileClick`'s pinning path, and a second
  // click on an enemy would pin a route *for the enemy*.
  | {
      phase: 'inspecting';
      unitId: string;
      position: Coordinate;
      view: InspectView;
      tiles: Coordinate[];
    };

/** Which of an inspected unit's ranges is lit. */
export type InspectView = 'attack' | 'movement';

/**
 * Which question the menu is asking, and therefore what a tile click means.
 *
 * ⚠️ **The intent is chosen before the tiles light, and that is the whole
 * design.** Reading intent *out of* a click costs quadratically: every action a
 * tile could mean is another reading to order against all the others, so n
 * actions is n(n-1)/2 orderings. That failed at n = 2 -- an adjacent enemy is
 * also a facing choice, whichever question ran first won, and the fix was to
 * force the order inside one reader. Asking first makes a new action one member
 * here and one tile set, colliding with nothing.
 *
 * ⚠️ **Each mode carries the tiles it lights.** They used to be snapshotted
 * together on arrival, which computed sets nobody would look at; now each is
 * built when its mode is entered, from state fresh at that moment. Exactly one
 * mode is live, so exactly one set is lit -- which is what lets the renderer
 * take a single overlay rather than four independent ones that merely happen
 * not to overlap.
 */
export type MenuStep =
  // The panel is up and nothing is lit: the buttons are the only affordance.
  | { kind: 'choosing' }
  // ⚠️ `target` is nullable rather than a fourth kind. `unitSelected` and
  // `routePinned` are separate *phases* because they differ in more than the
  // path; attacking with and without a target differ in exactly one field, so a
  // nullable one is the honest encoding. Pinning a target and confirming it is
  // the same gesture a route uses -- first click pins and shows the forecast,
  // second commits, another lit enemy re-pins.
  | { kind: 'attacking'; tiles: Coordinate[]; target: Unit | null }
  // ⚠️ Identical in shape to `attacking`, and that is the point: a charge picks a
  // target with the same pin-then-confirm gesture, so it needs no interaction
  // of its own. What differs is which tiles light and what the command says.
  | { kind: 'charging'; tiles: Coordinate[]; target: Unit | null }
  // The four beside the unit, and its own tile for keeping the facing it has.
  | { kind: 'holding'; tiles: Coordinate[] };

export type RoutePinned = Extract<SelectionState, { phase: 'routePinned' }>;
export type DestinationChosen = Extract<SelectionState, { phase: 'destinationChosen' }>;

/**
 * Every phase that carries a path -- an uncommitted plan, in other words,
 * something a board change has to discard.
 *
 * ⚠️ **The type asks the *shape*, not a list.** `Pinned` used to be a hand-written
 * `|` of three phase names sitting beside `isPlan`'s `||` of the same three --
 * two independent statements of one rule, which is what `isPlan`'s own comment
 * already claimed it had fixed and had not. Carrying a path is the actual
 * property, so `Extract` reads it off the union and a new phase with a path
 * joins automatically.
 *
 * ⚠️ The array exists only because a *type* cannot be asked at runtime, and it is
 * pinned to the type from both directions -- see the assertion below.
 *
 * ⚠️ The cast is unavoidable and harmless: `includes` on a `readonly [...]` of
 * literals will not accept an arbitrary `string`, and widening it here is what
 * lets the predicate take any `SelectionState`. The `satisfies` below is what
 * keeps the names honest.
 */
export type Pinned = Extract<SelectionState, { path: Coordinate[] }>;

const PINNED_PHASES = [
  'routePinned',
  'destinationChosen',
] as const satisfies readonly Pinned['phase'][];

/**
 * ⚠️ **The other half of the guard, and the half `satisfies` cannot give.**
 * `satisfies` checks every name in the array *is* a phase; it says nothing about
 * names left out, so deleting one would leave the type and the predicate
 * consistently wrong and still compile. This fails the build if any phase
 * carrying a path is missing from the array -- the same `never` trick
 * `applyEvents` uses on its event union, pointed at a list instead of a switch.
 */
type NoPinnedPhaseForgotten =
  Exclude<Pinned['phase'], (typeof PINNED_PHASES)[number]> extends never ? true : never;
const allPinnedPhasesListed: NoPinnedPhaseForgotten = true;
void allPinnedPhasesListed;

/**
 * Where a pinned unit is standing, really or in preview -- which is also the
 * tile a second click has to land on to commit the route, and the tile the
 * facing choices are drawn around.
 *
 * ⚠️ **One function, where there were three.** `pinnedDestination` and
 * `facingChoiceOrigin` were this body under two other names, distinguished only
 * by what the caller meant to do next. That is a comment's job, not a
 * function's: three names for one line is three things to keep in step, and the
 * argument type already says which selections may be asked.
 */
export function destinationOf(selection: Pinned): Coordinate {
  return selection.path[selection.path.length - 1];
}

export function isPlan(selection: SelectionState): selection is Pinned {
  return (PINNED_PHASES as readonly string[]).includes(selection.phase);
}

type AttackStep = Extract<MenuStep, { kind: 'attacking' | 'charging' }>;

/**
 * An attack mode is up: its tiles are lit, and a click on a lit enemy pins one.
 *
 * ⚠️ **Covers attacking and charging together**, because everything between picking
 * a mode and committing is identical for both -- the same gesture, the same
 * re-pin, the same second click. Only the command differs, and that is read off
 * `step.kind` at the one place that builds it.
 */
export type Attacking = DestinationChosen & { step: AttackStep };

/**
 * A target is pinned: the preview is up, and a second click on it commits.
 *
 * ⚠️ **`TargetPinned` is a subset of `Attacking`**, and the names are the second
 * pair this has had. They were `Aim` and `Aiming`, which read the wrong way
 * round -- the gerund sounds like the earlier state and was the later one -- and
 * differed by three letters across four symbols, so `isAim` and `isAiming` were
 * a typo apart at every call site. Saying what each *is* costs a few characters
 * and takes the guess out.
 *
 * ⚠️ **`pinned` is the file's own word for it**, deliberately: a route is pinned
 * by a first click and committed by a second, and a target is pinned the same
 * way. One gesture, one verb.
 */
export type TargetPinned = DestinationChosen & { step: AttackStep & { target: Unit } };

/**
 * ⚠️ **Two predicates, so no caller writes the two-level narrowing by hand.**
 * That is what absorbing `targetChosen` costs, and it is paid once here rather
 * than at every `phase === 'destinationChosen' && step.kind === 'attacking' &&
 * step.target !== null` a reader would otherwise spell out.
 */
export function isAttacking(selection: SelectionState): selection is Attacking {
  return (
    selection.phase === 'destinationChosen' &&
    (selection.step.kind === 'attacking' || selection.step.kind === 'charging')
  );
}

export function isTargetPinned(selection: SelectionState): selection is TargetPinned {
  return isAttacking(selection) && selection.step.target !== null;
}

/**
 * Enter one of the menu's modes, lighting the tiles that answer for it.
 *
 * ⚠️ Named for the *transition*, not the gesture. The hook's `chooseAction` is
 * what a button press is called; this is what it does to the state, and keeping
 * them distinct is what stops an import alias standing in for the difference.
 */
export function enterMode(
  state: GameState,
  selection: DestinationChosen,
  kind: ActionKind,
): DestinationChosen {
  // ⚠️ Built here rather than snapshotted on arrival: two of these would never
  // be looked at, and the state a mode is entered from is fresher than the state
  // the walk began in.
  const destination = destinationOf(selection);
  const unit = getUnit(state, selection.unitId);
  if (kind === 'holding') {
    return { ...selection, step: { kind: 'holding', tiles: neighboursOf(state, destination) } };
  }
  const moved = unit ? { ...unit, position: destination } : null;
  const tiles = !moved
    ? []
    : kind === 'charging'
      ? chargeTilesFor(state, moved, selection.path)
      : attackTilesFor(state, moved, destination);
  return { ...selection, step: { kind, tiles, target: null } };
}

/** A mode the action panel can put the selection into. */
export type ActionKind = 'attacking' | 'charging' | 'holding';

/**
 * Which modes this selection could enter, in the order the panel offers them.
 *
 * ⚠️ **One list, so the menu and the skip cannot disagree.** The panel renders
 * from this and the arrival path counts it; asking `canAttack` and `canCharge`
 * separately in each would be the same question spelled twice, and the failure
 * would be a panel offering a row that the skip had already decided did not
 * exist.
 *
 * ⚠️ **Holding is always last and always present.** A unit may always wait, so
 * this is never empty -- which is what makes "only one action" mean *nothing to
 * attack* rather than *nothing at all*.
 */
export function availableActions(state: GameState, selection: DestinationChosen): ActionKind[] {
  return PANEL_ACTIONS.filter(({ when }) => when(state, selection)).map(({ kind }) => kind);
}

/**
 * Every mode the panel knows about, in the order it offers them.
 *
 * ⚠️ **A table rather than three pushes, so a new action cannot be half-added.**
 * The list this replaced named its three by hand: adding a fourth `ActionKind`
 * compiled cleanly and simply never appeared in the panel, which is the worst
 * shape a gap can take -- the type said the action existed and the menu quietly
 * disagreed. `satisfies` pins each entry to a real kind, and the assertion below
 * pins the kinds to the entries.
 *
 * ⚠️ Holding's predicate is a constant `true`, and deliberately not omitted: a
 * unit may always wait, and saying so as an entry keeps "always available" a
 * fact in the table rather than a `push` after the loop. It is what makes the
 * list never empty, which is what lets *one action* mean **nothing to attack**
 * rather than nothing at all.
 *
 * ⚠️ Declared below its only caller and above nothing, which is safe because
 * `canAttack` and `canCharge` are function *declarations* -- hoisted and
 * initialised before any statement here runs.
 */
const PANEL_ACTIONS = [
  { kind: 'attacking', when: canAttack },
  { kind: 'charging', when: canCharge },
  { kind: 'holding', when: () => true },
] as const satisfies readonly {
  kind: ActionKind;
  when: (state: GameState, selection: DestinationChosen) => boolean;
}[];

/**
 * ⚠️ **The half `satisfies` cannot give**, exactly as with `PINNED_PHASES`: it
 * checks every entry names a real kind and says nothing about kinds left out.
 * This fails the build when an `ActionKind` has no row.
 */
type NoActionForgotten =
  Exclude<ActionKind, (typeof PANEL_ACTIONS)[number]['kind']> extends never ? true : never;
const allActionsListed: NoActionForgotten = true;
void allActionsListed;

/**
 * Is there anything this unit could attack from where it stopped?
 *
 * ⚠️ **Asked with `refuseAttack`, the server's own rule**, rather than by
 * counting what stands in `tilesInRange`. The band is *reach* and says nothing
 * about ownership, a minimum range, or a unit targeting itself -- so a panel
 * built on the band would offer Attack for a friend standing two tiles away,
 * and the click would then be refused. One rule, asked twice, cannot disagree
 * with itself.
 *
 * ⚠️ Walks every unit rather than the band. Sixteen units against a band of up
 * to sixty tiles is the cheaper loop, and it needs no grid bounds.
 */
export function canAttack(state: GameState, selection: DestinationChosen): boolean {
  return anyTarget(state, selection, refuseAttack);
}

/**
 * Is there anything this unit could charge from where it stopped?
 *
 * ⚠️ `canAttack`'s twin, and it asks `refuseCharge` for the same reason `canAttack`
 * asks `refuseAttack`: the menu row and the click that follows it must be
 * answered by one rule, or the panel offers what the board then refuses. It
 * covers capability too -- artillery does not charge, so this is false for
 * every target and the row never appears.
 */
export function canCharge(state: GameState, selection: DestinationChosen): boolean {
  return anyTarget(state, selection, refuseCharge);
}

type Refusal = (
  state: GameState,
  attacker: Unit,
  path: Coordinate[],
  targetUnitId: string,
) => string | null;

function anyTarget(state: GameState, selection: DestinationChosen, refuse: Refusal): boolean {
  const from = destinationOf(selection);
  const unit = getUnit(state, selection.unitId);
  if (!unit) return false;
  const moved: Unit = { ...unit, position: from };
  // ⚠️ The selection's whole path, so a row is offered only when the rule that
  // will answer the click would accept it -- including "this gun has moved".
  return state.units.some((target) => refuse(state, moved, selection.path, target.id) === null);
}

/**
 * Which tiles charging mode lights: the units this one could actually charge,
 * asked of `refuseCharge` -- the same question `canCharge` asks, so the row is
 * never offered with nothing lit.
 *
 * ⚠️ **Targets, not reach — the opposite of the attack band, and deliberately.**
 * Red means *in range* because reach is the information an attack is planned
 * against; a charge has no reach to show, being contact-only, so lighting all
 * four neighbours would light tiles that do nothing. Here the lit set *is* the
 * legal set.
 */
function chargeTilesFor(state: GameState, unit: Unit, path: Coordinate[]): Coordinate[] {
  return state.units
    .filter((target) => refuseCharge(state, unit, path, target.id) === null)
    .map((target) => target.position);
}

/** A target is pinned: the forecast opens over it, and nothing is sent yet. */
export function chooseTarget(selection: Attacking, target: Unit): TargetPinned {
  return { ...selection, step: { ...selection.step, target } };
}

/** Back out of whichever mode is up, to the panel. */
export function clearStep(selection: DestinationChosen): DestinationChosen {
  return { ...selection, step: { kind: 'choosing' } };
}

/**
 * Which tiles attacking mode lights, from where the unit ends up.
 *
 * ⚠️ **The whole band, and nothing filtered out of it** -- reach is the
 * information, so red means *in range* rather than *attackable*. It used to
 * exclude the four tiles beside the unit when nothing hostile stood on them,
 * because those tiles were simultaneously facing choices and the colours had to
 * be split somehow. Facing is its own mode now, so the two sets are never lit
 * together and the band needs no holes punched in it.
 */
function attackTilesFor(state: GameState, unit: Unit, from: Coordinate): Coordinate[] {
  const height = state.grid.length;
  const width = state.grid[0]?.length ?? 0;
  return tilesInRange(unit, from, width, height);
}

/**
 * The four orthogonal neighbours of a tile, clipped to the board.
 *
 * ⚠️ **Moved out of the renderer, which used to derive these from a single
 * coordinate.** Which tiles light is a question about the *selection*, not about
 * painting -- the renderer's job is to colour a list. It also made this testable
 * for the first time: the renderer has no unit tests at all, being WebGL, so "a
 * unit on the top row has three choices" was asserted nowhere.
 *
 * Clipping belongs here rather than in a caller, because a facing that points
 * off the board is not a choice worth offering.
 */
function neighboursOf(state: GameState, around: Coordinate): Coordinate[] {
  const height = state.grid.length;
  const width = state.grid[0]?.length ?? 0;
  return orthogonalNeighbours(around).filter((tile) => isWithinGrid(tile, width, height));
}

/**
 * The route is accepted: the unit walks it, and the panel opens on arrival.
 *
 * ⚠️ **Takes no state, because the panel lights nothing.** It used to snapshot
 * the attack band and the facing tiles here, which computed two sets for a
 * player who would look at one. Each mode builds its own when it is entered,
 * from state fresher than the state the walk began in. `showSelection` stays a
 * pure projection either way -- the tiles still live on the selection, just on
 * the step that lights them.
 */
export function confirmRoute(selection: RoutePinned): DestinationChosen {
  return { ...selection, phase: 'destinationChosen', step: { kind: 'choosing' } };
}

export const initialSelectionState: SelectionState = { phase: 'idle' };

/**
 * A unit's whole movement search -- what a selection snapshots, and what an
 * inspection's movement view lights, so the two cannot show different ranges.
 */
function movementOf(state: GameState, unit: Unit): Movement {
  const { movementRange, movementType } = getUnitType(unit.unitTypeId);
  return exploreMovement(state, unit, movementRange, movementType);
}

/**
 * An inspection of a unit that cannot act, built for one view when it is
 * entered, as `enterMode` builds a mode's tiles.
 *
 * ⚠️ **The band where it stands, not Advance Wars' threat range**, deliberately:
 * working out what a move adds to it is the player's job. For a gun, and for a
 * unit that starts in contact, which may move or attack but not both, the two
 * are the same anyway.
 */
function inspect(state: GameState, unit: Unit, view: InspectView): SelectionState {
  return {
    phase: 'inspecting',
    unitId: unit.id,
    position: unit.position,
    view,
    tiles:
      view === 'attack'
        ? attackTilesFor(state, unit, unit.position)
        : movementOf(state, unit).settled,
  };
}

// The one constructor of the selected phase, so the snapshot is taken in one
// place: a selectable unit under the click becomes the selection, any other
// unit is inspected, and an empty tile clears it. ⚠️ **Off this client's turn
// no unit is selectable**: `canSelectUnit` means *belongs to the player to
// move*, who is then the opponent, whose units are not this client's to order.
function trySelect(state: GameState, coordinate: Coordinate, yourTurn: boolean): SelectionState {
  const unit = getUnitAt(state, coordinate);
  if (!unit) return initialSelectionState;
  if (!yourTurn || !canSelectUnit(state, unit)) return inspect(state, unit, 'attack');
  return {
    phase: 'unitSelected',
    unitId: unit.id,
    position: unit.position,
    // The whole search, not just its tiles: `pathTo` builds the path a move
    // command carries, and the path a pinned route draws. ⚠️ The renderer no
    // longer holds this -- it is given tiles to light, not a search to query.
    movement: movementOf(state, unit),
  };
}

/**
 * The new selection a click produces. **Never a command** -- a click here picks
 * a destination, and committing happens from one of the menu's modes. Commands are built from a
 * selection by `moveCommandFor`, which is why the two are separate functions:
 * every command's accompanying selection is a constant the caller already
 * knows, so pairing them in one return value carried no information.
 */
export function handleTileClick(
  state: GameState,
  selection: SelectionState,
  coordinate: Coordinate,
  /** Whether this client holds the seat to move -- `holdsTheTurn`. */
  yourTurn: boolean,
): SelectionState {
  // Once the unit has arrived a click means a direction or a target rather than
  // a tile, and the caller answers it with `holdFacing` and `facingChoiceAt`
  // before ever reaching here. Returning the same object rather than an equal
  // one keeps a stray click from re-rendering.
  //
  // ⚠️ `routePinned` is deliberately *not* excluded: a pinned route is still
  // being chosen, so its clicks are tile clicks and belong here. Only the
  // commit -- a second click on the destination -- is read by the caller first.
  if (selection.phase === 'destinationChosen') return selection;

  // ⚠️ Pinning and re-pinning are the same operation, which is why this reads
  // one unit and one search rather than branching on the phase: `routePinned`
  // carries exactly what `unitSelected` does, and nothing below wants anything
  // else. Moving a pin runs the code that set it.
  // Off this client's turn, a selection left from the turn before is let go.
  if (selection.phase === 'idle' || (!yourTurn && selection.phase !== 'inspecting')) {
    return trySelect(state, coordinate, yourTurn);
  }

  // An inspection cycles on its own unit's tile -- the band, then the reach,
  // then nothing -- read against the position it was taken at. Any other click
  // falls through to `trySelect`, as on an empty board.
  if (selection.phase === 'inspecting') {
    if (!coordinatesEqual(coordinate, selection.position))
      return trySelect(state, coordinate, yourTurn);
    const unit = getUnit(state, selection.unitId);
    if (!unit) return trySelect(state, coordinate, yourTurn);
    return selection.view === 'attack' ? inspect(state, unit, 'movement') : initialSelectionState;
  }

  const selectedUnit = getUnit(state, selection.unitId);

  // The selected unit has vanished from state under us; the click means "try
  // to select".
  if (!selectedUnit) return trySelect(state, coordinate, yourTurn);

  // The unit's own tile is a destination like any other, which is how acting
  // without moving needs no gesture of its own. A single-element path costs 0,
  // and `validatePath` exempts the mover from its own occupancy check.
  if (coordinatesEqual(coordinate, selectedUnit.position)) {
    return {
      phase: 'routePinned',
      unitId: selection.unitId,
      path: [selectedUnit.position],
      movement: selection.movement,
    };
  }

  // `reachable` decides whether this is a destination -- not `pathTo`, which
  // answers for any tile the search settled, friendly-occupied ones included,
  // and those are exactly the tiles nobody may stop on. Only once it *is* a
  // destination does `pathTo` build the route the command carries; the server
  // walks that route rather than deriving one, so it has to be a real one.
  const isInRange = selection.movement.reachable.some((tile) => coordinatesEqual(tile, coordinate));
  const path = isInRange ? selection.movement.pathTo(coordinate) : null;
  if (path) {
    return {
      phase: 'routePinned',
      unitId: selection.unitId,
      path,
      movement: selection.movement,
    };
  }

  // Not a destination: another selectable unit switches the selection to it,
  // and a dead click clears it. trySelect answers both.
  return trySelect(state, coordinate, yourTurn);
}

/**
 * A unit just selected, with the panel already open where it stands when it
 * could attack or charge from there. Anything else comes back unchanged.
 *
 * ⚠️ **The walk-to-its-own-tile gesture, made for the player** -- the unit's
 * own tile pinned, then confirmed -- so the panel it opens is the one that
 * gesture builds, and aiming, Hold and backing out work on it unchanged. Kept
 * only when the panel would offer more than Hold, the arrival skip's own test:
 * with nothing to attack, moving is the only thing to do.
 */
export function openInPlace(state: GameState, selection: SelectionState): SelectionState {
  if (selection.phase !== 'unitSelected') return selection;
  // Only a selected unit gets here, and only the player to move selects one.
  const pinned = handleTileClick(state, selection, selection.position, true);
  if (pinned.phase !== 'routePinned') return selection;
  const opened = confirmRoute(pinned);
  return availableActions(state, opened).length > 1 ? opened : selection;
}

/**
 * Which way this click means, or null if it was not one of the four.
 *
 * The four tiles are drawn around `destinationOf` and clipped to the board by
 * `neighboursOf`. A unit on the top row simply has three choices, and facing
 * off the board would be a strictly worse one anyway.
 *
 * ⚠️ Answers `null` for the destination *itself*, since `directionBetween`
 * wants a step of exactly one tile. That is what lets the caller tell "keep the
 * direction travelled" from "face this way" without ordering the two by hand.
 */
export function facingChoiceAt(
  selection: DestinationChosen,
  coordinate: Coordinate,
): Facing | null {
  return directionBetween(destinationOf(selection), coordinate);
}

/**
 * The facing a click on the destination itself means: the way the unit
 * travelled, which it is already standing in after the preview walk.
 *
 * ⚠️ Takes state, unlike the rest of this module, for one case: a path of one
 * tile is acting *without moving*, and there is no last step to read a
 * direction from. The unit keeps the facing it already had.
 *
 * `null` like `facingChoiceAt`, and for the same reason -- the selected unit
 * can vanish from state under a stale selection, and "no answer" is a reading
 * the caller already refuses to commit.
 */
export function holdFacing(state: GameState, selection: DestinationChosen): Facing | null {
  const previous = selection.path.at(-2);
  const travelled = previous ? directionBetween(previous, destinationOf(selection)) : null;
  return travelled ?? getUnit(state, selection.unitId)?.facing ?? null;
}

/**
 * What a click in **holding** mode means: a facing to commit with, or `null` for
 * a click on the dark, which backs out to the panel.
 *
 * ⚠️ **There is no order to get right any more, and that is the point.** This
 * was one reader answering three questions -- is it a target, is it the
 * destination, is it one of the four -- because an adjacent enemy satisfies two
 * of them and only the call order separated them. Ask the player for the intent
 * first and each mode has exactly one kind of tile, so the collision cannot be
 * expressed rather than merely being avoided.
 */
export function readHoldClick(
  state: GameState,
  selection: DestinationChosen,
  coordinate: Coordinate,
): Facing | null {
  // The destination itself keeps the direction travelled; one of the four
  // beside it overrides that. `facingChoiceAt` answers `null` for the
  // destination, since `directionBetween` wants a step of exactly one tile.
  return coordinatesEqual(coordinate, destinationOf(selection))
    ? holdFacing(state, selection)
    : facingChoiceAt(selection, coordinate);
}

/**
 * What a click in **attacking** mode means: an enemy that may be attacked from here, or
 * `null` for anything else.
 *
 * ⚠️ `refuseAttack` is compared against `null` and never against its text -- the
 * reason belongs to the server and changes without the answer changing.
 */
export function readAimClick(
  state: GameState,
  selection: Attacking,
  coordinate: Coordinate,
): Unit | null {
  const destination = destinationOf(selection);
  const unit = getUnit(state, selection.unitId);
  const target = getUnitAt(state, coordinate);
  if (!unit || !target) return null;
  const from = { ...unit, position: destination };
  const refuse = selection.step.kind === 'charging' ? refuseCharge : refuseAttack;
  return refuse(state, from, selection.path, target.id) === null ? target : null;
}

/**
 * What the panel promises before you commit.
 *
 * ⚠️ **A union, because the two attacks are knowable to different degrees.** An
 * attack's damage is a *range*, since the roll is unknown; a charge's odds are
 * an **exact** figure, because `chargeChance` is a pure function of state with
 * no roll in it. Flattening both into one shape would force the charge to
 * pretend its certainty is an estimate.
 */
export type Forecast =
  | {
      kind: 'attack';
      /** Damage at the worst roll, and at the best. The true outcome is one of them. */
      low: number;
      high: number;
      /** Whether the target can strike back from where you are standing. */
      answered: boolean;
    }
  | {
      kind: 'charge';
      /** ⚠️ Exact, not an estimate -- no roll enters this. */
      chance: number;
    };

/**
 * The numbers on the panel, run through the same formula the server will.
 *
 * ⚠️ **An exact range, not an estimate.** Damage only ever rises with the roll
 * -- luck joins the base, and every step after it multiplies by something
 * positive and floors -- so the zero-roll result is the true floor and the
 * `LUCK_MAX` result the true ceiling. ⚠️ The width is *not* `LUCK_MAX` in
 * general: a weakened attacker or a defender in cover narrows it. The
 * client is told the *shape* of the outcome and never which of the ten it will
 * be -- previewing the formula rather than the dice.
 *
 * ⚠️ **The counter's magnitude is deliberately absent.** It is computed on the
 * defender's post-damage health, so it depends on how the attack roll lands, and
 * with health banded the spread comes from band crossings rather than a clean
 * range. A single figure would be true only at the worst roll.
 *
 * ⚠️ `answered` is read at the **worst** roll, where the defender is likeliest
 * to survive. So it means *they will counter attack unless you kill them*,
 * which is the pessimistic reading and the right default for a warning.
 */
export function attackForecast(state: GameState, selection: TargetPinned): Forecast | null {
  const attacker = getUnit(state, selection.unitId);
  const target = getUnit(state, selection.step.target.id);
  if (!attacker || !target) return null;

  // The attacker as it will be standing when it fires, not where state still
  // has it -- the walk was a preview and nothing has been sent.
  const from = destinationOf(selection);
  const moved: Unit = { ...attacker, position: from };

  if (selection.step.kind === 'charging') {
    return { kind: 'charge', chance: chargeChance(state, moved, target) };
  }

  const low = computeDamage(state, moved, target, 0);
  const high = computeDamage(state, moved, target, LUCK_MAX);
  const { answered } = resolveBattle(state, moved, target, { attack: 0, counter: 0 });
  return { kind: 'attack', low, high, answered };
}

/** Which way the unit ends up looking once it commits from the panel. */
export function facingForTarget(state: GameState, selection: TargetPinned): Facing {
  const from = destinationOf(selection);
  const travelled = holdFacing(state, selection) ?? 'north';
  return facingToward(from, selection.step.target.position, travelled);
}

/**
 * Cancel: back to having the unit selected, standing where it always was.
 *
 * Deliberately not `idle` -- the player picked a destination and changed their
 * mind, so the useful next thing is picking another one, not selecting again.
 */
export function unpinDestination(selection: Pinned): SelectionState {
  return {
    phase: 'unitSelected',
    unitId: selection.unitId,
    position: selection.path[0],
    movement: selection.movement,
  };
}

/** Commit the pinned move, looking the way the player chose. */
export function moveCommandFor(
  selection: DestinationChosen,
  facing: Facing,
  /**
   * The attack, if there is one. ⚠️ **A pair rather than two optional
   * parameters**, because they are only ever meaningful together: a kind with
   * no target is refused by the server, and a target with no kind is an attack.
   * One argument makes the invalid halves unrepresentable at the call site.
   */
  attack?: { targetUnitId: string; attackKind: AttackKind },
): Command {
  const command: Command = {
    type: 'move',
    unitId: selection.unitId,
    path: selection.path,
    facing,
  };
  // Absent rather than undefined: the wire shape is optional, and a key holding
  // undefined is a different thing from a key that is not there.
  if (attack) {
    command.targetUnitId = attack.targetUnitId;
    command.attackKind = attack.attackKind;
  }
  return command;
}
