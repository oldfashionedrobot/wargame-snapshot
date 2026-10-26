import type { GameEvent, GameState, Unit } from './types';

/**
 * The only thing that mutates state.
 *
 * Reducers decide *what happened* and return events; this turns events into a
 * new state. One mutation path, so live play and replay cannot diverge --
 * `applyEvents(initialState, wholeLog)` reproduces `currentState` by
 * construction rather than by hope.
 *
 * Two rules constrain every event, now and later:
 *
 * 1. **Independently applicable.** Each event must make sense against the state
 *    immediately before it, with no knowledge of its siblings. That is what
 *    lets a log be replayed to any point -- including mid-resolution -- and
 *    what lets the client fold as it animates. A charge that breaks through
 *    therefore emits a `battleResolved` and then a `unitMoved`, not one
 *    compound event.
 *
 * 2. **Absolute values, not deltas.** An event says what something *became*,
 *    never how much it changed by. That is what makes applying one twice a
 *    no-op, so at-least-once delivery is safe and a replaying client needs no
 *    exact-once bookkeeping. `battleResolved` therefore carries each side's
 *    resulting health, not the damage dealt -- damage is `before - after`,
 *    which the client already knows because it holds the preceding state.
 *
 * Idempotent is not commutative: order still matters, and comes from
 * `(seq, index within the events array)`.
 */
export function applyEvents(state: GameState, events: GameEvent[]): GameState {
  return events.reduce(applyEvent, state);
}

function applyEvent(state: GameState, event: GameEvent): GameState {
  switch (event.type) {
    case 'unitMoved': {
      const destination = event.path[event.path.length - 1];

      return {
        ...state,
        units: state.units.map((unit): Unit =>
          unit.id === event.unitId
            ? {
                ...unit,
                position: destination,
                facing: event.facing,
                hasActed: true,
              }
            : unit,
        ),
      };
    }

    case 'battleResolved': {
      // ⚠️ **A unit at zero health leaves the board**, said once, here. That is
      // why there is no `unitDied` event and no `died` flag: `health: 0` is the
      // marker, and a flag beside the number could disagree with it.
      //
      // The filter is deliberately broader than "whoever this event killed" --
      // nothing else can be sitting at zero, since anything that reached it was
      // removed by the event that put it there. Stating the rule rather than
      // the special case is what keeps applying this twice a no-op.
      const { attacker, defender } = event;

      return {
        ...state,
        units: state.units
          .map((unit): Unit => {
            if (unit.id === attacker.unitId) {
              return { ...unit, health: attacker.health, chargeMeter: attacker.chargeMeter };
            }
            if (unit.id === defender.unitId) return { ...unit, health: defender.health };
            return unit;
          })
          .filter((unit) => unit.health > 0),
      };
    }

    case 'unitsHealed': {
      const healed = new Map(event.units.map(({ unitId, health }) => [unitId, health]));
      return {
        ...state,
        units: state.units.map((unit): Unit => {
          const health = healed.get(unit.id);
          return health === undefined ? unit : { ...unit, health };
        }),
      };
    }

    case 'turnEnded':
      // Only the incoming player's units refresh; the outgoing player's stay
      // spent, which is what stops a unit acting twice across the boundary.
      return {
        ...state,
        currentTurn: event.nextPlayer,
        units: state.units.map((unit) =>
          unit.owner === event.nextPlayer ? { ...unit, hasActed: false } : unit,
        ),
      };

    case 'gameEnded':
      // ⚠️ `currentTurn` is deliberately left alone. `getCurrentPlayer` throws
      // when it names nobody and the client's turn label calls it every render,
      // so clearing it would crash the board at the exact moment it should be
      // showing a result. The marker is additive; readers check it first.
      return { ...state, winner: event.winner };

    default: {
      // ⚠️ Two jobs. `never` makes a new member of the union a **compile error
      // here** until it is handled -- without it, adding an event type
      // typechecks cleanly and silently falls through to the throw below, which
      // is the one place that would never be noticed. The throw is still
      // needed: events arrive as JSON from the database and over the wire,
      // where types guarantee nothing, and ignoring one would desync a replay.
      const unhandled: never = event;
      throw new Error(`unknown event type: ${String((unhandled as GameEvent).type)}`);
    }
  }
}
