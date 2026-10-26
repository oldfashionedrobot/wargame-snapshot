import { refuseAttack, refuseCharge, resolveBattle, resolveCharge } from './combat';
import type { Rolls } from './combat';
import { facingToward } from './coordinate';
import { getUnitType } from './data/unitTypes';
import { canSelectUnit } from './legality';
import { validatePath } from './movement';
import { getUnit } from './queries';
import type { GameEvent, GameState, MoveCommand, Unit } from './types';
import type { MoveAction } from './action';

/**
 * Returns the reason this move is refused, or null if it is legal.
 *
 * Three questions, deliberately separate: does the unit exist, may it act at
 * all, and is the route it was given walkable. `validatePath` answers only
 * the last, which is what keeps it composable -- 9f asks the same question
 * before an attack.
 */
export function validateMove(state: GameState, command: MoveCommand): string | null {
  const unit = getUnit(state, command.unitId);
  if (!unit) return 'unit not found';

  // The same predicate the client previews selection with, so what it offers
  // and what the server accepts cannot drift. The reason is derived from it
  // rather than re-decided, so there is still one definition of "may act".
  if (!canSelectUnit(state, unit)) {
    return unit.owner === state.currentTurn
      ? 'that unit has already acted'
      : 'that unit is not yours';
  }

  const { movementRange, movementType } = getUnitType(unit.unitTypeId);
  const unwalkable = validatePath(state, unit, command.path, movementRange, movementType);
  if (unwalkable) return unwalkable;

  // A plain move, which is every move until 9h can name a target.
  // ⚠️ A kind with nothing to attack is refused rather than ignored: dropping it
  // silently would let a malformed command read as a plain move.
  if (command.targetUnitId === undefined) {
    return command.attackKind === undefined ? null : 'an attack kind needs a target';
  }

  // ⚠️ **From the destination, not from `unit.position`.** The route has already
  // been proven walkable above, so the last tile is where this unit will be
  // standing when it attacks -- and distance measured anywhere else is measuring
  // a tile the attack does not happen from.
  // ⚠️ The whole path, not just its end. Distance is measured from the last
  // tile, but whether the unit *moved at all* is the other half of what an
  // attack has to be legal against, and only the path says so.
  const refused =
    command.attackKind === 'charge'
      ? refuseCharge(state, unit, command.path, command.targetUnitId)
      : refuseAttack(state, unit, command.path, command.targetUnitId);
  if (refused) return refused;

  // ⚠️ **An attack always ends facing its target.** Asked here rather than in
  // the refusals, which the client and the bot call to find targets before any
  // facing exists. The destination is never the target's tile, so
  // `facingToward`'s fallback never applies and the facing is fully decided.
  const target = getUnit(state, command.targetUnitId)!;
  const destination = command.path[command.path.length - 1];
  return command.facing === facingToward(destination, target.position, command.facing)
    ? null
    : 'an attack ends facing its target';
}

/**
 * The event carries the whole path: the client animates every step, and the
 * final tile is the new position. Facing rides along rather than being derived
 * from the path -- the player may end a move looking somewhere they did not
 * come from, so the path cannot answer for it.
 */
export function resolveMove(state: GameState, action: MoveAction, rolls: Rolls): GameEvent[] {
  const events: GameEvent[] = [
    { type: 'unitMoved', unitId: action.unitId, path: action.path, facing: action.facing },
  ];
  if (action.targetUnitId === undefined) return events;

  // ⚠️ Validation proved both of these exist, so a miss here is a broken
  // pipeline rather than a bad request -- loud, like `getUnitType`'s throw, for
  // the same reason: a silent undefined surfaces as NaN somewhere far away.
  const attacker = getUnit(state, action.unitId);
  const defender = getUnit(state, action.targetUnitId);
  if (!attacker || !defender) {
    throw new Error(
      `resolved an attack with a missing unit: ${action.unitId} → ${action.targetUnitId}`,
    );
  }

  // ⚠️ The attacker **after** the move. Nothing in a first strike reads its
  // position, but a counter reads its terrain, which is the destination's --
  // so building it here means 9g inherits the right tile rather than retrofits
  // one. `state` is deliberately not folded: the only thing that changed is
  // this unit, and it is right here.
  const moved: Unit = {
    ...attacker,
    position: action.path[action.path.length - 1],
    facing: action.facing,
  };
  // ⚠️ **Dispatched once, on the kind, into two self-contained resolvers.** An
  // attack produces damage and a possible counter; a charge produces death and
  // displacement or a repel, and never consults the counter rule.
  // Threading conditionals through one function would put two mechanics in one
  // body and make every later change ask which it belonged to.
  if (action.attackKind === 'charge') {
    const battle = resolveCharge(state, moved, defender, rolls);
    events.push(battle);

    // ⚠️ **Appended after the battle, never before it.** The defender leaves the
    // board in `applyEvents` when its health hits zero, so displacing first
    // would put the attacker on an occupied tile -- which breaks invariant 9's
    // "makes sense against the state immediately before it".
    //
    // ⚠️ A *second* `unitMoved` for one unit in one batch, which nothing else
    // produces. `playEvents` skips a move whose mesh already stands at the
    // destination -- true of the approach, which was previewed, and false of
    // this, which was not. The asymmetry is correct and is why it works.
    if (battle.defender.health <= 0) {
      events.push({
        type: 'unitMoved',
        unitId: moved.id,
        path: [moved.position, defender.position],
        facing: action.facing,
      });
    }
    return events;
  }

  events.push(resolveBattle(state, moved, defender, rolls));
  return events;
}
