import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  BANDS,
  getCurrentPlayer,
  holdsTheTurn,
  isOver,
  MAX_HEALTH,
  playerInSeat,
  seatOf,
} from '@wargame/shared';
import type { Coordinate, EndedBy, GameEvent, GameServer, GameState } from '@wargame/shared';
import { useGameSession } from './useGameSession';
import {
  attackForecast,
  availableActions,
  isTargetPinned,
  isPlan,
  destinationOf,
} from './interaction/selection';
import type {
  ActionKind,
  InspectView,
  MenuStep,
  Pinned,
  SelectionState,
} from './interaction/selection';
import type { ConnectionStatus } from '../net/gameServer';
import { BAND } from './render/band';
import { PLAYER_HEX } from './render/playerColors';
import { createGameRenderer } from './render/renderer';
import type {
  CutawayScene,
  CutawaySide as CutawaySideData,
  GameRenderer,
  StepOverlay,
} from './render/renderer';

declare global {
  interface Window {
    /**
     * Dev builds only: lets a browser check address a tile rather than guess a
     * pixel. Present once the board's renderer is ready.
     */
    __board?: Pick<GameRenderer, 'tileToScreen'>;
  }
}

// Pushes a selection to the renderer. Module-level so there's one place that
// knows how a selection is displayed -- attacking adds a third overlay here.
// A pure projection of the selection: everything it draws is on the snapshot,
// so there is no game state to fetch and no question of which copy to read.
// ⚠️ Takes `walking` as well as the selection, and has to: the route comes down
// on *confirm* rather than on arrival, so the walk is a visible state of its own
// that no phase records. Still pure, and still no game state fetched.
/**
 * What each step means to the board and to the reader: which overlay it lights,
 * and what the line under the canvas says while it is up.
 *
 * ⚠️ **One table, where this was four branches on the same discriminant.** The
 * three overlay setters each re-tested `step.kind`, and the hint line tested it
 * again in a nested ternary somewhere else entirely -- so "what a step means"
 * was knowledge a reader had to gather from four places and an author had to
 * remember to update in all of them. `Record<MenuStep['kind'], …>` also makes a
 * new step a compile error here rather than a step that silently lights nothing
 * and says nothing.
 *
 * ⚠️ At `choosing` *nothing* is lit, and that is deliberate rather than a gap:
 * the buttons are the whole affordance there, so a lit tile would promise a
 * choice that is not being offered yet. "Lit does something" survives by
 * nothing being lit, and its hint says what a dark click does instead.
 */
const STEP_UI: Record<MenuStep['kind'], { overlay: StepOverlay | null; hint: string }> = {
  choosing: { overlay: null, hint: 'Choose an action, or click elsewhere to go back.' },
  holding: {
    overlay: 'facing',
    hint: 'Click a tile beside the unit to face that way, or the unit to keep its facing.',
  },
  attacking: {
    overlay: 'attack',
    hint: 'Click an enemy in range, then click it again to attack. Click elsewhere to go back.',
  },
  charging: {
    overlay: 'charge',
    hint: 'Click an enemy beside the unit, then click again to charge. Click elsewhere to go back.',
  },
};

/**
 * What each inspection view lights and says, as `STEP_UI` does for the panel's
 * steps. The movement view's tiles go on the range overlay rather than a step
 * overlay, so it names none.
 *
 * ⚠️ **Both hints say a click clears**, because both tints mean something else
 * while a unit of your own is selected -- blue *move here*, red *click to
 * target* -- and here a click on them does neither.
 */
const INSPECT_UI: Record<InspectView, { overlay: StepOverlay | null; hint: string }> = {
  attack: {
    overlay: 'attack',
    hint: 'What it can attack from where it stands. Click it again for where it can move, or elsewhere to clear.',
  },
  movement: {
    overlay: null,
    hint: 'Where it can move. Click it again, or elsewhere, to clear.',
  },
};

/**
 * Is a drawn route still waiting to be confirmed?
 *
 * ⚠️ **One place, because it was two.** The rule lived in `showSelection` and
 * again in the component, spelled slightly differently both times, and it
 * governs three separate things -- the route, the confirm pane, and whether the
 * board is still lit. ⚠️ The route and the pane are one affordance (both say
 * *confirm this*), so both come down the instant it is confirmed and the ghost
 * walks over a clean board rather than retracing a line it has been handed.
 */
function isAwaitingConfirm(selection: SelectionState, walking: boolean): selection is Pinned {
  return selection.phase === 'routePinned' && !walking;
}

function showSelection(renderer: GameRenderer, selection: SelectionState, walking: boolean): void {
  const pinned = selection.phase === 'routePinned';

  // ⚠️ **Exactly one set is lit, and one call is what guarantees it.** These
  // were three independent setters with the rule in a comment above them, so
  // every update had to remember to clear the other two.
  const step = selection.phase === 'destinationChosen' ? selection.step : null;
  const inspected = selection.phase === 'inspecting' ? selection : null;
  const overlay = step
    ? STEP_UI[step.kind].overlay
    : inspected
      ? INSPECT_UI[inspected.view].overlay
      : null;
  renderer.setStepTiles(
    overlay,
    step && 'tiles' in step ? step.tiles : inspected && overlay ? inspected.tiles : [],
  );

  // ⚠️ The unit's own tile, never the pin. A pinned route has not been walked,
  // so highlighting its destination would claim the unit is somewhere it is
  // not; the route and the pane are what mark where it *would* go. Once it
  // arrives, its own tile is the destination and this needs no special case.
  const highlight =
    selection.phase === 'idle'
      ? null
      : selection.phase === 'unitSelected' || selection.phase === 'inspecting'
        ? selection.position
        : selection.path[pinned ? 0 : selection.path.length - 1];

  renderer.setSelectedTile(highlight);
  // The range stays lit for as long as the pin can still move -- which includes
  // the walk, since the phase only turns over on arrival -- and comes down as
  // the panel opens, so the handover reads as one moment rather than as a gap.
  //
  // ⚠️ `settled`, not `reachable`: the overlay is about *reach*, and a hole
  // punched in it where a friendly unit happens to stand reads as out of range
  // rather than as occupied. Not every lit tile is clickable, which is fine --
  // `handleTileClick` asks `reachable`, and a click on a friend selects it.
  //
  // An inspection's movement view lights the same overlay, from the same search.
  const ranged = selection.phase === 'unitSelected' || pinned;
  renderer.setRange(
    ranged ? selection.movement.settled : inspected?.view === 'movement' ? inspected.tiles : [],
  );
  renderer.setRoute(isAwaitingConfirm(selection, walking) ? selection.path : []);
}

/** One health band's width on the close-up's bar. */
const STRIPE = `${100 / BANDS}%`;

/**
 * One combatant's readout, printed over its staged view.
 *
 * ⚠️ **A full bar showing the true health, with the number beside it**, not the
 * board's bands. The ring is banded because it is a *glanceable* element where
 * its segments stop it over-promising precision the formula lacks; this is
 * a *focused* view where the exact figure is the point. ⚠️ The band lines are
 * still drawn on the bar, so the structure the formula reads stays visible
 * without the value being rounded to it.
 */
/**
 * One side's half of the cutaway, framed, its readout pinned to its foot: the
 * strip the camera keeps clear for it.
 */
const CUTAWAY_PANEL = {
  flex: 1,
  position: 'relative',
  display: 'flex',
  alignItems: 'flex-end',
  paddingBottom: '8px',
  border: '4px solid var(--board-surface)',
  borderRadius: 'var(--board-radius)',
  boxShadow: 'inset 0 0 0 1px var(--board-edge)',
} as const;

function CutawaySide({ side, align }: { side: CutawaySideData; align: 'left' | 'right' }) {
  // ⚠️ **Mounted at the before-value, moved to the after one when its side's
  // blow lands** -- `hit`, the plan's own moment -- so the bar falls with the
  // figures rather than before the first shot. A bar mounted straight at its
  // destination would have nothing to transition from. ⚠️ The initial value
  // comes from `useState` rather than from an effect correcting it, which is why
  // the caller keys this on the battle: a component that persisted across
  // battles would have to reset synchronously inside an effect, and that is a
  // cascading render.
  const [shown, setShown] = useState(side.before);
  useEffect(() => {
    if (side.hit === null) return;
    const timer = setTimeout(() => setShown(side.after), side.hit);
    return () => clearTimeout(timer);
  }, [side.after, side.hit]);

  return (
    <div style={{ flex: 1, padding: '0 24px', textAlign: align, alignSelf: 'flex-end' }}>
      <div style={{ fontSize: '13px', opacity: 0.85, marginBottom: '4px' }}>
        {side.unitTypeId}
        {side.defense > 0 && ` · ${'★'.repeat(side.defense)}`}
      </div>
      <div
        style={{
          position: 'relative',
          height: '12px',
          borderRadius: '2px',
          background: 'var(--board-track)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${(100 * shown) / MAX_HEALTH}%`,
            height: '100%',
            background: PLAYER_HEX[side.color],
            transition: 'width 700ms ease-out',
          }}
        />
        {/* The bands the damage formula actually reads, drawn over the bar. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `repeating-linear-gradient(to right, transparent 0 calc(${STRIPE} - 1px), rgba(0,0,0,0.5) calc(${STRIPE} - 1px) ${STRIPE})`,
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '15px',
          marginTop: '4px',
        }}
      >
        <span>{shown}</span>
        {/* ⚠️ **Shown only once the bar starts falling, and only if it falls.**
            Tying it to the same value the bar animates means the number and the
            movement arrive together rather than the figure being announced
            before anything happens — and a side that took nothing never renders
            a `−0`, because `shown` never leaves `before`. */}
        {shown !== side.before && (
          <span style={{ color: 'var(--board-damage)' }}>−{side.before - side.after}</span>
        )}
      </div>
    </div>
  );
}

/** ⚠️ Beside the list rather than inside it: the words are presentation and the
    modes are not, so a renamed row cannot change what a click does. */
const ACTION_LABEL: Record<ActionKind, string> = {
  attacking: 'Attack',
  charging: 'Charge',
  holding: 'Hold',
};

/**
 * One row of the action panel.
 *
 * ⚠️ **A button and a class, where this was a component with state.** Hover is
 * the only state a row has -- there is no disabled row, since an unavailable
 * action is omitted -- and expressing it as `useState` meant a React render on
 * every pointer move across the menu. `:hover` is what that is for.
 */
function MenuItem({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="board-menu-item" onClick={onClick}>
      {label}
    </button>
  );
}

/** How often a running clock is redrawn: often enough that a second never sticks. */
const CLOCK_REDRAW_MS = 250;

/**
 * Each side's time, the mover's counting down from the server's last report.
 * ⚠️ **Display only**: when it reaches nothing, the next poll brings the
 * ending, and nothing here decides it. The authoritative state says who is
 * moving, read at the same moment as the reading it is counted from.
 */
function ChessClocks({ server }: { server: GameServer }) {
  const reading = server.getClocks();
  const [now, setNow] = useState(() => Date.now());
  const state = server.getState();
  const running = reading && !isOver(state) ? seatOf(state, state.currentTurn) : null;

  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => setNow(Date.now()), CLOCK_REDRAW_MS);
    return () => clearInterval(timer);
  }, [running, reading]);

  if (!reading) return null;
  return (
    <span>
      {state.players.map((player, index) => {
        const stored = reading.remaining[index] ?? 0;
        // Never more than reported: `now` is the last redraw's, and can be
        // older than a reading that has just arrived.
        const ms =
          index + 1 === running
            ? Math.max(0, Math.min(stored, stored - (now - reading.at)))
            : stored;
        return (
          <span key={player.id} style={{ fontWeight: index + 1 === running ? 'bold' : undefined }}>
            {player.name} {formatClock(ms)} ·{' '}
          </span>
        );
      })}
    </span>
  );
}

/** Minutes and seconds, a part-second rounded up, so a clock shows 0:00 only once it is out. */
function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Who won and how, said to whoever is reading: *You won* in a game shared with
 * somebody, and the winning side's name in hot-seat, where both sides are
 * yours. A win on the board needs no saying how.
 */
function endLine(state: GameState, you: readonly number[], endedBy: EndedBy | null): string {
  const winner = state.players.find((player) => player.id === state.winner);
  const loser = state.players.find((player) => player.id !== state.winner);
  if (!winner || !loser) return 'game over';
  const shared = you.length < state.players.length;
  const won = you.includes(seatOf(state, winner.id) ?? 0);
  const head = shared ? (won ? 'You won' : 'You lost') : `${winner.name} wins`;
  const who = shared ? (won ? 'your opponent' : 'you') : loser.name;
  const how =
    endedBy === 'surrender'
      ? `${who} surrendered`
      : endedBy === 'clock'
        ? `${who} ran out of time`
        : null;
  return how ? `${head} — ${how}` : head;
}

export interface GameCanvasProps {
  server: GameServer;
  connection: ConnectionStatus;
  /** Whether the other side has been heard from lately; unused in hot-seat. */
  opponentHere: boolean;
}

// The canvas half: a canvas ref, the renderer lifecycle, and how to draw a
// selection. Everything else about playing a match lives in useGameSession.
export function GameCanvas({ server, connection, opponentHere }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  // ⚠️ Three things can be anchored over a tile and only one is ever up, which
  // is why `anchorTo` taking a single element is still enough: the pane while a
  // route waits to be confirmed, the menu while the intent is being chosen, and
  // the forecast while a target is pinned. The modes are what make that true.
  const confirmPaneRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const forecastRef = useRef<HTMLDivElement>(null);

  // Both callbacks read the ref at call time, never capture the renderer: a
  // queue task parked on an animation resolves after this canvas unmounted, and
  // must find null rather than a disposed renderer. Tested by mutation.
  const onEvents = useCallback(
    (events: GameEvent[]): Promise<void> =>
      rendererRef.current?.playEvents(events) ?? Promise.resolve(),
    [],
  );

  const onSnap = useCallback((state: GameState): void => {
    rendererRef.current?.syncUnits(state);
  }, []);

  const onPreview = useCallback(
    (next: { unitId: string; path: Coordinate[] } | null): Promise<void> => {
      const renderer = rendererRef.current;
      if (!renderer) return Promise.resolve();
      if (!next) {
        renderer.cancelPreview();
        return Promise.resolve();
      }
      return renderer.previewMove(next.unitId, next.path);
    },
    [],
  );

  const {
    gameState,
    rejection,
    selection,
    walking,
    clickTile,
    chooseAction,
    chooseMove,
    endTurn,
    surrender,
  } = useGameSession(server, {
    onEvents,
    onSnap,
    onPreview,
  });
  // ⚠️ Asked on the page rather than through `window.confirm`, which a
  // portal's sandboxed iframe can refuse.
  const [confirmingSurrender, setConfirmingSurrender] = useState(false);

  // Either kind of plan: a route drawn, or a unit standing at the end of one.
  // Both are uncommitted, and End Turn has no business submitting around them.
  // Every kind of uncommitted plan, asked rather than listed -- a fourth phase
  // would otherwise have to be remembered here too.
  const planning = isPlan(selection);

  // ⚠️ **Two questions, and the rule is the first one.** `isOver` decides whether
  // the game is finished; `endLine`'s lookup only decides what to *call* the winner. Key
  // the rule off the lookup instead and a `winner` naming somebody outside
  // `players` would leave the board showing a live turn label and an enabled
  // button for a finished game -- unreachable today, since `victor` picks
  // from `players`, and exactly the sort of thing that stops being unreachable
  // quietly.
  //
  // The name is resolved because the board has always named players by their
  // display name; the lobby shows the raw id, having no roster to resolve
  // against.
  const over = isOver(gameState);
  const yourTurn = holdsTheTurn(gameState, server.you);
  // ⚠️ Only in a game shared with somebody: hot-seat holds every seat, and
  // there it is always your turn, whichever army is to move.
  const yourArmy =
    server.you.length < gameState.players.length ? playerInSeat(gameState, server.you[0]) : null;

  // ⚠️ Only while the route is still a plan, and not while it is being walked:
  // the pane invites a click, and clicks are refused until the mesh arrives.
  const awaitingConfirm = isAwaitingConfirm(selection, walking);

  // The panel is the same DOM-over-canvas trick as the confirm pane, anchored
  // over the target instead of the destination. Only one is ever up, which is
  // why `anchorTo` taking a single element is enough.
  // The panel is up when the unit has arrived and has not yet been told what
  // to do. It is the only affordance in that moment: no tile is lit.
  // What the cutaway is showing, or null between battles. ⚠️ Pushed by the
  // renderer rather than derived here: the *before* healths live in what it last
  // drew, and nothing above it has them once the batch has been folded.
  const [cutaway, setCutaway] = useState<CutawayScene | null>(null);

  const menuOpen = selection.phase === 'destinationChosen' && selection.step.kind === 'choosing';
  // The same table the overlays come from, so a step's tiles and its
  // instruction cannot describe two different things.
  const hint =
    selection.phase === 'destinationChosen'
      ? STEP_UI[selection.step.kind].hint
      : selection.phase === 'inspecting'
        ? INSPECT_UI[selection.view].hint
        : null;
  const aiming = isTargetPinned(selection) ? selection : null;
  const forecast = aiming ? attackForecast(server.getState(), aiming) : null;

  // `clickTile` changes identity whenever the selection does, and the renderer
  // is registered with it exactly once. A stable wrapper over a latest-ref
  // keeps the registered function fixed, so a click never rebuilds the scene.
  // Splitting registration into its own effect does not work: construction is
  // async, so that effect would run while the ref is still null and nothing
  // would re-run it when the renderer arrives.
  const clickTileRef = useRef(clickTile);
  useEffect(() => {
    clickTileRef.current = clickTile;
  });

  // Construction is async because unit models are loaded before any unit
  // exists, so this carries the same teardown race MatchRoute's connect does:
  // a renderer that finishes building after unmount has to be disposed rather
  // than stored, or its engine keeps running against a detached canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;

    // ⚠️ **A player of a shared game starts behind their own army.** Seats deploy
    // in order, the first on the near edge, so only the second looks from the
    // far one; hot-seat holds both and keeps the near view.
    const shared = server.you.length < server.getState().players.length;
    const viewFrom = shared && server.you[0] !== 1 ? 'far' : 'near';
    void createGameRenderer(canvas, server.getState(), viewFrom).then((renderer) => {
      if (disposed) {
        renderer.dispose();
        return;
      }
      rendererRef.current = renderer;
      renderer.onTileClick((coordinate) => clickTileRef.current(coordinate));
      renderer.onCutaway(setCutaway);
      // ⚠️ Installed here rather than by the renderer: StrictMode builds two in
      // dev, and the stale one could overwrite the handle or delete it.
      if (import.meta.env.DEV) {
        window.__board = {
          tileToScreen: (coordinate) => rendererRef.current?.tileToScreen(coordinate) ?? null,
        };
      }
    });

    return () => {
      disposed = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      if (import.meta.env.DEV) delete window.__board;
    };
  }, [server]);

  // Selection reaches the renderer as a projection of state rather than a
  // callback, which is what lets the hook stop knowing anything about it.
  // Nothing to draw before the renderer exists: a selection can only come from
  // a click, and clicks arrive through the renderer.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer) showSelection(renderer, selection, walking);
  }, [selection, walking]);

  // The pane rides the board rather than the page: React writes what it says,
  // the renderer writes where it is. Cleared by the same call that sets it, so
  // an unpinned plan never leaves an element tracking a tile nobody chose.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (aiming) {
      renderer.anchorTo(forecastRef.current, aiming.step.target.position);
      return;
    }
    if (menuOpen) {
      renderer.anchorTo(menuRef.current, destinationOf(selection));
      return;
    }
    renderer.anchorTo(
      awaitingConfirm ? confirmPaneRef.current : null,
      awaitingConfirm ? destinationOf(selection) : null,
    );
  }, [awaitingConfirm, aiming, menuOpen, selection]);

  return (
    <div>
      {/* Positioned so the confirm pane has an origin to be offset from -- the
          renderer projects into the canvas's own pixel space. ⚠️ `overflow`
          because `Vector3.Project` does not clip: a pinned tile that zoom has
          pushed off screen projects outside this box, and an absolute child
          out there would add page scrollbars. */}
      <div style={{ position: 'relative', width: '100%', height: '90vh', overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        />
        {/* Mounted only while it applies. ⚠️ React populates refs during the
            commit, *before* effects run, so the anchor effect below still finds
            this element on the render that introduces it -- and finds null on
            the one that removes it, which is exactly the clear.
            `pointerEvents: none` because the tile underneath is the button: a
            pane that swallowed the click would block its own confirmation. */}
        {/* ⚠️ The panel, and the one place in the game with real buttons. Every
            other answer is a tile, which is why `clickTile` and `endTurn` were
            the only verbs until now -- a preview with numbers in it cannot be a
            tile, and Hold cannot be one either, since the only tile that faces
            an enemy is the one they are standing on. */}
        {/* ⚠️ **Full-canvas and it eats pointer events**, which is not decoration:
            a click during a cutaway is read against authoritative state the
            board is not yet showing, so it would act on a position the player
            cannot see. Swallowing it here costs one property and needs no flag
            threaded up from the renderer. */}
        {cutaway && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              color: 'var(--board-ink)',
              textShadow: '0 1px 3px rgba(0, 0, 0, 0.8)',
              pointerEvents: 'auto',
            }}
          >
            {/* ⚠️ **Two panels, as two shots side by side**, though one camera
                draws both: a modal over the board, each side's half framed and
                a solid divider over the seam, placed where the renderer says
                the band is -- the box its camera draws into. */}
            <div
              style={{
                position: 'absolute',
                left: cutaway.rect.left,
                top: cutaway.rect.top,
                width: cutaway.rect.width,
                height: cutaway.rect.height,
                display: 'flex',
                boxShadow: 'var(--board-lift)',
              }}
            >
              <div style={CUTAWAY_PANEL}>
                <CutawaySide key={`a${cutaway.id}`} side={cutaway.attacker} align="left" />
              </div>
              <div style={{ width: BAND.divider, background: 'var(--board-surface)' }} />
              <div style={CUTAWAY_PANEL}>
                <CutawaySide key={`d${cutaway.id}`} side={cutaway.defender} align="right" />
              </div>
            </div>
            {/* What kind of battle, on a tab over the divider. */}
            <div
              style={{
                position: 'absolute',
                left: cutaway.rect.left + cutaway.rect.width / 2,
                top: cutaway.rect.top,
                transform: 'translate(-50%, -100%)',
                padding: '3px 12px',
                fontSize: '13px',
                background: 'var(--board-surface)',
                borderRadius: 'var(--board-radius) var(--board-radius) 0 0',
              }}
            >
              {cutaway.kind === 'charge' ? 'charge' : 'attack'}
            </div>
          </div>
        )}

        {menuOpen && (
          <div ref={menuRef} className="board-pane board-pane--menu">
            {/* ⚠️ **Offered only when there is something to attack**, following
                AW, which omits rather than greys. The cost is that "nothing is
                in range" and "I misread the menu" look the same; the gain is a
                menu with no dead rows, which is what makes it readable at a
                glance. Revisit if omitting reads badly in play.
                ⚠️ `canAttack` asks `refuseAttack`, the same rule the click will,
                so the button and the tile cannot disagree. */}
            {/* ⚠️ Rendered from the same list the arrival path counts, so a row
                the panel offers and a row the skip believes in cannot differ.
                Each entry is there because the rule that will answer the click
                said so -- `canCharge` asks `refuseCharge` -- rather than because
                a tile set happened to be non-empty. */}
            {/* ⚠️ Only while the unit has not walked. After a walk the move is
                chosen, and the dark click that un-walks it is the way back. */}
            {selection.path.length === 1 && <MenuItem label="Move" onClick={chooseMove} />}
            {availableActions(gameState, selection).map((kind) => (
              <MenuItem key={kind} label={ACTION_LABEL[kind]} onClick={() => chooseAction(kind)} />
            ))}
          </div>
        )}

        {aiming && forecast && (
          <div ref={forecastRef} className="board-pane board-pane--forecast">
            {/* ⚠️ Informational, with no button, like the route's confirm pane
                -- and for the same reason. Buttons pick intent; tiles pick
                targets. A second click on the target is what commits, which is
                the gesture the route already taught. */}
            {forecast.kind === 'attack' ? (
              <span>
                Attack — {forecast.low}
                {forecast.high > forecast.low && `–${forecast.high}`} damage
                {forecast.answered && ' · they counter attack'}
              </span>
            ) : (
              /* An exact figure where an attack gets a range: no roll enters `chance`. */
              <span>Charge — {forecast.chance}% to break</span>
            )}
            <span style={{ opacity: 0.75 }}>Click again to confirm</span>
          </div>
        )}

        {awaitingConfirm && (
          <div ref={confirmPaneRef} className="board-pane board-pane--quiet">
            Click again to confirm
          </div>
        )}
      </div>
      <div>
        {/* ⚠️ The winner is checked first and `getCurrentPlayer` is not called
            at all once there is one -- it throws when `currentTurn` names
            nobody, and this runs every render. Today `currentTurn` is never
            cleared so both would work; the ordering is what keeps that from
            being load-bearing. */}
        <ChessClocks server={server} />
        {yourArmy && (
          <span>
            You command {yourArmy.name}
            {!over && (opponentHere ? ', your opponent is here' : ', your opponent is away')} ·{' '}
          </span>
        )}
        {over ? (
          <strong>{endLine(gameState, server.you, server.getEndedBy())}</strong>
        ) : (
          <span>
            {yourArmy && yourTurn ? 'Your turn' : `${getCurrentPlayer(gameState).name}'s turn`}
          </span>
        )}{' '}
        {/* Disabled while anything is pinned: ending the turn there would
            submit around a plan the player has not answered for yet. And once
            the game is over, or while it is the other seat's turn: the server
            refuses both, so an enabled button would only produce a rejection. */}
        <button type="button" onClick={endTurn} disabled={planning || over || !yourTurn}>
          End Turn
        </button>{' '}
        {/* Either side, at any time: on the other's turn too. In hot-seat the
            side to move is the one giving up, so the question names it. */}
        {!over &&
          (confirmingSurrender ? (
            <span>
              {yourArmy
                ? 'Give up the game?'
                : `Give up the game for ${getCurrentPlayer(gameState).name}?`}{' '}
              <button
                type="button"
                onClick={() => {
                  setConfirmingSurrender(false);
                  surrender();
                }}
              >
                Surrender
              </button>{' '}
              <button type="button" onClick={() => setConfirmingSurrender(false)}>
                Keep playing
              </button>{' '}
            </span>
          ) : (
            <>
              <button type="button" onClick={() => setConfirmingSurrender(true)}>
                Surrender…
              </button>{' '}
            </>
          ))}
        {import.meta.env.DEV && (
          <button type="button" onClick={() => rendererRef.current?.toggleInspector()}>
            Toggle Inspector
          </button>
        )}
        {/* ⚠️ One line per mode, because a mode is exactly one question. The
            combined sentence this replaced had to describe three readings of a
            tile click at once, which is the thing the panel exists to stop. */}
        {hint && <span>{hint}</span>}
        {rejection && <span style={{ color: 'var(--danger)' }}> rejected: {rejection}</span>}
        {connection === 'retrying' && <span style={{ color: 'var(--warn)' }}> reconnecting…</span>}
      </div>
    </div>
  );
}
