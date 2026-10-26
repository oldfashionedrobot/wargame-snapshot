import { coordinatesEqual, orthogonalNeighbours } from './coordinate';
import { getTerrain } from './data/terrain';
import type { TileType } from './data/terrain';
import type { Coordinate, GameState, Player, PlayerId, Unit } from './types';

/** The defence stars of the ground at this tile. */
export function defenseAt(state: GameState, coordinate: Coordinate): number {
  return getTerrain(state.grid[coordinate.row][coordinate.col]).defense;
}

export function getUnit(state: GameState, unitId: string): Unit | undefined {
  return state.units.find((unit) => unit.id === unitId);
}

export function getUnitAt(state: GameState, coordinate: Coordinate): Unit | undefined {
  return state.units.find((unit) => coordinatesEqual(unit.position, coordinate));
}

/**
 * The terrain under a coordinate, or `undefined` off the board -- the same
 * shape `getUnitAt` answers with, so "nothing there" reads the same way for
 * both. The grid is indexed `[row][col]`.
 */
export function getTileAt(state: GameState, coordinate: Coordinate): TileType | undefined {
  return state.grid[coordinate.row]?.[coordinate.col];
}

/**
 * Would `unit` be in contact standing at `coordinate` -- is an enemy on one of
 * the four tiles beside it?
 *
 * ⚠️ **Every unit makes contact, guns included**, and nothing on the catalog
 * says otherwise: being beside the enemy is the whole of the rule, which is
 * what lets it explain itself on the board without a marker.
 *
 * ⚠️ **Asked of a coordinate, not of the unit's position**, because the search
 * asks it of tiles a unit is only considering, and the refusal asks it of the
 * tile a path *started* on.
 */
export function inContact(state: GameState, unit: Unit, coordinate: Coordinate): boolean {
  return orthogonalNeighbours(coordinate).some((tile) => {
    const other = getUnitAt(state, tile);
    return other !== undefined && other.owner !== unit.owner;
  });
}

/**
 * A player's general on the board, or `undefined` -- either it has fallen, or
 * the army never fielded one.
 */
export function generalOf(state: GameState, player: PlayerId): Unit | undefined {
  return state.units.find((unit) => unit.owner === player && isGeneral(unit));
}

/**
 * Is this unit a general.
 *
 * ⚠️ **The one place the rules name the general's unit type**, so the victory
 * check, the heal and the bot ask the same question rather than each spelling
 * it.
 */
export function isGeneral(unit: Unit): boolean {
  return unit.unitTypeId === 'general';
}

/**
 * The player in a seat. ⚠️ **Seats are positions**: seat *n* is the *n*th player
 * in the state, numbered from 1, and that is all that ties a match's seats to
 * its players -- the server's actor rule and the client's *is it my turn* both
 * read it here.
 */
export function playerInSeat(state: GameState, seat: number): Player | null {
  return state.players[seat - 1] ?? null;
}

/**
 * The seat a player sits in, numbered from 1; `null` for nobody in this game.
 * Asks only for the players, so a roster with no board answers it too.
 */
export function seatOf(state: Pick<GameState, 'players'>, player: PlayerId): number | null {
  const index = state.players.findIndex((each) => each.id === player);
  return index === -1 ? null : index + 1;
}

/**
 * Whether these seats include the one whose turn it is -- the server's actor
 * rule and the client's *is it my turn*, one answer.
 */
export function holdsTheTurn(
  state: Pick<GameState, 'players' | 'currentTurn'>,
  seats: readonly number[],
): boolean {
  const current = seatOf(state, state.currentTurn);
  return current !== null && seats.includes(current);
}

export function getCurrentPlayer(state: GameState): Player {
  const player = state.players.find((p) => p.id === state.currentTurn);
  if (!player) throw new Error(`no player found for currentTurn ${state.currentTurn}`);
  return player;
}
