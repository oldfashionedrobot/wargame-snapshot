import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { MapSummary } from '@wargame/shared';
import { api } from '../net/api';
import { createGameRenderer } from '../game/render/renderer';
import type { GameRenderer } from '../game/render/renderer';
import { mapLabel } from './mapLabel';

/**
 * A board, with nobody playing on it.
 *
 * ⚠️ **It builds the real renderer on a real `GameState`**, rather than a
 * lighter terrain-only path of its own. A second way to draw a board is a second
 * thing to keep in step with `composeTerrain`, and it would be the copy nobody
 * notices has gone stale -- this page is looked at rarely and by one person.
 * What it costs is the unit models, which load anyway and are worth seeing here:
 * the deployment is half of what makes a map good or bad.
 *
 * ⚠️ **Nothing is wired for input.** `onTileClick` is never registered, so the
 * canvas orbits and zooms and answers nothing else. That is the whole difference
 * between this and `GameCanvas`, and it is an omission rather than a mode: there
 * is no selection state here to be in.
 */
export function MapViewer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [mapId, setMapId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list, once. ⚠️ Seeded straight into `mapId` so the select and the scene
  // start on the same map -- the same trap StartScreen's picker hit, where
  // leaving it unset agreed with the registry's first entry only by accident.
  useEffect(() => {
    let cancelled = false;
    api.maps
      .list()
      .then((available) => {
        if (cancelled) return;
        setMaps(available);
        setMapId(available[0]?.id ?? null);
        if (available.length === 0) setError('the server has no maps');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(message(cause, 'could not load the map list'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ⚠️ **One effect for fetch *and* build, because the teardown has to cover
  // both.** Split in two, the state would land in a `useState` and the renderer
  // would be built by a second effect watching it -- which means a map switched
  // twice in flight can resolve out of order and leave the scene showing the
  // first answer. Here the flag closes over both halves of one attempt.
  useEffect(() => {
    if (mapId === null) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    setError(null);

    void api.maps
      .preview(mapId)
      // The map alone: the preview's units are its starting deployment, which the
      // viewer does not draw.
      .then((preview) => createGameRenderer(canvas, { ...preview.state, units: [] }, 'near'))
      .then((renderer) => {
        // The same teardown race GameCanvas carries: construction is async
        // because unit models load first, so a renderer that arrives after the
        // switch has to be disposed rather than stored.
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(message(cause, 'could not load that map'));
      });

    return () => {
      disposed = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [mapId]);

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Maps</h1>

      <p>
        <Link to="/">← Back</Link>{' '}
        {maps.length > 0 && (
          <label>
            {' Showing '}
            <select value={mapId ?? ''} onChange={(event) => setMapId(event.target.value)}>
              {maps.map((map) => (
                <option key={map.id} value={map.id}>
                  {mapLabel(map)}
                </option>
              ))}
            </select>
          </label>
        )}
      </p>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {/* ⚠️ **Keyed on the map, so each scene gets its own element.** Babylon
          takes the canvas's WebGL context at construction and gives it up on
          `dispose`; building a second engine on the same element is a context
          that has been handed back and asked for again, which is a black canvas
          on some drivers and fine on others. A fresh element makes it neither.
          ⚠️ Sized in pixels rather than viewport units: the point of this page
          is comparing boards, and a view that fills the window puts the picker
          and the board on separate screens.
          ⚠️ **And roughly square, which is not a taste.** The camera fits the
          board at its worst case over every angle it may be turned to -- see
          `boardRadius` -- so the frustum is sized by the ground-plane
          *half-diagonal* whatever the aspect, and a wide box spends the surplus
          on background. Boards are square, so a square viewport wastes least:
          measured, the board goes from filling 44% of an 880x520 box to 68% of
          this one. */}
      <div
        style={{
          width: 'min(620px, 100%)',
          height: '580px',
          borderRadius: '6px',
          overflow: 'hidden',
          background: 'var(--board-void)',
        }}
      >
        <canvas
          key={mapId ?? 'empty'}
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        />
      </div>

      <p style={{ opacity: 0.7, fontSize: '13px' }}>
        Drag to orbit, scroll to zoom. Both armies are shown where a new match would deploy them.
      </p>
    </div>
  );
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
