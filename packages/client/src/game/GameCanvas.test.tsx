import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getUnitType } from '@wargame/shared';
import type { Coordinate, EndedBy, GameEvent, GameServer, GameState } from '@wargame/shared';
import type { ConnectionStatus } from '../net/gameServer';
import { fullMeter, makeState } from '@wargame/shared/testing';
import { GameCanvas } from './GameCanvas';
import type { CutawayScene, GameRenderer } from './render/renderer';

// The renderer is the seam: it builds a Babylon engine, which needs WebGL that
// happy-dom does not have. Everything below is the wiring around it -- the
// chrome, the lifecycle, and the three callbacks the session pushes through.
vi.mock('./render/renderer', () => ({ createGameRenderer: vi.fn() }));
const { createGameRenderer } = await import('./render/renderer');

let renderer: GameRenderer;

/**
 * The overlay and tiles of the last `setStepTiles`.
 *
 * ⚠️ **What this replaced was three mocks and an "and the other two are dark"
 * assertion beside every one of them.** Exclusivity is structural now -- one
 * call cannot light two overlays -- so the tests assert *which* is lit and stop
 * re-proving that the others are not.
 */
const lastOverlay = (): [string | null, { col: number; row: number }[]] | undefined =>
  vi.mocked(renderer.setStepTiles).mock.lastCall as
    [string | null, { col: number; row: number }[]] | undefined;
let clickTile: (coordinate: Coordinate) => void;

const board: GameState = makeState(5, [{ id: 'b1', col: 1, row: 1 }]);

/** A server that serves one board and nothing else. */
const serving = (state: GameState) =>
  fakeServer({
    getState: () => state,
    subscribe: vi.fn((onUpdate) => {
      onUpdate([], state);
      return () => {};
    }),
  });

// ⚠️ Read off the catalog: the fixtures below place the enemy by infantry's
// reach, in range from the pin at (1,3) and not from where b1 starts, and a
// number written here would fail on a retune while describing the old reach.
const REACH = getUnitType('infantry').range.max;
const ENEMY = { col: 1, row: 3 + REACH };

/**
 * ⚠️ The same board with something to shoot at, for anything needing the
 * *panel*: with only Hold available it is skipped, so a lone unit cannot
 * exercise it.
 */
const contestedBoard: GameState = makeState(ENEMY.row + 1, [
  { id: 'b1', col: 1, row: 1 },
  { id: 'r1', col: ENEMY.col, row: ENEMY.row, owner: 'red' },
]);
const contested = () => serving(contestedBoard);

beforeEach(() => {
  vi.clearAllMocks();
  renderer = {
    onTileClick: vi.fn((handler: (c: Coordinate) => void) => {
      clickTile = handler;
    }),
    setSelectedTile: vi.fn(),
    setRange: vi.fn(),
    setStepTiles: vi.fn(),
    setRoute: vi.fn(),
    anchorTo: vi.fn(),
    playEvents: vi.fn(() => Promise.resolve()),
    syncUnits: vi.fn(),
    onCutaway: vi.fn(),
    previewMove: vi.fn(() => Promise.resolve()),
    cancelPreview: vi.fn(),
    tileToScreen: vi.fn(() => ({ x: 10, y: 20 })),
    toggleInspector: vi.fn(),
    dispose: vi.fn(),
  };
  vi.mocked(createGameRenderer).mockResolvedValue(renderer);
});

// Construction is async now -- unit models load before the renderer exists --
// so anything touching `renderer` or `clickTile` has to let that promise settle
// first. Rendering through one helper keeps every test on the same footing.
async function renderCanvas(
  server: GameServer,
  connection: ConnectionStatus = 'connected',
  opponentHere = false,
) {
  const result = render(
    <GameCanvas server={server} connection={connection} opponentHere={opponentHere} />,
  );
  await act(async () => {});
  return result;
}

const fakeServer = (over: Partial<GameServer> = {}): GameServer => ({
  getState: () => board,
  you: [1, 2],
  getClocks: () => null,
  getEndedBy: () => null,
  submit: vi.fn(async () => ({ ok: true as const, seq: 1, events: [], state: board })),
  subscribe: vi.fn((onUpdate) => {
    onUpdate([], board);
    return () => {};
  }),
  dispose: vi.fn(),
  ...over,
});

describe('GameCanvas', () => {
  it('names whose turn it is', async () => {
    await renderCanvas(fakeServer());
    expect(screen.getByText(/Blue Army's turn/)).toBeTruthy();
  });

  // Hot-seat holds every seat, so only a shared game says which army is yours.
  it('says which army you command in a shared game, and when it is your turn', async () => {
    await renderCanvas(fakeServer({ you: [1] }));
    expect(screen.getByText(/You command Blue Army/)).toBeTruthy();
    expect(screen.getByText(/Your turn/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', false);
  });

  // ⚠️ Counted from when the reading arrived, and only for the side to move.
  it("shows both clocks, the mover's counted down since the last report", async () => {
    const minute = 60_000;
    await renderCanvas(
      fakeServer({
        getClocks: () => ({ remaining: [5 * minute, 5 * minute], at: Date.now() - 61_000 }),
      }),
    );
    expect(screen.getByText(/Blue Army 3:59/)).toBeTruthy();
    expect(screen.getByText(/Red Army 5:00/)).toBeTruthy();
  });

  it('shows no clocks for a game without them', async () => {
    await renderCanvas(fakeServer());
    expect(screen.queryByText(/\d:\d\d/)).toBeNull();
  });

  it('says whether the other side is here, in a shared game and only there', async () => {
    const { unmount } = await renderCanvas(fakeServer({ you: [1] }), 'connected', true);
    expect(screen.getByText(/your opponent is here/)).toBeTruthy();
    unmount();
    await renderCanvas(fakeServer({ you: [1] }), 'connected', false);
    expect(screen.getByText(/your opponent is away/)).toBeTruthy();
  });

  it('shows no opponent in hot-seat, which has none', async () => {
    await renderCanvas(fakeServer(), 'connected', true);
    expect(screen.queryByText(/your opponent/)).toBeNull();
  });

  // ⚠️ Asked on the page: a portal's sandboxed iframe can refuse window.confirm.
  it('surrenders only once asked twice, and not at all when kept playing', async () => {
    const server = fakeServer();
    await renderCanvas(server);
    fireEvent.click(screen.getByRole('button', { name: 'Surrender…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep playing' }));
    expect(server.submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Surrender…' }));
    expect(screen.getByText(/for Blue Army/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Surrender' }));
    expect(server.submit).toHaveBeenCalledWith({ type: 'surrender' });
  });

  describe('once the game is over', () => {
    const over = (endedBy: EndedBy, you: number[]) =>
      fakeServer({
        ...serving(makeState(5, [{ id: 'b1', col: 1, row: 1 }], 'blue', 'red')),
        you,
        getEndedBy: () => endedBy,
      });

    it('names the winning side in hot-seat, and how the other gave up', async () => {
      await renderCanvas(over('surrender', [1, 2]));
      expect(screen.getByText('Red Army wins — Blue Army surrendered')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Surrender…' })).toBeNull();
    });

    it('says who won to each player of a shared game', async () => {
      const { unmount } = await renderCanvas(over('clock', [1]));
      expect(screen.getByText('You lost — you ran out of time')).toBeTruthy();
      unmount();
      await renderCanvas(over('board', [2]));
      expect(screen.getByText('You won')).toBeTruthy();
    });
  });

  it("disables End Turn on the other seat's turn", async () => {
    await renderCanvas(fakeServer({ you: [2] }));
    expect(screen.getByText(/You command Red Army/)).toBeTruthy();
    expect(screen.getByText(/Blue Army's turn/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', true);
  });

  it('shows the reconnecting banner only while retrying', async () => {
    const { rerender } = await renderCanvas(fakeServer());
    expect(screen.queryByText(/reconnecting/)).toBeNull();

    rerender(<GameCanvas server={fakeServer()} connection="retrying" opponentHere={false} />);
    expect(screen.getByText(/reconnecting/)).toBeTruthy();
  });

  it('shows the server reason when a command is refused', async () => {
    const server = fakeServer({
      submit: vi.fn(async () => ({ ok: false as const, reason: 'that unit has already acted' })),
    });
    await renderCanvas(server);

    fireEvent.click(screen.getByRole('button', { name: 'End Turn' }));
    expect(await screen.findByText(/that unit has already acted/)).toBeTruthy();
  });

  it('submits an endTurn when the button is pressed', async () => {
    const server = fakeServer();
    await renderCanvas(server);
    fireEvent.click(screen.getByRole('button', { name: 'End Turn' }));
    expect(server.submit).toHaveBeenCalledWith({ type: 'endTurn' });
  });

  // The renderer is built once for a canvas and torn down with it; leaving it
  // alive would keep a WebGL context and a render loop running per navigation.
  it('builds a renderer on mount and disposes it on unmount', async () => {
    const { unmount } = await renderCanvas(fakeServer());
    expect(createGameRenderer).toHaveBeenCalledTimes(1);
    unmount();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  // Seats deploy in order, the first on the near edge; hot-seat holds both.
  it('starts the camera behind your own army in a shared game, and only there', async () => {
    for (const [you, viewFrom] of [
      [[2], 'far'],
      [[1], 'near'],
      [[1, 2], 'near'],
    ] as const) {
      vi.mocked(createGameRenderer).mockClear();
      const { unmount } = await renderCanvas(fakeServer({ you }));
      expect(vi.mocked(createGameRenderer).mock.lastCall?.[2]).toBe(viewFrom);
      unmount();
    }
  });

  // A browser check reaches tiles through this; Vitest runs as a dev build.
  it('offers the dev tile handle while the renderer is up', async () => {
    const { unmount } = await renderCanvas(fakeServer());
    expect(window.__board?.tileToScreen({ col: 1, row: 2 })).toEqual({ x: 10, y: 20 });
    expect(renderer.tileToScreen).toHaveBeenCalledWith({ col: 1, row: 2 });
    unmount();
    expect(window.__board).toBeUndefined();
  });

  // The mirror of MatchRoute's late-connect case: models load asynchronously,
  // so a canvas can unmount while its renderer is still being built. The
  // renderer that arrives afterwards has to be disposed rather than stored, or
  // its engine keeps rendering into a canvas nobody is showing.
  it('disposes a renderer that finishes building after unmount', async () => {
    const { unmount } = render(
      <GameCanvas server={fakeServer()} connection="connected" opponentHere={false} />,
    );
    unmount();
    expect(renderer.dispose).not.toHaveBeenCalled();

    await act(async () => {}); // the build resolves now, into a dead component
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.onTileClick).not.toHaveBeenCalled();
  });

  // The click handler is registered with the renderer, so a tile click has to
  // reach the session through it rather than through any React event.
  // The renderer ref is nulled on unmount, and that is load-bearing rather than
  // tidiness: a queue task parked on an animation resolves after teardown and
  // then calls onSnap, which would otherwise reach a disposed scene.
  it('does not touch a disposed renderer when a batch lands after unmount', async () => {
    let push!: (events: GameEvent[], state: GameState) => void;
    const server = fakeServer({
      subscribe: vi.fn((onUpdate) => {
        push = onUpdate;
        return () => {};
      }),
    });
    const { unmount } = await renderCanvas(server);

    let finish!: () => void;
    vi.mocked(renderer.playEvents).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );

    const moved: GameEvent = {
      type: 'unitMoved',
      unitId: 'b1',
      facing: 'north',
      path: [
        { col: 1, row: 1 },
        { col: 1, row: 2 },
      ],
    };
    await act(async () => push([moved], board)); // the task parks on playEvents
    unmount();
    vi.mocked(renderer.syncUnits).mockClear();

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(renderer.syncUnits).not.toHaveBeenCalled();
  });

  it('routes a tile click into a selection push', async () => {
    await renderCanvas(fakeServer());
    expect(renderer.onTileClick).toHaveBeenCalled();

    // Selection is React state now, so the projection lands on the effect that
    // follows the commit rather than inside the click.
    await act(async () => clickTile({ col: 1, row: 1 })); // the unit's own tile
    expect(renderer.setSelectedTile).toHaveBeenLastCalledWith({ col: 1, row: 1 });
    // ⚠️ Tiles, not the search. The renderer used to be handed the whole
    // `Movement` so it could answer hover itself; it is given what to light.
    expect(vi.mocked(renderer.setRange).mock.lastCall?.[0].length).toBeGreaterThan(0);
  });

  // The point of registering a stable wrapper: clickTile's identity changes
  // with every selection, and the renderer must not be torn down and rebuilt
  // each time one does.
  it('does not rebuild the renderer when the selection changes', async () => {
    await renderCanvas(fakeServer());
    await act(async () => clickTile({ col: 1, row: 1 }));
    await act(async () => clickTile({ col: 1, row: 1 }));
    await act(async () => clickTile({ col: 1, row: 1 }));

    expect(createGameRenderer).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).not.toHaveBeenCalled();
  });

  // ⚠️ The first click on a destination draws a route and moves nothing. That
  // is the whole point of the step: a route that is state renders the same on
  // a touchscreen, and the one computed under a pointer never did.
  it('pins a route without walking it, and keeps the unit highlighted', async () => {
    await renderCanvas(fakeServer());

    await act(async () => clickTile({ col: 1, row: 1 }));
    await act(async () => clickTile({ col: 1, row: 3 }));

    expect(renderer.previewMove).not.toHaveBeenCalled();
    expect(vi.mocked(renderer.setRoute).mock.lastCall?.[0]).toEqual([
      { col: 1, row: 1 },
      { col: 1, row: 2 },
      { col: 1, row: 3 },
    ]);
    // The unit has not moved, so the highlight must not claim it has -- and
    // the range stays up, because the pin can still be moved.
    expect(renderer.setSelectedTile).toHaveBeenLastCalledWith({ col: 1, row: 1 });
    expect(vi.mocked(renderer.setRange).mock.lastCall?.[0].length).toBeGreaterThan(0);
    expect(screen.getByText(/click again to confirm/i)).toBeTruthy();
  });

  // Every reachable tile stays live while a route is pinned, so changing your
  // mind costs one click rather than a cancel and a reselect.
  it('re-pins to another reachable tile without walking', async () => {
    await renderCanvas(fakeServer());

    await act(async () => clickTile({ col: 1, row: 1 }));
    await act(async () => clickTile({ col: 1, row: 3 }));
    await act(async () => clickTile({ col: 3, row: 1 }));

    expect(renderer.previewMove).not.toHaveBeenCalled();
    expect(vi.mocked(renderer.setRoute).mock.lastCall?.[0].at(-1)).toEqual({ col: 3, row: 1 });
  });

  // The menu is present but inert until the unit arrives: confirming mid-walk
  // would leave the mesh short of the destination, and the committed move
  // would then replay from wherever it had got to.
  // ⚠️ The menu is tiles now, so "shut" means unlit rather than disabled: an
  // inert lit tile invites a click that does nothing.
  it('holds the panel back until the confirmed unit arrives', async () => {
    let arrive!: () => void;
    vi.mocked(renderer.previewMove).mockReturnValue(
      new Promise<void>((resolve) => {
        arrive = resolve;
      }),
    );
    await renderCanvas(contested());

    await act(async () => clickTile({ col: 1, row: 1 }));
    await act(async () => clickTile({ col: 1, row: 3 })); // pins
    await act(async () => clickTile({ col: 1, row: 3 })); // confirms

    expect(renderer.previewMove).toHaveBeenCalled();
    // Still walking: the range is the context, and no directions are offered.
    expect(lastOverlay()?.[0]).toBeNull();
    expect(vi.mocked(renderer.setRange).mock.lastCall?.[0].length).toBeGreaterThan(0);
    expect(screen.queryByText('Hold')).toBeNull();
    // And the pane is down, because it invites a click that is refused now.
    expect(screen.queryByText(/click again to confirm/i)).toBeNull();

    await act(async () => arrive());
    // ⚠️ The panel, and still nothing lit. Arrival offers a choice of
    // *questions*, not of tiles -- so the overlays stay clear until one is
    // picked, and the buttons are the only affordance.
    expect(screen.getByText('Hold')).toBeTruthy();
    expect(lastOverlay()?.[0]).toBeNull();
    expect(renderer.setRange).toHaveBeenLastCalledWith([]);
    expect(renderer.setRoute).toHaveBeenLastCalledWith([]);

    // ⚠️ The four tiles themselves, not the centre they surround, and only once
    // Hold is chosen. The renderer used to derive them, which hid the clipping
    // rule somewhere untestable.
    await act(async () => screen.getByText('Hold').click());
    expect(lastOverlay()?.[0]).toBe('facing');
    expect(lastOverlay()?.[1]).toEqual(
      expect.arrayContaining([
        { col: 1, row: 4 },
        { col: 1, row: 2 },
        { col: 2, row: 3 },
        { col: 0, row: 3 },
      ]),
    );
  });

  // ⚠️ The other half of omitting: the row appears the moment there is anything
  // to attack. Both sides are asserted because a menu that never offers Attack
  // and a menu that always does are equally wrong and look the same from one
  // test.
  it('offers the rows the rules allow and omits the rest', async () => {
    const contested = makeState(REACH + 3, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 1 + REACH, owner: 'red' }, // in reach from where it stands
    ]);
    await renderCanvas(
      fakeServer({
        getState: () => contested,
        subscribe: vi.fn((onUpdate) => {
          onUpdate([], contested);
          return () => {};
        }),
      }),
    );

    // ⚠️ Opened in place rather than walked forward: stepping to (1,2) would put
    // the unit *next* to the enemy, and then a charge is available too, which is
    // the opposite of what this is checking.
    await act(async () => clickTile({ col: 1, row: 1 }));
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.getByText('Hold')).toBeTruthy();
    // ⚠️ **Charge is omitted rather than greyed**, following AW — the enemy is
    // two tiles off, which a shot reaches and a charge does not. This is the
    // only place an omission is still observable: on a board with *nothing* to
    // attack the panel has one row and is skipped entirely, so no menu is left
    // to inspect for an absence.
    expect(screen.queryByText('Charge')).toBeNull();
  });

  // ⚠️ **Move is offered only before a walk.** On the panel opened where the unit
  // stands it is the way to move instead; after a walk the move has been made,
  // and the dark click that un-walks it is the way back.
  it('offers Move until the unit has walked, and Move returns to the movement selection', async () => {
    const contested = makeState(REACH + 3, [
      { id: 'b1', col: 1, row: 1 },
      { id: 'r1', col: 1, row: 1 + REACH, owner: 'red' }, // in reach from where it stands
    ]);
    await renderCanvas(
      fakeServer({
        getState: () => contested,
        subscribe: vi.fn((onUpdate) => {
          onUpdate([], contested);
          return () => {};
        }),
      }),
    );

    await act(async () => clickTile({ col: 1, row: 1 })); // opens the panel in place
    await act(async () => screen.getByText('Move').click());
    expect(screen.queryByText('Hold')).toBeNull();
    expect(vi.mocked(renderer.setRange).mock.lastCall?.[0].length).toBeGreaterThan(0);

    await act(async () => clickTile({ col: 1, row: 2 })); // pins
    await act(async () => clickTile({ col: 1, row: 2 })); // confirms
    expect(screen.getByText('Attack')).toBeTruthy();
    expect(screen.queryByText('Move')).toBeNull();
  });

  // An enemy's attack band, then its reach, then nothing -- each with its own
  // hint, and the board never offering a pane, a menu or a reason to block the
  // turn from ending.
  it('inspects an enemy: its band, then its reach, then nothing', async () => {
    await renderCanvas(contested());

    await act(async () => clickTile(ENEMY));
    expect(lastOverlay()?.[0]).toBe('attack');
    expect(lastOverlay()?.[1].length).toBeGreaterThan(0);
    expect(renderer.setSelectedTile).toHaveBeenLastCalledWith(ENEMY);
    expect(renderer.setRange).toHaveBeenLastCalledWith([]);
    expect(screen.getByText(/what it can attack/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', false);
    expect(screen.queryByText('Hold')).toBeNull();
    expect(screen.queryByText(/click again to confirm/i)).toBeNull();

    await act(async () => clickTile(ENEMY));
    expect(lastOverlay()).toEqual([null, []]);
    expect(vi.mocked(renderer.setRange).mock.lastCall?.[0].length).toBeGreaterThan(0);
    expect(screen.getByText(/where it can move/i)).toBeTruthy();

    await act(async () => clickTile(ENEMY));
    expect(lastOverlay()).toEqual([null, []]);
    expect(renderer.setRange).toHaveBeenLastCalledWith([]);
    expect(renderer.setSelectedTile).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText(/where it can move/i)).toBeNull();
  });

  // ⚠️ **Exactly one overlay is lit, and the mode is what guarantees it.** With
  // three attack-ish sets now -- the attack band, the charge targets, the
  // facing tiles -- "they never coincide" stops being obvious by inspection, and
  // a second lit set would read as a board offering two questions at once.
  it('lights one tile set per mode and clears the others', async () => {
    const contested = makeState(5, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 5 },
    ]);
    const serve = () =>
      fakeServer({
        getState: () => contested,
        subscribe: vi.fn((onUpdate) => {
          onUpdate([], contested);
          return () => {};
        }),
      });
    await renderCanvas(serve());

    await act(async () => clickTile({ col: 1, row: 1 })); // opens the panel in place

    await act(async () => screen.getByText('Charge').click());
    expect(lastOverlay()).toEqual(['charge', [{ col: 1, row: 2 }]]);

    // And back the other way, so the mode is genuinely read and not a constant.
    await act(async () => clickTile({ col: 4, row: 4 })); // dark: back to the panel
    await act(async () => screen.getByText('Attack').click());
    expect(lastOverlay()?.[0]).toBe('attack');
    expect(lastOverlay()?.[1].length).toBeGreaterThan(0);
  });

  // A pinned charge quotes its odds where a pinned attack quotes its damage.
  it('quotes the odds once a charge is pinned', async () => {
    const contested = makeState(5, [
      { id: 'b1', col: 1, row: 1, unitTypeId: 'cavalry', chargeMeter: fullMeter('cavalry') },
      { id: 'r1', col: 1, row: 2, owner: 'red', health: 5 },
    ]);
    await renderCanvas(
      fakeServer({
        getState: () => contested,
        subscribe: vi.fn((onUpdate) => {
          onUpdate([], contested);
          return () => {};
        }),
      }),
    );

    await act(async () => clickTile({ col: 1, row: 1 })); // opens the panel in place
    await act(async () => screen.getByText('Charge').click());
    await act(async () => clickTile({ col: 1, row: 2 })); // pins the target
    expect(screen.getByText(/% to break/)).toBeTruthy();
    expect(screen.queryByText(/damage/)).toBeNull();

    await act(async () => clickTile({ col: 4, row: 4 })); // dark: back to the panel
    await act(async () => screen.getByText('Attack').click());
    await act(async () => clickTile({ col: 1, row: 2 }));
    expect(screen.getByText(/damage/)).toBeTruthy();
  });

  // ⚠️ **The half of the cutaway that can be tested.** The staged models are
  // Babylon and this renderer has no unit coverage at all; what is testable is
  // the readout it hands up — which is also where the numbers a player actually
  // reads come from.
  describe('the cutaway readout', () => {
    const scene: CutawayScene = {
      id: 1,
      kind: 'attack',
      attacker: {
        unitTypeId: 'cavalry' as const,
        color: 'blue' as const,
        before: 100,
        after: 86,
        defense: 0,
        hit: 0,
      },
      defender: {
        unitTypeId: 'infantry' as const,
        color: 'red' as const,
        before: 60,
        after: 27,
        defense: 2,
        hit: 0,
      },
      rect: { left: 100, top: 50, width: 410, height: 200 },
    };
    const raise = async (next: CutawayScene | null) => {
      const handler = vi.mocked(renderer.onCutaway).mock.calls[0]?.[0];
      if (!handler) throw new Error('nothing subscribed to onCutaway');
      await act(async () => handler(next));
      // A tick as well, for a bar whose blow lands at once: its timer is only
      // set once the render above has committed.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    };

    it('shows nothing until a battle raises one', async () => {
      await renderCanvas(fakeServer());
      expect(screen.queryByText('infantry')).toBeNull();
    });

    // ⚠️ **The before-value, not the after, until the blow lands.** A bar
    // mounted at its destination has nothing to count down from, and one that
    // fell as the cutaway opened would fall before the first shot -- which is
    // the whole reason the renderer keeps what it last drew, and the plan says
    // when each side is hit.
    it('opens at the health each unit had, and holds it until its blow lands', async () => {
      const later = { hit: 60_000 };
      await renderCanvas(fakeServer());
      await raise({
        ...scene,
        attacker: { ...scene.attacker, ...later },
        defender: { ...scene.defender, ...later },
      });
      expect(screen.getByText('100')).toBeTruthy();
      expect(screen.getByText('60')).toBeTruthy();
    });

    it('counts down to what the battle left them at', async () => {
      await renderCanvas(fakeServer());
      await raise(scene);
      expect(screen.getByText('86')).toBeTruthy();
      expect(screen.getByText('27')).toBeTruthy();
    });

    // ⚠️ The number the player is actually judging: what the exchange *cost*,
    // which neither health alone says.
    it('shows what each side lost', async () => {
      await renderCanvas(fakeServer());
      await raise(scene);
      expect(screen.getByText('−14')).toBeTruthy();
      expect(screen.getByText('−33')).toBeTruthy();
    });

    // ⚠️ A side that took nothing shows no figure at all, rather than `−0` — and
    // an unanswered shot is the common case, so this is most battles. Asserted
    // by counting: the defender's figure is still there, and only it.
    it('says nothing for the side that took no damage', async () => {
      await renderCanvas(fakeServer());
      await raise({ ...scene, attacker: { ...scene.attacker, after: scene.attacker.before } });
      const losses = screen.queryAllByText(/^−/);
      expect(losses).toHaveLength(1);
      expect(losses[0].textContent).toBe('−33');
      expect(screen.getByText('100')).toBeTruthy();
    });

    it('names the kind, so a charge does not read as an attack', async () => {
      await renderCanvas(fakeServer());
      await raise({ ...scene, kind: 'charge' });
      expect(screen.getByText('charge')).toBeTruthy();
    });

    // Terrain's contribution is shown because it is part of why the numbers came
    // out as they did, and it is the same `defense` the formula read.
    it('shows the defender’s cover and not the attacker’s bare ground', async () => {
      await renderCanvas(fakeServer());
      await raise(scene);
      expect(screen.getByText(/★★/)).toBeTruthy();
    });

    it('comes down when the battle ends', async () => {
      await renderCanvas(fakeServer());
      await raise(scene);
      await raise(null);
      expect(screen.queryByText('cavalry')).toBeNull();
    });
  });

  it('clears the overlays when the selection is dropped', async () => {
    await renderCanvas(fakeServer());
    await act(async () => clickTile({ col: 1, row: 1 })); // select
    await act(async () => clickTile({ col: 4, row: 4 })); // dead click, out of range
    expect(renderer.setSelectedTile).toHaveBeenLastCalledWith(null);
    expect(renderer.setRange).toHaveBeenLastCalledWith([]);
    expect(renderer.setRoute).toHaveBeenLastCalledWith([]);
  });

  // The menu is DOM like every other control -- the canvas draws the game and
  // nothing else -- so it is here rather than in the renderer.
  // ⚠️ No buttons left for a pinned destination at all -- every answer is a
  // tile. End Turn is the only thing the pin still reaches into the DOM for.
  it('locks End Turn while a destination is pinned, and frees it on cancel', async () => {
    // A board with a tile past the catalog's reach to back out onto.
    const beyond = { col: 1, row: 2 + getUnitType('infantry').movementRange };
    await renderCanvas(serving(makeState(beyond.row + 1, [{ id: 'b1', col: 1, row: 1 }])));
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', false);

    await act(async () => clickTile({ col: 1, row: 1 })); // select
    await act(async () => clickTile({ col: 1, row: 3 })); // pin
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', true);

    await act(async () => clickTile(beyond)); // neither: back out
    expect(screen.getByRole('button', { name: 'End Turn' })).toHaveProperty('disabled', false);
  });

  // ⚠️ **Nothing is ever silent and nothing ever describes another mode's
  // clicks.** The pane belongs to movement selection, the panel's buttons to
  // the moment of choosing, and one hint line to each mode after that. They
  // hand over rather than overlap, which is the property worth pinning: a lit
  // board with no explanation, or an explanation of a click that is not
  // available, are the two ways this goes wrong.
  it('hands the pane to the panel, and the panel to a per-mode hint', async () => {
    await renderCanvas(contested());
    await act(async () => clickTile({ col: 1, row: 1 }));
    expect(screen.queryByText(/click again to confirm/i)).toBeNull();

    await act(async () => clickTile({ col: 1, row: 3 })); // pins
    expect(screen.getByText(/click again to confirm/i)).toBeTruthy();
    expect(screen.queryByText('Hold')).toBeNull();

    await act(async () => clickTile({ col: 1, row: 3 })); // confirms
    expect(screen.getByText('Hold')).toBeTruthy();
    expect(screen.queryByText(/click again to confirm/i)).toBeNull();
    // ⚠️ The panel's own hint, not a mode's: at the panel no tile does anything
    // but back out.
    expect(screen.getByText(/click elsewhere to go back/i)).toBeTruthy();
    expect(screen.queryByText(/click a tile beside the unit/i)).toBeNull();

    await act(async () => screen.getByText('Hold').click());
    expect(screen.getByText(/click a tile beside the unit/i)).toBeTruthy();
    expect(screen.queryByText('Hold')).toBeNull();
  });
});
