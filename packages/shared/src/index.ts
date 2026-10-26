// The public surface of the rulebook: what server/ and client/ actually
// consume. Anything used only inside shared/ stays unexported from here --
// commands are validated and resolved through action.ts, and union members
// are reached through their union.

export type {
  AttackKind,
  BattleResolvedEvent,
  Command,
  Coordinate,
  Facing,
  GameEvent,
  GameState,
  Player,
  PlayerColor,
  PlayerId,
  Unit,
} from './types';

// The terrain vocabulary, and the lookup that gives it meaning. `getTerrain`
// is out because the server validates its maps against terrain costs; the
// table itself stays unexported until something needs to iterate it.
export type { TileType } from './data/terrain';
export { getTerrain } from './data/terrain';
// Maps are character grids, and this is the only thing that turns one into a
// board -- the server parses its map definitions with it, and so does the
// test fixture.
export { parseTerrainGrid } from './terrainGrid';
// Armies are character grids too, and this is the only thing that turns one
// into placements. Same split as terrain: the parser is here because what it
// produces is game state, while the armies themselves are the server's.
export { armyWidth, parseArmyGrid } from './armyGrid';

// The unit catalog. `UnitTypeId` is out because an army names the units it
// places, and `MovementType` because the server walks its boards as one; the
// rest of the catalog is read through `getUnitType`, and the ids as a list
// through `UNIT_TYPE_IDS`, which the simulator prints its tables by.
export type { MovementType, UnitTypeId } from './data/unitTypes';
export { getUnitType, MAX_HEALTH, UNIT_TYPE_IDS } from './data/unitTypes';

// Combat: `LUCK_MAX`, `computeDamage` and `resolveBattle` are out because the
// client previews what the server resolves, and the bot weighs it.
// `chargeReady` is out for the board's counter.
export { LUCK_MAX } from './data/combat';
export {
  band,
  BANDS,
  chargeChance,
  chargeReady,
  computeDamage,
  refuseAttack,
  refuseCharge,
  resolveBattle,
  tilesInRange,
} from './combat';
export type { Rolls } from './combat';

export {
  coordinatesEqual,
  directionBetween,
  FACINGS,
  facingToward,
  isWithinGrid,
  orthogonalNeighbours,
  tileDistance,
} from './coordinate';
export {
  defenseAt,
  generalOf,
  getCurrentPlayer,
  getUnit,
  getUnitAt,
  holdsTheTurn,
  isGeneral,
  playerInSeat,
  seatOf,
} from './queries';
export { canSelectUnit } from './legality';
export { isOver, victor } from './victory';
export { exploreMovement } from './movement';
export type { Movement } from './movement';
export type { Action } from './action';
export { resolveAction, validateCommand } from './action';
export { applyEvents } from './applyEvents';

export type {
  ClockReading,
  Clocks,
  CommandResult,
  CreateMatchRequest,
  EndedBy,
  ErrorResponse,
  EventsResponse,
  GameServer,
  GuestResponse,
  JoinMatchRequest,
  MapPreview,
  MapSummary,
  MatchMode,
  MatchSummary,
  MeResponse,
  StateResponse,
  UpdateListener,
} from './protocol';
export { CLOCK_MINUTES, parseCommand } from './protocol';
