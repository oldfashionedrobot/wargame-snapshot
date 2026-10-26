import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { CLOCK_MINUTES } from '@wargame/shared';
import type { MapSummary, MatchSummary } from '@wargame/shared';
import { StartScreen } from './StartScreen';

// The api module is the seam: StartScreen's whole job is turning what it
// returns into one of four states -- loading, error, empty, a list -- and
// turning a click into a navigation.
vi.mock('../net/api', () => ({
  api: {
    name: vi.fn(),
    maps: { list: vi.fn() },
    matches: { list: vi.fn(), create: vi.fn(), join: vi.fn() },
  },
}));
const { api } = await import('../net/api');
const list = vi.mocked(api.matches.list);
const create = vi.mocked(api.matches.create);
const join = vi.mocked(api.matches.join);
const mapList = vi.mocked(api.maps.list);
const offeredName = vi.mocked(api.name);
const OFFERED = 'Brave-Otter-123';

// ⚠️ One board not square, so a label with its sides the wrong way round shows.
const MAPS: MapSummary[] = [
  { id: 'classic', name: 'Bridgehead', width: 12, height: 12 },
  { id: 'lakeland', name: 'Lakeland', width: 16, height: 12 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mapList.mockResolvedValue(MAPS);
  offeredName.mockResolvedValue(OFFERED);
});

const summary = (over: Partial<MatchSummary> = {}): MatchSummary => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  createdAt: Date.now(),
  seq: 0,
  currentTurn: 'player-1',
  mapId: 'classic',
  winner: null,
  code: null,
  opponent: null,
  yourTurn: true,
  ...over,
});

// Renders the real route table, so a navigation is observable as the other
// route appearing rather than as a spied-on callback.
// The screen with its list loaded and empty, and `menu` opened.
async function openMenu(menu: 'New Game' | 'Join Game') {
  list.mockResolvedValue([]);
  renderScreen();
  await screen.findByText('No matches yet.');
  fireEvent.click(screen.getByRole('button', { name: menu }));
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<StartScreen />} />
        <Route path="/:matchId" element={<p>match screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StartScreen', () => {
  it('lists the matches it fetched', async () => {
    list.mockResolvedValue([summary({ seq: 3 }), summary({ id: 'bbbbbbbb-0000', seq: 0 })]);
    renderScreen();

    // The id is shown abbreviated, with the turn and a move count beside it.
    expect(await screen.findByText('aaaaaaaa')).toBeTruthy();
    expect(screen.getByText(/3 moves/)).toBeTruthy();
    expect(screen.getByText(/not started/)).toBeTruthy();
  });

  it('names whose turn it is while a match is unfinished', async () => {
    list.mockResolvedValue([summary({ currentTurn: 'player-2' })]);
    renderScreen();
    expect(await screen.findByText(/player-2/)).toBeTruthy();
  });

  it('shows a waiting game with its code, and a shared one with the opponent', async () => {
    list.mockResolvedValue([
      summary({ id: 'aaaaaaaa-0', code: 'ABC234', yourTurn: false }),
      summary({ id: 'bbbbbbbb-0', opponent: 'Ada', yourTurn: true }),
      summary({ id: 'cccccccc-0', opponent: 'Grace', yourTurn: false }),
    ]);
    renderScreen();
    expect(await screen.findByText(/waiting for an opponent · code ABC234/)).toBeTruthy();
    expect(screen.getByText(/against Ada · your turn/)).toBeTruthy();
    expect(screen.getByText(/against Grace · their turn/)).toBeTruthy();
  });

  // ⚠️ Displaced, not appended. `currentTurn` is never cleared, so a finished
  // row that showed both would read "player-1 · player-2 won" -- true,
  // since it is still whose turn it would have been, and useless.
  it('shows the winner instead of the turn once a match is finished', async () => {
    list.mockResolvedValue([summary({ currentTurn: 'player-1', winner: 'player-2' })]);
    renderScreen();
    expect(await screen.findByText(/player-2 won/)).toBeTruthy();
    expect(screen.queryByText(/player-1/)).toBeNull();
  });

  it('says so when there are none', async () => {
    list.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText('No matches yet.')).toBeTruthy();
  });

  it('shows the reason when the list cannot be loaded', async () => {
    list.mockRejectedValue(new Error('server returned 500'));
    renderScreen();
    expect(await screen.findByText('server returned 500')).toBeTruthy();
    // Not stuck on the loading state.
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('creates a match and navigates to it', async () => {
    create.mockResolvedValue(summary({ id: 'cccccccc-9999' }));
    await openMenu('New Game');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('match screen')).toBeTruthy();
  });

  // The guard exists so a slow create cannot be fired twice; it must also let
  // go again if the create fails, or the menu is dead for good.
  it('lets go of the menu and reports why when creating fails', async () => {
    create.mockRejectedValue(new Error('could not reach the server'));
    await openMenu('New Game');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('could not reach the server')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'New game' }).hasAttribute('disabled')).toBe(false);
  });

  it('refetches on Refresh', async () => {
    list.mockResolvedValue([]);
    renderScreen();
    await screen.findByText('No matches yet.');

    list.mockResolvedValue([summary({ id: 'dddddddd-7777' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('dddddddd')).toBeTruthy();
  });
});

describe('StartScreen, choosing a map', () => {
  // The path nobody was asserting, and the one that was wrong: with the select
  // untouched, what it displays and what create sends have to be the same map.
  // They agreed only while the registry happened to lead with the default.
  it('creates on the map it is showing, without the select being touched', async () => {
    create.mockResolvedValue(summary());
    await openMenu('New Game');

    const select = await screen.findByRole('combobox', { name: /Map/ });
    expect((select as HTMLSelectElement).value).toBe('classic');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ mapId: 'classic', mode: 'hotSeat' }));
  });

  it('offers every map the server named, and creates on the chosen one', async () => {
    create.mockResolvedValue(summary({ mapId: 'lakeland' }));
    await openMenu('New Game');

    const select = await screen.findByRole('combobox', { name: /Map/ });
    fireEvent.change(select, { target: { value: 'lakeland' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ mapId: 'lakeland', mode: 'hotSeat' }),
    );
  });

  it('names each map with its size, width first', async () => {
    await openMenu('New Game');
    expect(await screen.findByRole('option', { name: 'Lakeland · 16×12' })).toBeTruthy();
  });

  // Without a picker the server's default is what you get, which is exactly
  // what happened before there was one -- so a failed map list is not an error
  // worth showing anyone.
  it('creates on the default when the map list could not be fetched', async () => {
    mapList.mockRejectedValue(new Error('offline'));
    create.mockResolvedValue(summary());
    await openMenu('New Game');
    expect(screen.queryByRole('combobox', { name: /Map/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ mapId: undefined, mode: 'hotSeat' }));
  });
});

describe('StartScreen, the New Game menu', () => {
  it('shows the computer, but not as a choice yet', async () => {
    await openMenu('New Game');
    expect(screen.getByRole('radio', { name: /against the computer/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  // A seat and a name mean something only with somebody else in the game.
  it('asks for a seat and a name only for a multiplayer game', async () => {
    await openMenu('New Game');
    expect(screen.queryByRole('radio', { name: /Player 2/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Your name/ })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Multiplayer/ }));
    expect(screen.getByRole('radio', { name: /Player 1/ })).toHaveProperty('checked', true);
    expect(await screen.findByDisplayValue(OFFERED)).toBeTruthy();
  });

  it('creates a multiplayer game in the seat and under the name chosen', async () => {
    create.mockResolvedValue(summary({ code: 'ABC234' }));
    await openMenu('New Game');
    fireEvent.click(screen.getByRole('radio', { name: /Multiplayer/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Player 2/ }));
    fireEvent.change(await screen.findByDisplayValue(OFFERED), { target: { value: 'Ada' } });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        mapId: 'classic',
        mode: 'remote',
        seat: 2,
        name: 'Ada',
      }),
    );
  });
});

describe('StartScreen, the clock', () => {
  it('offers none by default, and each choice in minutes, in any mode', async () => {
    create.mockResolvedValue(summary());
    await openMenu('New Game');
    const clock = screen.getByRole('combobox', { name: /Clock/ }) as HTMLSelectElement;
    expect(clock.value).toBe('');

    fireEvent.change(clock, { target: { value: String(CLOCK_MINUTES[1]) } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        mapId: 'classic',
        mode: 'hotSeat',
        clock: CLOCK_MINUTES[1],
      }),
    );
  });
});

describe('StartScreen, the Join menu', () => {
  it('joins by code under the name offered, and goes to the game', async () => {
    join.mockResolvedValue(summary({ id: 'eeeeeeee-1' }));
    await openMenu('Join Game');
    expect(await screen.findByDisplayValue(OFFERED)).toBeTruthy();
    const joinButton = screen.getByRole('button', { name: 'Join' });
    expect(joinButton).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('textbox', { name: /Code/ }), {
      target: { value: 'abc234' },
    });
    fireEvent.click(joinButton);
    expect(await screen.findByText('match screen')).toBeTruthy();
    expect(join).toHaveBeenCalledWith({ code: 'abc234', name: OFFERED });
  });

  it('stays, saying why, when the join is refused', async () => {
    join.mockRejectedValue(new Error('no game is waiting for that code'));
    await openMenu('Join Game');
    fireEvent.change(screen.getByRole('textbox', { name: /Code/ }), {
      target: { value: 'ZZZZZZ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText('no game is waiting for that code')).toBeTruthy();
    expect(screen.queryByText('match screen')).toBeNull();
  });

  // Without a suggestion the field is empty, and the server makes a name up.
  it('joins with no name when none could be offered', async () => {
    offeredName.mockRejectedValue(new Error('offline'));
    join.mockResolvedValue(summary());
    await openMenu('Join Game');
    fireEvent.change(screen.getByRole('textbox', { name: /Code/ }), {
      target: { value: 'ABC234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(join).toHaveBeenCalledWith({ code: 'ABC234', name: undefined }));
  });
});
