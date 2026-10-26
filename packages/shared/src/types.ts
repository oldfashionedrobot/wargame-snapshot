import type { TileType } from './data/terrain';
import type { UnitTypeId } from './data/unitTypes';

export interface Coordinate {
  col: number;
  row: number;
}

export type Facing = 'north' | 'east' | 'south' | 'west';

export type PlayerId = string;

export type PlayerColor = 'blue' | 'red';

export interface Player {
  id: PlayerId;
  name: string;
  color: PlayerColor;
}

export interface Unit {
  id: string;
  position: Coordinate;
  facing: Facing;
  /**
   * What this unit *is*. Everything that never changes during a match --
   * movement range, and the combat stats to come -- lives on the catalog entry
   * this names, not on the instance. See data/unitTypes.
   *
   * ⚠️ `health` below is the counterexample and the reason this sentence is
   * worded carefully: it is the one combat number that changes every time
   * something hits, so it is state and belongs here. `MAX_HEALTH` is the part
   * that never changes, and that is on the catalog side.
   */
  unitTypeId: UnitTypeId;
  owner: PlayerId;
  /**
   * Current strength, from `MAX_HEALTH` down. Also the damage scale: an
   * attacker deals in proportion to what is left of it, so a wounded unit hits
   * softer without any rule saying so.
   *
   * ⚠️ Events carry the **resulting** value, never the damage dealt -- invariant
   * 9, so applying one twice is a no-op.
   */
  health: number;
  /**
   * Points toward a charge: one for every attack this unit makes, up to its
   * type's `attacksToCharge`, and all of them spent by a charge. Answering an
   * attack fills nothing. Always 0 on a unit that cannot charge.
   *
   * ⚠️ Absolute in the event that changes it, like `health`.
   */
  chargeMeter: number;
  hasActed: boolean;
}

export interface GameState {
  grid: TileType[][];
  units: Unit[];
  players: Player[];
  currentTurn: PlayerId;
  /**
   * Who won, or `null` while the game is still being played.
   *
   * ⚠️ **Additive: `currentTurn` is never cleared beside it.** `getCurrentPlayer`
   * throws when `currentTurn` names nobody and the client's turn label calls it
   * every render, so a terminal state that blanked it would crash the board
   * instead of showing a result. Readers check this first and fall through.
   *
   * ⚠️ **Nullable here and not on the event.** `null` is a real state -- still
   * playing -- whereas `gameEnded` exists only because somebody won. Different
   * nullability for different reasons; neither is the other one unfinished.
   */
  winner: PlayerId | null;
}

// --- Commands: what a client asks for -------------------------------------
// Intent only. No actor, no dice. A command can be rejected. The client can
// construct nothing else, which is what makes a client-supplied `actor`
// unrepresentable rather than merely discouraged.

export interface MoveCommand {
  type: 'move';
  unitId: string;
  path: Coordinate[];
  /**
   * Which way the unit ends up looking. Chosen, not derived: the direction of
   * travel is only the client's suggested default, and a unit may finish a
   * move facing somewhere it did not come from.
   */
  facing: Facing;
  /**
   * Who to attack once the move lands, by id. Absent is a plain move.
   *
   * ⚠️ **Optional, and that is what keeps this additive.** A client that never
   * sends one keeps working, `parseCommand` keeps its existing branch, and no
   * stored row changes meaning -- which is why this is not the rename to
   * `UnitActionCommand` the doc proposed for years.
   *
   * ⚠️ **An id rather than a coordinate.** The events name units by id, so this
   * matches them, and a tile could name a different unit than the player meant.
   * Safe because turns are exclusive: nothing moves between the click and the
   * command being validated.
   */
  targetUnitId?: string;
  /**
   * How the attack is made. Absent means `attack`, which is what keeps this
   * additive: a client that never sends one keeps working and no stored row
   * changes meaning.
   *
   * ⚠️ **Only meaningful beside a `targetUnitId`.** A kind with nothing to
   * attack is refused rather than ignored -- silently dropping it would make a
   * malformed command look like a plain move.
   *
   * ⚠️ **It decides the resolution, not a branch inside one.** An attack
   * produces damage and a possible counter; a charge produces death and
   * displacement or a repel, and never consults the counter rule at all. Two
   * self-contained resolvers, dispatched once on this.
   */
  attackKind?: AttackKind;
}

/**
 * ⚠️ Named rather than inlined, because two things key off it: the command, and
 * `battleResolved.kind`, which the cutaway reads to name the battle.
 */
export type AttackKind = 'attack' | 'charge';

export interface EndTurnCommand {
  type: 'endTurn';
}

/** Giving up -- see `resolveSurrender`. ⚠️ The one command given off-turn. */
export interface SurrenderCommand {
  type: 'surrender';
}

export type Command = MoveCommand | EndTurnCommand | SurrenderCommand;

// --- Actions ---------------------------------------------------------------
// A Command that the authority has accepted. Lives in action.ts, because the
// brand that makes it unforgeable has to be declared where the only
// constructor can see it.

// --- Events: what the server decided happened ------------------------------
// Facts, already resolved. Broadcast to clients, which animate them and never
// resolve anything themselves.

export interface UnitMovedEvent {
  type: 'unitMoved';
  unitId: string;
  path: Coordinate[];
  /** Absolute, like every event payload -- applying it twice is a no-op. */
  facing: Facing;
}

export interface TurnEndedEvent {
  type: 'turnEnded';
  nextPlayer: PlayerId;
}

/**
 * Units that began their turn beside their own general, and the health each
 * now has.
 *
 * ⚠️ **Nobody ordered it, and it is still a fact.** It follows a `turnEnded`,
 * as a consequence of the turn passing, which an action already resolves -- so
 * the server works it out and the log states it, absolute like every event,
 * rather than `applyEvents` re-deriving it from the rules and replaying old
 * logs under new ones. Emitted only when someone heals.
 */
export interface UnitsHealedEvent {
  type: 'unitsHealed';
  units: { unitId: string; health: number }[];
}

/** One side of a battle, and what it has left afterwards. */
export interface BattleParticipant {
  unitId: string;
  /** Resulting, never damage dealt -- invariant 9. Zero means it leaves the board. */
  health: number;
}

/**
 * The attacking side, which also says what its charge meter became.
 *
 * ⚠️ **Only the attacker carries one**, because only attacking changes a meter
 * -- answering fills nothing. Absolute, like `health`, so the fold stays exact.
 */
export interface BattleAttacker extends BattleParticipant {
  chargeMeter: number;
}

/**
 * One exchange, resolved. **Not one event per effect.**
 *
 * ⚠️ Split events when the parts are independently meaningful; keep them
 * together when they are one fact. A charge's displacement is a separate
 * `unitMoved`, because a move is a fact on its own. But a counter-attack exists
 * *only because* the attack happened -- it is half of one fact, and splitting it
 * would leave the client inferring which damage belongs to which exchange from
 * position in a batch, which a multi-action catch-up breaks.
 *
 * Invariant 9 holds: both healths are absolute, applying it twice is a no-op,
 * and it makes sense against the state immediately before it. The invariant
 * forbids **deltas** and **interdependence**, not cohesion.
 *
 * ⚠️ There is no `unitDied` and no `died` flag: `health: 0` is the marker, said
 * once, and a flag beside the number could disagree with it.
 */
export interface BattleResolvedEvent {
  type: 'battleResolved';
  /**
   * ⚠️ Carried because the client never sees the `Action`. An attack and a
   * charge end in the same arithmetic and look nothing alike, and the kind
   * lives only in the command.
   *
   * ⚠️ **The same type the command uses**, deliberately, so one concept has one
   * vocabulary: the command, the event and the panel all say `attack` or
   * `charge`. One word, one type, three readers.
   */
  kind: AttackKind;
  attacker: BattleAttacker;
  defender: BattleParticipant;
  /**
   * The defender hit back -- a counter, or a charge repelled.
   *
   * ⚠️ **A decision, not a duplicate.** It appears nowhere else, and
   * reconstructing it means re-running the counter predicate against a rebuilt
   * state. Three reasons that is worth a boolean: the log outlives the rules (a
   * later change would make a replay describe an old match with new rules); a
   * client deriving it would work from a reconstruction, correct only if its
   * local fold is right; and `resolutions.events` is a consumer the moment this
   * is written, where a row that *says* the defender answered is
   * self-describing.
   *
   * ⚠️ It cannot contradict the healths. `true` with the attacker's health
   * unchanged means they fired and it did nothing, which is a real outcome.
   */
  answered: boolean;
}

/**
 * The game is over, and who won it.
 *
 * ⚠️ **It carries the winner, and a future `playerEliminated` will carry a
 * loser.** With two players "red is eliminated" and "blue won" are one fact
 * stated twice, so emitting both would be redundancy in the log rather than
 * structure. With three they stop being the same fact, and that is when the
 * companion event earns its place -- purely additive, because nothing in
 * `GameState` marks elimination, so no field exists for an absent event to
 * desync and today's logs will replay identically.
 *
 * ⚠️ **Never accompanied by `turnEnded`.** There is nothing to hand to a player
 * who has already lost.
 */
export interface GameEndedEvent {
  type: 'gameEnded';
  winner: PlayerId;
}

export type GameEvent =
  UnitMovedEvent | TurnEndedEvent | UnitsHealedEvent | BattleResolvedEvent | GameEndedEvent;
