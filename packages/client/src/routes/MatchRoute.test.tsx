import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { GameServer } from '@wargame/shared';
import { makeState } from '@wargame/shared/testing';
import { MatchRoute } from './MatchRoute';

// Two seams: the connection, and the canvas. GameCanvas is replaced because it
// builds a Babylon engine, which needs WebGL; everything MatchRoute decides
// happens before that.
vi.mock('../net/gameServer', () => ({ connectGameServer: vi.fn() }));
vi.mock('../game/GameCanvas', () => ({
  GameCanvas: ({ connection, opponentHere }: { connection: string; opponentHere: boolean }) => (
    <p>
      canvas: {connection}, {opponentHere ? 'opponent here' : 'opponent away'}
    </p>
  ),
}));

vi.mock('../net/api', () => ({ api: { matches: { cancel: vi.fn() } } }));

const { connectGameServer } = await import('../net/gameServer');
const connect = vi.mocked(connectGameServer);
const { api } = await import('../net/api');
const cancel = vi.mocked(api.matches.cancel);

// Call counts are asserted below, so they must not carry across tests.
beforeEach(() => {
  vi.clearAllMocks();
});

const fakeServer = (): GameServer => ({
  getState: () => makeState(3, []),
  you: [1, 2],
  getClocks: () => null,
  getEndedBy: () => null,
  submit: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  dispose: vi.fn(),
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:matchId" element={<MatchRoute />} />
        <Route path="/" element={<p>start screen</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe('MatchRoute', () => {
  it('renders the canvas once a connection resolves', async () => {
    connect.mockResolvedValue({ ok: true, server: fakeServer(), code: null, opponentHere: false });
    renderAt('/m1');
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(await screen.findByText(/canvas:/)).toBeTruthy();
  });

  it('leads back to the list, letting the connection go', async () => {
    const server = fakeServer();
    connect.mockResolvedValue({ ok: true, server, code: null, opponentHere: false });
    renderAt('/m1');
    await screen.findByText(/canvas:/);

    fireEvent.click(screen.getByRole('link', { name: 'Back to matches' }));
    expect(await screen.findByText('start screen')).toBeTruthy();
    expect(server.dispose).toHaveBeenCalled();
  });

  // The two failure branches are the whole reason FailureKind exists: one of
  // them can never succeed, so offering Retry there would be a lie.
  it('offers no retry for a match that does not exist', async () => {
    connect.mockResolvedValue({ ok: false, kind: 'notFound', reason: 'not found' });
    renderAt('/nope');
    expect(await screen.findByText(/No match with that id/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers a working retry when the server is unreachable', async () => {
    connect.mockResolvedValue({ ok: false, kind: 'unreachable', reason: 'fetch failed' });
    renderAt('/m1');
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();

    connect.mockResolvedValue({ ok: true, server: fakeServer(), code: null, opponentHere: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/canvas:/)).toBeTruthy();
  });

  it('disposes the connection when the route unmounts', async () => {
    const server = fakeServer();
    connect.mockResolvedValue({ ok: true, server, code: null, opponentHere: false });
    const { unmount } = renderAt('/m1');
    await screen.findByText(/canvas:/);

    unmount();
    expect(server.dispose).toHaveBeenCalled();
  });

  // What StrictMode produces: the effect tears down while a connect is still
  // in flight. Nothing is listening by the time it lands, so it has to be
  // disposed or its poll loop runs for the life of the tab.
  it('disposes a connection that resolves after teardown', async () => {
    const server = fakeServer();
    let land!: (result: { ok: true; server: GameServer; code: null; opponentHere: false }) => void;
    connect.mockReturnValue(new Promise((resolve) => (land = resolve)));

    const { unmount } = renderAt('/m1');
    unmount();
    land({ ok: true, server, code: null, opponentHere: false });
    await vi.waitFor(() => expect(server.dispose).toHaveBeenCalled());
  });

  it('waits with the code until a poll says the game has started', async () => {
    connect.mockResolvedValue({
      ok: true,
      server: fakeServer(),
      code: 'ABC234',
      opponentHere: false,
    });
    renderAt('/m1');
    expect(await screen.findByText('ABC234')).toBeTruthy();
    expect(screen.queryByText(/canvas:/)).toBeNull();

    act(() => connect.mock.calls[0][1]?.onStart?.());
    expect(await screen.findByText(/canvas:/)).toBeTruthy();
  });

  it('hands the canvas the presence the connection reports, as it changes', async () => {
    connect.mockResolvedValue({ ok: true, server: fakeServer(), code: null, opponentHere: true });
    renderAt('/m1');
    expect(await screen.findByText(/opponent here/)).toBeTruthy();
    act(() => connect.mock.calls[0][1]?.onPresenceChange?.(false));
    expect(await screen.findByText(/opponent away/)).toBeTruthy();
  });

  it('cancels a waiting game and goes back to the list', async () => {
    connect.mockResolvedValue({
      ok: true,
      server: fakeServer(),
      code: 'ABC234',
      opponentHere: false,
    });
    cancel.mockResolvedValue();
    renderAt('/m1');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel game' }));
    expect(await screen.findByText('start screen')).toBeTruthy();
    expect(cancel).toHaveBeenCalledWith('m1');
  });

  // A join that landed first: the game is not cancelled, and says why.
  it('stays, saying why, when cancelling is refused', async () => {
    connect.mockResolvedValue({
      ok: true,
      server: fakeServer(),
      code: 'ABC234',
      opponentHere: false,
    });
    cancel.mockRejectedValue(new Error('the game has started'));
    renderAt('/m1');
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel game' }));
    expect(await screen.findByText('the game has started')).toBeTruthy();
    expect(screen.getByText('ABC234')).toBeTruthy();
  });

  it('reports a missing match id rather than connecting', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MatchRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/No match specified/)).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });
});
