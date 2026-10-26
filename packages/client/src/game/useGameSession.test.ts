import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getUnitType } from '@wargame/shared';
import { at, fullMeter, makeState, route } from '@wargame/shared/testing';
import type {
  Command,
  CommandResult,
  GameEvent,
  GameServer,
  GameState,
  UpdateListener,
} from '@wargame/shared';
import { isTargetPinned } from './interaction/selection';
import { useGameSession } from './useGameSession';
import type { GameSessionCallbacks } from './useGameSession';

// The hook against a fake in-memory GameServer -- the same interface the real
// polling implementation serves, minus the network. `push` plays the role of a
// poll delivering an update; `respond` scripts what the next submit returns.

// b1 can act; its position and infantry's range of 3 make (1,3) a legal move target.
const board = makeState(7, [{ id: 'b1', col: 1, row: 1 }]);

/**
 * ⚠️ The same board with something to shoot at, for anything that needs the
 * *panel*. With only Hold available the panel is skipped entirely, so a
 * single-unit board cannot exercise it.
 */
const contestedBoard = makeState(7, [
  { id: 'b1', col: 1, row: 1 },
  { id: 'r1', col: 1, row: 5, owner: 'red' },
]);

const moved = (): GameEvent => ({
  type: 'unitMoved',
  unitId: 'b1',
  facing: 'north',
  path: [at(1, 1), at(1, 3)],
});

/**
 * One move event covering `tiles` steps.
 *
 * ⚠️ The gate counts *events* now, so the step count is scenery for most of
 * these -- it is kept because a path still has to be a real path, and because
 * the one test that cares about length cares that four is the most a rule can
 * produce.
 */
const walk = (tiles: number): GameEvent => ({
  type: 'unitMoved',
  unitId: 'b1',
  facing: 'north',
  path: Array.from({ length: tiles + 1 }, (_, step) => at(1, step)),
});

// happy-dom's document.hidden is a prototype getter; an own property shadows
// it for the hidden-tab case below.
function setTabHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'hidden'); // drop any per-test shadow
  vi.restoreAllMocks();
});

interface FakeServer {
  server: GameServer;
  submissions: Command[];
  push: (events: GameEvent[], state: GameState) => void;
  /**
   * The state has landed at the authority and no listener has been told --
   * the window while a batch is still animating, in which `getState()` is
   * ahead of everything the board shows.
   */
  land: (state: GameState) => void;
  respond: (result: CommandResult | Promise<CommandResult>) => void;
}

// Every seat unless told otherwise: hot-seat, where it is always your turn.
function fakeServer(initial: GameState, you: number[] = [1, 2]): FakeServer {
  let state = initial;
  const listeners = new Set<UpdateListener>();
  const submissions: Command[] = [];
  let nextResult: CommandResult | Promise<CommandResult> = {
    ok: false,
    reason: 'no response scripted',
  };

  return {
    server: {
      getState: () => state,
      you,
      getClocks: () => null,
      getEndedBy: () => null,
      submit: async (command) => {
        submissions.push(command);
        return nextResult;
      },
      subscribe: (onUpdate) => {
        listeners.add(onUpdate);
        onUpdate([], state);
        return () => listeners.delete(onUpdate);
      },
      dispose: () => listeners.clear(),
    },
    submissions,
    push: (events, next) => {
      state = next;
      for (const listener of listeners) listener(events, next);
    },
    land: (next) => {
      state = next;
    },
    respond: (result) => {
      nextResult = result;
    },
  };
}

function callbacks(): GameSessionCallbacks {
  return {
    onEvents: vi.fn(() => Promise.resolve()),
    onSnap: vi.fn(),
    onPreview: vi.fn(() => Promise.resolve()),
  };
}

function renderSession(fake: FakeServer, initial = callbacks()) {
  return renderHook(({ cb }) => useGameSession(fake.server, cb), {
    initialProps: { cb: initial },
  });
}

describe('useGameSession', () => {
  it('serves the render replica and follows server updates', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake);
    expect(result.current.gameState).toEqual(board);

    const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
    // The commit runs through the queue, a microtask behind the push -- a
    // synchronous act would still see the old state.
    await act(async () => fake.push([], next));
    expect(result.current.gameState).toEqual(next);
  });

  // ⚠️ The board goes quiet when the game does. The server refuses every command
  // once there is a winner, so a click that still selected would draw a route
  // and walk a preview, all of it rolled back by a rejection the player never
  // asked for. This stops the asking; `validateCommand` is still what refuses.
  describe('once the game is over', () => {
    const won = makeState(7, [{ id: 'b1', col: 1, row: 1 }], 'blue', 'blue');

    it('ignores a click that would otherwise select a unit', async () => {
      const fake = fakeServer(won);
      const { result } = renderSession(fake);
      act(() => result.current.clickTile({ col: 1, row: 1 }));
      expect(result.current.selection.phase).toBe('idle');
    });

    // The same click on the same board, differing only in the marker: what
    // isolates the guard as the cause rather than anything else about the setup.
    it('selects that same unit while the game is still on', async () => {
      const fake = fakeServer(board);
      const { result } = renderSession(fake);
      act(() => result.current.clickTile({ col: 1, row: 1 }));
      expect(result.current.selection.phase).toBe('unitSelected');
    });

    // Either side may give up at any time, so off its turn too.
    it('surrenders from the seat whose turn it is not', async () => {
      const fake = fakeServer(board, [2]);
      fake.respond({ ok: false, reason: 'unscripted' });
      const { result } = renderSession(fake);
      await act(async () => result.current.surrender());
      expect(fake.submissions).toEqual([{ type: 'surrender' }]);
    });

    // The same click again, from the seat that is not to move.
    it('only inspects it from the other seat, whose turn it is not', async () => {
      const fake = fakeServer(board, [2]);
      const { result } = renderSession(fake);
      act(() => result.current.clickTile({ col: 1, row: 1 }));
      expect(result.current.selection.phase).toBe('inspecting');
    });

    // ⚠️ It reads the server's live state, not the React one. A guard on the
    // rendered copy would still let a click through in the render where the
    // winning batch has arrived but not yet committed.
    it('goes quiet as soon as the winning state lands', async () => {
      const fake = fakeServer(board);
      const { result } = renderSession(fake);
      await act(async () => fake.push([], won));
      act(() => result.current.clickTile({ col: 1, row: 1 }));
      expect(result.current.selection.phase).toBe('idle');
    });

    // ⚠️ The button carries `disabled`, which is presentation -- a shortcut key
    // or a test reaching the callback directly goes straight past it. The rule
    // lives in `submitCommand`, so every caller inherits it.
    it('sends no endTurn, whatever reaches the callback', async () => {
      const fake = fakeServer(won);
      const { result } = renderSession(fake);
      act(() => result.current.endTurn());
      expect(fake.submissions).toEqual([]);
    });

    // ⚠️ The same guard from the caller that used to rely on being unreachable.
    // A target is pinned *first*, then the winning state lands at the authority
    // while the batch carrying it is still animating -- the multiplayer shape:
    // an opponent's last unit dies while this client still has one aimed at.
    // The pin only comes down when that batch is committed, so in the window
    // the confirming click would submit straight into a refusal. ⚠️ `land`,
    // not `push`: a push commits the batch and takes the pin down with it,
    // and the click that follows is then a plain click proving nothing.
    it('sends no attack from a target that was already pinned', async () => {
      // In reach from the pin and not from the start, so the menu is reached
      // by moving -- wherever the catalog puts infantry's reach.
      const enemy = at(1, PIN.row + getUnitType('infantry').range.max);
      const contested = makeState(enemy.row + 2, [
        { id: 'b1', col: 1, row: 1 },
        { id: 'r1', col: enemy.col, row: enemy.row, owner: 'red' },
      ]);
      const fake = fakeServer(contested);
      const { result } = renderSession(fake);
      await act(async () => {});

      await reachMenu(result);
      act(() => result.current.chooseAction('attacking'));
      act(() => result.current.clickTile(enemy));
      // The precondition, asserted: without a pinned target the confirming
      // click below is just a click on the dark and proves nothing.
      expect(isTargetPinned(result.current.selection)).toBe(true);

      fake.land({ ...contested, winner: 'blue' });
      expect(isTargetPinned(result.current.selection)).toBe(true);
      act(() => result.current.clickTile(at(1, 4)));
      expect(fake.submissions).toEqual([]);
    });

    it('still sends one while the game is on', async () => {
      const fake = fakeServer(board);
      const { result } = renderSession(fake);
      await act(async () => result.current.endTurn());
      expect(fake.submissions).toEqual([{ type: 'endTurn' }]);
    });
  });

  // ⚠️ **The kind is read off the step at the one place that builds a command**,
  // rather than branched on through the dispatch. These two assert the whole
  // difference between the modes: same clicks, same gesture, different word.
  describe('committing an attack', () => {
    // A full meter and a worn-down target, so both modes are on offer.
    const contested = makeState(7, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 5 },
    ]);
    const aimAt = async (
      result: ReturnType<typeof renderSession>['result'],
      kind: 'attacking' | 'charging',
    ) => {
      act(() => result.current.clickTile(at(1, 1))); // opens the panel in place
      act(() => result.current.chooseAction(kind));
      act(() => result.current.clickTile(at(1, 2)));
      await act(async () => result.current.clickTile(at(1, 2)));
    };

    it('sends attack from attacking mode', async () => {
      const fake = fakeServer(contested);
      const { result } = renderSession(fake, callbacks());
      await act(async () => {});
      fake.respond({ ok: true, seq: 1, events: [], state: contested });
      await aimAt(result, 'attacking');
      expect(fake.submissions).toEqual([
        expect.objectContaining({ targetUnitId: 'r1', attackKind: 'attack' }),
      ]);
    });

    it('sends charge from charging mode', async () => {
      const fake = fakeServer(contested);
      const { result } = renderSession(fake, callbacks());
      await act(async () => {});
      fake.respond({ ok: true, seq: 1, events: [], state: contested });
      await aimAt(result, 'charging');
      expect(fake.submissions).toEqual([
        expect.objectContaining({ targetUnitId: 'r1', attackKind: 'charge' }),
      ]);
    });
  });

  describe('inspecting a unit', () => {
    const adjacent = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
      { id: 'r2', col: 5, row: 5, owner: 'red' },
    ]);

    // ⚠️ Each settles the first board update before clicking, which would
    // otherwise arrive afterwards and clear the inspection.
    it('inspects a unit that cannot act', async () => {
      const { result } = renderSession(fakeServer(adjacent));
      await act(async () => {});
      act(() => result.current.clickTile(at(5, 5)));
      expect(result.current.selection).toMatchObject({ phase: 'inspecting', unitId: 'r2' });
    });

    it('clears an inspection when the board moves under it', async () => {
      const fake = fakeServer(adjacent);
      const { result } = renderSession(fake);
      await act(async () => {});
      act(() => result.current.clickTile(at(5, 5)));
      await act(async () => fake.push([], adjacent));
      expect(result.current.selection.phase).toBe('idle');
    });

    // At the panel an enemy is still a click on the dark: it backs out first.
    it('leaves an enemy clicked at the panel to back out to movement', async () => {
      const { result } = renderSession(fakeServer(adjacent));
      await act(async () => {});
      act(() => result.current.clickTile(at(1, 1))); // opens the panel in place
      act(() => result.current.clickTile(at(1, 2)));
      expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });
    });

    it('ends the turn from an inspection, clearing it', async () => {
      const fake = fakeServer(adjacent);
      const { result } = renderSession(fake);
      await act(async () => {});
      fake.respond({ ok: true, seq: 1, events: [], state: adjacent });
      act(() => result.current.clickTile(at(5, 5)));
      await act(async () => result.current.endTurn());
      expect(fake.submissions).toEqual([{ type: 'endTurn' }]);
      expect(result.current.selection.phase).toBe('idle');
    });
  });

  describe('selecting a unit', () => {
    const adjacent = makeState(7, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 2, owner: 'red' },
    ]);

    it('opens the panel where it stands when it could attack from there', async () => {
      const { result } = renderSession(fakeServer(adjacent));
      await act(async () => {});
      act(() => result.current.clickTile(at(1, 1)));
      expect(result.current.selection).toMatchObject({
        phase: 'destinationChosen',
        path: [at(1, 1)],
        step: { kind: 'choosing' },
      });
    });

    it('goes to the movement selection when it has nothing to fight', async () => {
      const { result } = renderSession(fakeServer(contestedBoard));
      await act(async () => {});
      act(() => result.current.clickTile(at(1, 1)));
      expect(result.current.selection.phase).toBe('unitSelected');
    });

    // The way to move a unit whose panel opened in place.
    it('backs out to the movement selection on a click elsewhere', async () => {
      const { result } = renderSession(fakeServer(adjacent));
      await act(async () => {});
      act(() => result.current.clickTile(at(1, 1)));
      act(() => result.current.clickTile(at(4, 4)));
      expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });
    });

    it('backs out to the movement selection on Move', async () => {
      const { result } = renderSession(fakeServer(adjacent));
      await act(async () => {});
      act(() => result.current.clickTile(at(1, 1)));
      act(() => result.current.chooseMove());
      expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });
    });
  });

  // ⚠️ **The ordering a damage animation is built on.** The renderer records the
  // state it last drew, and uses it as the *before* value to count health down
  // from -- `battleResolved` carries only resulting values, so the previous one
  // is nowhere else. That only works because the queue animates first and snaps
  // second. Swap them and every cutaway would count down from the number it was
  // counting down *to*, silently and forever.
  it('animates a batch before snapping the state it produced', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const order: string[] = [];
    vi.mocked(cb.onEvents).mockImplementation(async () => void order.push('events'));
    vi.mocked(cb.onSnap).mockImplementation(() => void order.push('snap'));

    renderSession(fake, cb);
    await act(async () => {}); // the initial batch has no events: snap only
    order.length = 0;

    const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
    await act(async () => fake.push([moved()], next));
    expect(order).toEqual(['events', 'snap']);
  });

  it('forwards events to onEvents', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    renderSession(fake, cb);
    await act(async () => fake.push([moved()], board));
    expect(cb.onEvents).toHaveBeenLastCalledWith([moved()]);
  });

  // 5b: a state is committed only after the events that produced it have
  // finished animating. Every batch snaps before it commits; animation is
  // skipped entirely for large catch-up batches and hidden tabs.
  describe('the animation gate', () => {
    it('commits state only after the batch finishes animating', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      let finish!: () => void;
      vi.mocked(cb.onEvents).mockImplementation(() => new Promise((res) => (finish = res)));
      const { result } = renderSession(fake, cb);
      await act(async () => {}); // settle the initial (empty, unanimated) batch

      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], next));

      // Arrived and animating -- not yet snapped over, not yet committed.
      expect(cb.onEvents).toHaveBeenCalledWith([moved()]);
      expect(cb.onSnap).toHaveBeenCalledTimes(1); // the initial batch only
      expect(result.current.gameState).toEqual(board);

      await act(async () => finish());
      expect(cb.onSnap).toHaveBeenLastCalledWith(next);
      expect(result.current.gameState).toEqual(next);
    });

    it('runs batches serially, in arrival order', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      const pending: Array<() => void> = [];
      vi.mocked(cb.onEvents).mockImplementation(() => new Promise((res) => pending.push(res)));
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      const mid = makeState(7, [{ id: 'b1', col: 1, row: 2 }]);
      const end = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], mid));
      await act(async () => fake.push([moved()], end));

      // Batch two waits on batch one: its animation has not even started.
      expect(pending).toHaveLength(1);
      expect(result.current.gameState).toEqual(board);

      await act(async () => pending[0]?.());
      // One committed; only now does two animate.
      expect(result.current.gameState).toEqual(mid);
      expect(pending).toHaveLength(2);

      await act(async () => pending[1]?.());
      expect(result.current.gameState).toEqual(end);
    });

    // The threshold is `<=`, so five events animate and six do not. Both sides,
    // because only one of them tells you which comparison it is.
    it('still animates a batch of exactly the threshold size', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      renderSession(fake, cb);
      await act(async () => {});

      await act(async () => fake.push([walk(1), walk(1), walk(1), walk(1), walk(1)], board));
      expect(cb.onEvents).toHaveBeenCalled();
    });

    it('snaps instead of animating a large catch-up batch', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () =>
        fake.push(
          Array.from({ length: 6 }, () => walk(1)),
          next,
        ),
      );

      expect(cb.onEvents).not.toHaveBeenCalled();
      expect(cb.onSnap).toHaveBeenLastCalledWith(next);
      expect(result.current.gameState).toEqual(next);
    });

    // ⚠️ **This replaced a test asserting the opposite, deliberately.** The gate
    // used to budget in *tiles*, and that test pinned "three long moves snap,
    // a dozen short ones animate" with the reasoning that tiles are what take
    // time. Two things retired it.
    //
    // ⚠️ **It measured the wrong question.** Twelve resolutions arriving together
    // means twelve turns went by while this client was away, and the old gate
    // *animated* them; three resolutions means barely behind, and it *snapped*.
    // What the gate is for is "am I so far behind that replaying is pointless",
    // which is the count, not the sum.
    //
    // ⚠️ **And its long moves could not happen.** A legal path is bounded by
    // `movementRange`, which is at most four — so `walk(12)` and `walk(28)` are
    // inputs the rules cannot produce, and the variance the tile model existed to
    // normalise was mostly synthetic.
    it('animates a short backlog of long moves and snaps a long one of short moves', async () => {
      const fake = fakeServer(board);

      const barelyBehind = callbacks();
      renderSession(fake, barelyBehind);
      await act(async () => {});
      await act(async () => fake.push([walk(4), walk(4), walk(4)], board));
      expect(barelyBehind.onEvents).toHaveBeenCalled();

      const longAway = callbacks();
      renderSession(fake, longAway);
      await act(async () => {});
      await act(async () =>
        fake.push(
          Array.from({ length: 12 }, () => walk(1)),
          board,
        ),
      );
      expect(longAway.onEvents).not.toHaveBeenCalled();
    });

    it('snaps instead of animating while the tab is hidden', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      setTabHidden(true);
      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], next));

      expect(cb.onEvents).not.toHaveBeenCalled();
      expect(cb.onSnap).toHaveBeenLastCalledWith(next);
      expect(result.current.gameState).toEqual(next);
    });

    // The snap is the correction for a skipped or failed animation, so it
    // must not be able to wedge the queue either.
    it('commits even when the snap itself throws', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      vi.mocked(cb.onSnap).mockImplementation(() => {
        throw new Error('renderer disposed');
      });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], next));

      expect(result.current.gameState).toEqual(next);
      expect(errorLog).toHaveBeenCalled();
    });

    it('snaps over a failed animation and still commits', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      vi.mocked(cb.onEvents).mockRejectedValue(new Error('webgl died'));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], next));

      expect(cb.onSnap).toHaveBeenLastCalledWith(next);
      expect(result.current.gameState).toEqual(next);
      expect(errorLog).toHaveBeenCalled();
    });

    it('clears a rejection on arrival, before the batch finishes animating', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      let finish!: () => void;
      vi.mocked(cb.onEvents).mockImplementation(() => new Promise((res) => (finish = res)));
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      fake.respond({ ok: false, reason: 'illegal move' });
      await act(async () => result.current.endTurn());
      expect(result.current.rejection).toBe('illegal move');

      // Newer authority supersedes the rejection the moment it arrives; only
      // the state commit waits on the animation.
      const next = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
      await act(async () => fake.push([moved()], next));
      expect(result.current.rejection).toBeNull();
      expect(result.current.gameState).toEqual(board);

      await act(async () => finish());
      expect(result.current.gameState).toEqual(next);
    });
  });

  // (1,3) is the destination throughout, so (1,4) is the tile north of it --
  // clicking that is how a facing gets chosen and the move committed.
  const FACE_NORTH = at(1, 4);
  const PIN = at(1, 3);

  /**
   * Select b1, pin a route, and confirm it -- three clicks, ending with the
   * menu up. ⚠️ The confirm is a second click on the *same* tile: the first
   * only draws the route, which is what makes the route state rather than a
   * hover reaction and therefore visible on a touchscreen.
   */
  async function reachMenu(result: ReturnType<typeof renderSession>['result']): Promise<void> {
    act(() => result.current.clickTile(at(1, 1)));
    await act(async () => result.current.clickTile(PIN));
    await act(async () => result.current.clickTile(PIN));
  }

  /**
   * …and then pick Hold, which is what lights the facing tiles.
   *
   * ⚠️ The step the panel added. Facing used to be offered the instant the walk
   * landed, which meant a tile click had to be read against three possible
   * meanings; now the player says which question they are answering first.
   */
  async function reachHold(result: ReturnType<typeof renderSession>['result']): Promise<void> {
    await reachMenu(result);
    act(() => result.current.chooseAction('holding'));
  }

  // ⚠️ **Two rules for backing out.** A dark click inside a mode returns to the
  // panel with the walk intact; a dark click at the panel un-walks the ghost.
  // Asserted as a pair, because the failure mode is one of them swallowing the
  // other -- and a mode that cannot be left is a trap with no way out.
  it('backs out of a mode to the panel, then out of the panel to the board', async () => {
    const fake = fakeServer(contestedBoard);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {});

    await reachHold(result);
    expect(result.current.selection).toMatchObject({ step: { kind: 'holding' } });

    // Far from the unit: lit by nothing, so it means "go back".
    await act(async () => result.current.clickTile(at(5, 5)));
    expect(result.current.selection).toMatchObject({
      phase: 'destinationChosen',
      step: { kind: 'choosing' },
    });
    expect(cb.onPreview).not.toHaveBeenCalledWith(null); // the ghost stays put

    await act(async () => result.current.clickTile(at(5, 5)));
    expect(result.current.selection.phase).toBe('unitSelected');
    expect(cb.onPreview).toHaveBeenCalledWith(null); // and now it walks back
    expect(fake.submissions).toEqual([]); // nothing was ever sent
  });

  // ⚠️ **A menu with one row is a question with one answer**, and it falls on the
  // commonest action in the game — move and wait. Where there *is* a choice the
  // panel still appears, so this buys back the click 9.9 cost without reviving
  // the ambiguity it was introduced to remove.
  describe('when only one action is available', () => {
    it('skips the panel and enters that mode directly', async () => {
      const fake = fakeServer(board); // one unit: nothing to fire at or charge
      const { result } = renderSession(fake, callbacks());
      await act(async () => {});

      act(() => result.current.clickTile(at(1, 1)));
      await act(async () => result.current.clickTile(PIN));
      await act(async () => result.current.clickTile(PIN));
      expect(result.current.selection).toMatchObject({ step: { kind: 'holding' } });
    });

    // ⚠️ And backing out skips it too: a panel the player never saw on the way
    // in is a dead end on the way out, its one row being the mode just left.
    it('backs out past the panel, all the way to the board', async () => {
      const fake = fakeServer(board);
      const cb = callbacks();
      const { result } = renderSession(fake, cb);
      await act(async () => {});

      act(() => result.current.clickTile(at(1, 1)));
      await act(async () => result.current.clickTile(PIN));
      await act(async () => result.current.clickTile(PIN));
      await act(async () => result.current.clickTile(at(5, 5)));
      expect(result.current.selection.phase).toBe('unitSelected');
      expect(cb.onPreview).toHaveBeenCalledWith(null);
    });

    it('still shows the panel when there is a choice', async () => {
      const fake = fakeServer(contestedBoard);
      const { result } = renderSession(fake, callbacks());
      await act(async () => {});

      act(() => result.current.clickTile(at(1, 1)));
      await act(async () => result.current.clickTile(PIN));
      await act(async () => result.current.clickTile(PIN));
      expect(result.current.selection).toMatchObject({ step: { kind: 'choosing' } });
    });
  });

  it('pins, confirms, opens the panel, and submits on a direction', async () => {
    const fake = fakeServer(contestedBoard);
    const { result } = renderSession(fake, callbacks());
    await act(async () => {}); // settle the initial batch, which would drop a pin

    act(() => result.current.clickTile(at(1, 1)));
    expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });

    await act(async () => result.current.clickTile(PIN));
    expect(result.current.selection).toMatchObject({ phase: 'routePinned', unitId: 'b1' });

    await act(async () => result.current.clickTile(PIN)); // the confirm
    // ⚠️ The panel, and nothing lit. The walk landing no longer offers a
    // choice of tiles -- it offers a choice of *questions*.
    expect(result.current.selection).toMatchObject({
      phase: 'destinationChosen',
      unitId: 'b1',
      step: { kind: 'choosing' },
    });
    expect(fake.submissions).toEqual([]); // the whole point: nothing has left yet

    act(() => result.current.chooseAction('holding'));
    expect(result.current.selection).toMatchObject({ step: { kind: 'holding' } });
    expect(fake.submissions).toEqual([]); // still nothing: a mode is not a commit

    fake.respond({ ok: true, seq: 1, events: [], state: board });
    await act(async () => result.current.clickTile(FACE_NORTH));
    expect(fake.submissions).toEqual([
      { type: 'move', unitId: 'b1', path: route(at(1, 1), at(1, 3)), facing: 'north' },
    ]);
    // Cleared the moment the command left, not when the server answered.
    expect(result.current.selection).toEqual({ phase: 'idle' });
  });

  // The skip in playEvents is sound only because the mesh has arrived, so the
  // rule lives here rather than on the button's disabled attribute -- a
  // keyboard shortcut or a direct call would otherwise walk straight past it.
  it('refuses Hold while the preview is still walking', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    let arrive!: () => void;
    vi.mocked(cb.onPreview).mockReturnValue(
      new Promise<void>((resolve) => {
        arrive = resolve;
      }),
    );
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachMenu(result);
    expect(result.current.walking).toBe(true);

    // ⚠️ The mode cannot be entered either, and for the same reason: the panel
    // only exists once the unit has arrived, so Hold mid-walk is a no-op rather
    // than a queued intent.
    act(() => result.current.chooseAction('holding'));
    await act(async () => result.current.clickTile(FACE_NORTH));
    expect(fake.submissions).toEqual([]); // refused: the mesh is still short
    // ⚠️ Still the pinned phase, because arrival is what turns it over -- so
    // the refused click cannot have been read as a facing on the way past.
    expect(result.current.selection.phase).toBe('routePinned');

    await act(async () => arrive());
    act(() => result.current.chooseAction('holding'));
    await act(async () => result.current.clickTile(FACE_NORTH));
    expect(fake.submissions).toHaveLength(1);
  });

  // 7d's contract, and the reason the menu waits: while the ghost walks, the
  // mesh is short of the destination, and a confirm there would replay the
  // move from wherever it had got to.
  it('walks the preview on confirm rather than on the pin', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    let arrive!: () => void;
    vi.mocked(cb.onPreview).mockReturnValue(
      new Promise<void>((resolve) => {
        arrive = resolve;
      }),
    );
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    act(() => result.current.clickTile(at(1, 1)));
    await act(async () => result.current.clickTile(PIN));
    // ⚠️ The pin draws a route and moves nothing. This is the whole step.
    expect(cb.onPreview).not.toHaveBeenCalled();
    expect(result.current.walking).toBe(false);

    await act(async () => result.current.clickTile(PIN));
    expect(cb.onPreview).toHaveBeenCalledWith({
      unitId: 'b1',
      path: route(at(1, 1), at(1, 3)),
    });
    expect(result.current.walking).toBe(true);

    await act(async () => arrive());
    expect(result.current.walking).toBe(false);
  });

  // ⚠️ Every reachable tile stays live while a route is pinned, so re-pinning
  // is a click rather than a cancel and a reselect -- and none of it walks
  // anything, which is what makes changing your mind free.
  it('re-pins without walking, and only the confirm moves the unit', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    // ⚠️ Every tile here is within infantry's 3 from (1,1). (3,3) costs 4 and
    // would cancel instead of re-pinning -- the range is a diamond, not a box.
    act(() => result.current.clickTile(at(1, 1)));
    await act(async () => result.current.clickTile(PIN));
    await act(async () => result.current.clickTile(at(3, 1)));
    await act(async () => result.current.clickTile(at(2, 2)));
    expect(cb.onPreview).not.toHaveBeenCalled();
    expect(result.current.selection).toMatchObject({ phase: 'routePinned', unitId: 'b1' });

    await act(async () => result.current.clickTile(at(2, 2)));
    expect(cb.onPreview).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cb.onPreview).mock.lastCall?.[0]?.path.at(-1)).toEqual(at(2, 2));
  });

  // Backing out of a route that never walked has nothing to put back, so the
  // preview is never told. ⚠️ The menu phase differs and is covered below: a
  // ghost is standing at the destination there, and it has to go home.
  it('cancels a pinned route without touching the preview', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    act(() => result.current.clickTile(at(1, 1)));
    await act(async () => result.current.clickTile(PIN));
    await act(async () => result.current.clickTile(at(6, 1))); // outside the range

    expect(cb.onPreview).not.toHaveBeenCalled();
    expect(fake.submissions).toEqual([]);
  });

  // The silence is the design: both of these end with onSnap writing an
  // authoritative position over the mesh, so the correction the renderer
  // already performs is the instruction. Hence no commit verb.
  it('says nothing to the preview on confirm', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachHold(result);
    vi.mocked(cb.onPreview).mockClear();

    fake.respond({ ok: true, seq: 1, events: [], state: board });
    await act(async () => result.current.clickTile(at(1, 4)));
    expect(cb.onPreview).not.toHaveBeenCalled();
  });

  // The one case nothing else would correct: a rejection produces no update,
  // so syncUnits never runs and the ghost would stand there for good.
  it('puts the unit back when the authority refuses', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachMenu(result);
    fake.respond({ ok: false, reason: 'illegal move' });
    await act(async () => result.current.clickTile(FACE_NORTH));

    expect(cb.onPreview).toHaveBeenLastCalledWith(null);
  });

  it('drops a pinned destination when the board moves underneath it', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachMenu(result);
    expect(result.current.selection.phase).toBe('destinationChosen');

    // An uncommitted plan does not survive the board changing under it -- it
    // may not even be legal any more.
    await act(async () => fake.push([], makeState(7, [{ id: 'b1', col: 1, row: 1 }])));
    expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });
  });

  it('sends nothing at all when a pinned destination is cancelled', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachMenu(result);
    // Neither the destination nor beside it, so it means back out.
    await act(async () => result.current.clickTile(at(3, 3)));

    expect(fake.submissions).toEqual([]);
    expect(cb.onPreview).toHaveBeenLastCalledWith(null); // and the ghost goes home
    // Still selected, standing where it started, ready to pick again.
    expect(result.current.selection).toMatchObject({
      phase: 'unitSelected',
      unitId: 'b1',
      position: at(1, 1),
    });
  });

  // ⚠️ Everything lit answers the pin; everything else backs out of it. There
  // is no third reading, which is what lets the range coming down carry the
  // whole rule.
  it('treats a tile click that means neither as a cancel', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake, callbacks());
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachMenu(result);

    // Reachable, but neither the destination nor beside it.
    await act(async () => result.current.clickTile(at(3, 3)));
    expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });
    expect(fake.submissions).toEqual([]);
  });

  // The gesture the merge is for: the destination itself keeps the direction
  // travelled, so the common move is one click rather than a menu and a click.
  it('commits on the destination itself, facing the way it travelled', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake, callbacks());
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachHold(result);
    await act(async () => result.current.clickTile(PIN)); // and again, to commit

    expect(fake.submissions).toEqual([
      { type: 'move', unitId: 'b1', path: route(at(1, 1), at(1, 3)), facing: 'north' },
    ]);
  });

  // Invariant 1, and the one place it can be observed: the replica lags on
  // purpose while a batch animates, so a click landing in that window must
  // read `server.getState()` -- the authority, already ahead -- and not the
  // state React is still showing. Nothing else in this suite distinguishes
  // them, because the fake normally moves both in lockstep.
  it('clicks against the authority, not the replica it is still displaying', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    let finishAnimating!: () => void;
    vi.mocked(cb.onEvents).mockImplementation(() => new Promise((res) => (finishAnimating = res)));
    const { result } = renderSession(fake, cb);
    await act(async () => {});

    // b1 has moved to (1,3) as far as the server is concerned, and the batch
    // is still animating -- so the replica still has it at (1,1).
    const movedState = makeState(7, [{ id: 'b1', col: 1, row: 3 }]);
    await act(async () => fake.push([moved()], movedState));
    expect(result.current.gameState).toEqual(board); // replica: still at (1,1)

    // Clicking the unit where the *authority* has it must select it. Reading
    // the replica would find an empty tile there and select nothing.
    await act(async () => result.current.clickTile(at(1, 3)));
    expect(result.current.selection).toMatchObject({ phase: 'unitSelected', unitId: 'b1' });

    await act(async () => finishAnimating());
  });

  it('sets rejection and rolls back to the unit, not to the refused destination', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake, callbacks());
    await act(async () => {}); // settle the initial batch, which would drop a pin

    await reachHold(result);
    fake.respond({ ok: false, reason: 'illegal move' });
    await act(async () => result.current.clickTile(FACE_NORTH));

    expect(result.current.rejection).toBe('illegal move');
    // Handing back the pin would invite the player to confirm the very move
    // the server just refused.
    expect(result.current.selection).toMatchObject({
      phase: 'unitSelected',
      unitId: 'b1',
      position: at(1, 1),
    });
  });

  it('clears the rejection on the next server update', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake);
    fake.respond({ ok: false, reason: 'illegal move' });
    await act(async () => result.current.endTurn());
    expect(result.current.rejection).toBe('illegal move');

    act(() => fake.push([], board));
    expect(result.current.rejection).toBeNull();
  });

  // The hazard the extraction had to dodge: subscribe fires synchronously and
  // clears the rejection, so if the subscription depended on the callbacks'
  // identities, a re-render with fresh callbacks would re-subscribe and wipe a
  // rejection before anyone saw it. The latest-ref keeps the subscription on
  // `server` alone; this fails if that regresses.
  it('keeps the rejection across re-renders with new callback identities', async () => {
    const fake = fakeServer(board);
    const { result, rerender } = renderSession(fake);
    fake.respond({ ok: false, reason: 'illegal move' });
    await act(async () => result.current.endTurn());
    expect(result.current.rejection).toBe('illegal move');

    rerender({ cb: callbacks() });
    expect(result.current.rejection).toBe('illegal move');
  });

  // The hook is written against the interface: the real implementation never
  // rejects, but one that does must read as a rejection and release the
  // in-flight guard, not soft-lock the UI forever.
  it('treats a rejecting submit as a rejection and releases the guard', async () => {
    const fake = fakeServer(board);
    const { result } = renderSession(fake);

    const failure = Promise.reject(new Error('implementation broke'));
    // Pre-handle so the runner never sees an unhandled rejection; the await
    // inside the hook still receives the rejection.
    failure.catch(() => {});
    fake.respond(failure);
    await act(async () => result.current.endTurn());
    expect(result.current.rejection).toBe('implementation broke');

    // The guard released: the next submit goes through.
    fake.respond({ ok: true, seq: 1, events: [], state: board });
    await act(async () => result.current.endTurn());
    expect(fake.submissions).toHaveLength(2);
  });

  it('ignores clicks while a submit is in flight', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);

    await act(async () => {}); // settle the initial batch, which would drop a pin
    await reachHold(result);
    let release!: (result: CommandResult) => void;
    fake.respond(new Promise<CommandResult>((res) => (release = res)));

    await act(async () => result.current.clickTile(FACE_NORTH)); // in flight now
    const during = result.current.selection;
    act(() => result.current.clickTile(at(1, 1))); // swallowed by the guard
    expect(fake.submissions).toHaveLength(1);
    expect(result.current.selection).toBe(during);

    release({ ok: true, seq: 1, events: [], state: board });
    await act(async () => {});
  });

  it('endTurn submits and clears the selection', async () => {
    const fake = fakeServer(board);
    const cb = callbacks();
    const { result } = renderSession(fake, cb);
    act(() => result.current.clickTile(at(1, 1)));

    fake.respond({ ok: true, seq: 1, events: [], state: board });
    await act(async () => result.current.endTurn());
    expect(fake.submissions).toEqual([{ type: 'endTurn' }]);
    expect(result.current.selection).toEqual({ phase: 'idle' });
  });
});
