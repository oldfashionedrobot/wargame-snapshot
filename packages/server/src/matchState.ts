import { armyWidth, MAX_HEALTH, parseArmyGrid, parseTerrainGrid } from '@wargame/shared';
import type { GameState, Player, Unit } from '@wargame/shared';
import type { GameMap } from './maps';

// The two players every match is between, named by seat: seat *n* is
// `player-n`. ⚠️ **The colour is not the id** -- for now seat 1 is blue and seat
// 2 red, and a colour chosen per player later changes nothing that identifies
// anyone. Exported for the suite, which pairs these with armies of its own --
// the default list below is the only thing production reads.
export const PLAYERS: Player[] = [
  { id: 'player-1', name: 'Blue Army', color: 'blue' },
  { id: 'player-2', name: 'Red Army', color: 'red' },
];

/**
 * How much of the board a player's units may be placed on: a rectangle against
 * their own edge, wherever along it the map puts it.
 *
 * ⚠️ **An army grid is exactly this size, not merely bounded by it.** Padding
 * with empties is what makes an *offset* deployment expressible: under
 * auto-centring `['iiii......']` and `['...iiii...']` are the same four units
 * in the middle, and against a zone they are a left flank and a centre. The
 * price is that a short grid is an error rather than a centred rank, which is
 * the trade wanted -- a deployment that does not say where it stands is the
 * thing being removed.
 *
 * ⚠️ **Where an army stands is therefore the zone's and the map's, never the
 * army's.** Nothing about placement varies with what is fielded, which is why
 * `armyWidth` is read here as a *check* rather than as an input to the sum.
 */
export interface DeploymentZone {
  width: number;
  depth: number;
}

/**
 * The zone's size, the same on every map -- where it sits is the map's, by
 * `GameMap.zoneStarts`. The rows nearest each edge are taken, on a board of any
 * size that fits both zones; `createMatchState` refuses one that does not.
 *
 * ⚠️ **Reachable as an argument**, the same shape `ACTIONS_PER_TURN` has and for
 * the same reason: the suite deploys onto boards this game never ships, so
 * moving this line must not move the suite.
 */
export const DEPLOYMENT_ZONE: DeploymentZone = { width: 10, depth: 2 };

/**
 * The default army both sides field, hardcoded beside `PLAYERS` and for the
 * same reason: nothing *chooses* an army yet. It is a default rather than a
 * constant -- `createMatchState` takes the deployments as an argument, which is
 * the seam player-chosen composition arrives through, and which keeps the suite
 * from pinning whatever this happens to say today.
 *
 * ⚠️ **A tuning dial rather than a doctrine**, and the thing most likely to move
 * again in playtesting.
 */
const ARMY: string[] = ['cagac.....', 'iiiii.....'];

/** One player, and the army they field. */
export interface Deployment {
  player: Player;
  army: string[];
}

const DEFAULT_DEPLOYMENTS: Deployment[] = PLAYERS.map((player) => ({ player, army: ARMY }));

/**
 * Instantiates a map into the state a match starts from.
 *
 * ⚠️ **The army binds to the player; the seat stays positional.** Pairing the
 * two is what stops a second array having to agree with `PLAYERS` by index --
 * but the *edge* is still read off the order: first deploys on the near edge
 * looking north, second on the far edge looking south. List order is seating
 * order, which is worth stating rather than leaving to be inferred.
 *
 * ⚠️ Unit ids are `p${seat}-${n}`, numbered in **army scan order** -- row,
 * then column, within that player's own army; by seat, never by colour. Deterministic on purpose:
 * `initial_state` plus the log has to replay identically, which a generated or
 * random id would break.
 */
export function createMatchState(
  map: GameMap,
  deployments: Deployment[] = DEFAULT_DEPLOYMENTS,
  zone: DeploymentZone = DEPLOYMENT_ZONE,
): GameState {
  const grid = parseTerrainGrid(map.rows);
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  const slack = width - zone.width;

  // ⚠️ Refused rather than clamped. A board narrower than the zone has no room
  // for it, and placing it anyway deploys units at negative columns -- a state
  // that parses, stores and replays, and is wrong from the first frame. The
  // depth check sums the zones rather than doubling one, so it still says the
  // right thing if a third seat is ever dealt in.
  if (slack < 0 || zone.depth * deployments.length > height) {
    throw new Error(
      `map ${map.id} is ${width}x${height}, too small for ${deployments.length} deployment ` +
        `zones ${zone.width} wide and ${zone.depth} deep`,
    );
  }

  // ⚠️ The far default is the near one turned, which on a board with an odd
  // spare column sits a column east of it -- so `[centred, centred]` would
  // quietly move it.
  const centred = Math.floor(slack / 2);
  const starts = map.zoneStarts ?? [centred, slack - centred];

  // ⚠️ Checked before parsing, because `parseArmyGrid` speaks about *rows*
  // agreeing with each other and this is about them agreeing with the zone. A
  // grid narrower than the zone is the case that used to be silently centred.
  deployments.forEach(({ player, army }, seat) => {
    if (army.length !== zone.depth || armyWidth(army) !== zone.width) {
      throw new Error(
        `${player.id} fields an army ${armyWidth(army)}x${army.length}, ` +
          `not the ${zone.width}x${zone.depth} deployment zone`,
      );
    }
    const start = starts[seat];
    if (!Number.isInteger(start) || start < 0 || start > slack) {
      throw new Error(
        `map ${map.id} puts ${player.id}'s deployment zone at column ${start}, ` +
          `off a board ${width} wide`,
      );
    }
  });

  const units = deployments.flatMap(({ player, army }, seat) =>
    parseArmyGrid(army).map((placement, index): Unit => {
      const { col, row } = placement.at;
      const start = starts[seat];

      return {
        id: `p${seat + 1}-${index + 1}`,
        // ⚠️ The far army is **turned within its own zone**, not copied into
        // it. Copy it and both armies face the same way down the board with one
        // of them looking at the back of its own guns; turn it, and each
        // player's line is drawn from its own left.
        position:
          seat === 0
            ? { col: start + col, row }
            : { col: start + zone.width - 1 - col, row: height - 1 - row },
        // ⚠️ Toward the enemy, which is the opposite of what this used to say.
        // Row index increases north and seat 0 starts at row 0, so giving it
        // `south` pointed both armies off their own edge. A rule reads this: an
        // attack from directly behind goes unanswered, so the sign being wrong
        // would hand every opening counter to whoever moved second.
        facing: seat === 0 ? 'north' : 'south',
        unitTypeId: placement.unitTypeId,
        owner: player.id,
        health: MAX_HEALTH,
        chargeMeter: 0,
        hasActed: false,
      };
    }),
  );

  const players = deployments.map(({ player }) => player);
  return { grid, units, players, currentTurn: players[0].id, winner: null };
}
