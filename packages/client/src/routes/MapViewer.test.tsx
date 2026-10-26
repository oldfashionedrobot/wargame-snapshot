import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { MapPreview, MapSummary } from '@wargame/shared';
import { makeState } from '@wargame/shared/testing';
import type { GameRenderer } from '../game/render/renderer';
import { MapViewer } from './MapViewer';

// Two seams, because the page is two things: a picker over the map list, and a
// renderer built on whatever the server says that map looks like. Babylon wants
// WebGL that happy-dom does not have, so the renderer is mocked here exactly as
// it is in GameCanvas's suite.
vi.mock('../net/api', () => ({
  api: { maps: { list: vi.fn(), preview: vi.fn() } },
}));
vi.mock('../game/render/renderer', () => ({ createGameRenderer: vi.fn() }));

const { api } = await import('../net/api');
const { createGameRenderer } = await import('../game/render/renderer');
const mapList = vi.mocked(api.maps.list);
const preview = vi.mocked(api.maps.preview);
const build = vi.mocked(createGameRenderer);

const MAPS: MapSummary[] = [
  { id: 'classic', name: 'Bridgehead', width: 5, height: 5 },
  { id: 'meadow', name: 'Meadow', width: 7, height: 7 },
];

// ⚠️ A different board per map, so "it drew the one that was asked for" is
// observable rather than assumed -- two identical states would pass whichever
// arrived.
const previewOf = (id: string): MapPreview => ({
  id,
  name: MAPS.find((map) => map.id === id)!.name,
  state: makeState(id === 'classic' ? 5 : 7, [{ id: 'b1', col: 1, row: 1 }]),
});

const fakeRenderer = (): GameRenderer => ({ dispose: vi.fn() }) as unknown as GameRenderer;

beforeEach(() => {
  vi.clearAllMocks();
  mapList.mockResolvedValue(MAPS);
  preview.mockImplementation((id: string) => Promise.resolve(previewOf(id)));
  build.mockImplementation(() => Promise.resolve(fakeRenderer()));
});

const renderViewer = () =>
  render(
    <MemoryRouter initialEntries={['/maps']}>
      <MapViewer />
    </MemoryRouter>,
  );

/** The `GameState` the nth build was handed. */
const drewBoardOfWidth = (call: number): number => build.mock.calls[call][1].grid[0]?.length ?? 0;

describe('MapViewer', () => {
  it('offers every map the server lists', async () => {
    renderViewer();
    expect(await screen.findByRole('option', { name: 'Bridgehead · 5×5' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Meadow · 7×7' })).toBeTruthy();
  });

  // ⚠️ The select and the scene have to start on the *same* map. Leaving the
  // selection unset agrees with the registry's first entry only by accident,
  // which is the trap StartScreen's picker hit.
  it('draws the first map without being asked', async () => {
    renderViewer();
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith('classic');
    expect(drewBoardOfWidth(0)).toBe(5);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('classic');
  });

  it('rebuilds on the chosen map, and lets the old scene go', async () => {
    renderViewer();
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    const first = await build.mock.results[0].value;

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'meadow' } });

    await waitFor(() => expect(build).toHaveBeenCalledTimes(2));
    expect(preview).toHaveBeenLastCalledWith('meadow');
    expect(drewBoardOfWidth(1)).toBe(7);
    // ⚠️ Disposal is the half that leaks if it is missed: a renderer holds a
    // WebGL context and a render loop, and nothing above would look different
    // for several switches.
    expect(first.dispose).toHaveBeenCalled();
  });

  // ⚠️ **A build that lands after the switch has to be thrown away**, not
  // stored. Construction is async -- unit models load first -- so a slow map
  // resolving late would otherwise leave a live renderer nothing can reach and
  // a scene showing the wrong board.
  it('disposes a scene that arrives after the map has changed', async () => {
    const stale = fakeRenderer();
    let release!: (renderer: GameRenderer) => void;
    build.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    renderViewer();
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'meadow' } });
    await waitFor(() => expect(build).toHaveBeenCalledTimes(2));

    release(stale);
    await waitFor(() => expect(stale.dispose).toHaveBeenCalled());
  });

  it('shows the reason when the list cannot be loaded', async () => {
    mapList.mockRejectedValue(new Error('could not reach the server'));
    renderViewer();
    expect(await screen.findByText('could not reach the server')).toBeTruthy();
    expect(build).not.toHaveBeenCalled();
  });

  it('shows the reason when a map itself cannot be loaded', async () => {
    preview.mockRejectedValue(new Error('not found'));
    renderViewer();
    expect(await screen.findByText('not found')).toBeTruthy();
  });

  it('disposes the scene when the page goes away', async () => {
    const { unmount } = renderViewer();
    await waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    const renderer = await build.mock.results[0].value;

    unmount();
    expect(renderer.dispose).toHaveBeenCalled();
  });
});
