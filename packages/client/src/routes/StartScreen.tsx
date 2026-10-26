import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CLOCK_MINUTES } from '@wargame/shared';
import type { MapSummary, MatchMode, MatchSummary } from '@wargame/shared';
import { api } from '../net/api';
import { mapLabel } from './mapLabel';

interface MatchData {
  matches: MatchSummary[] | null;
  error: string | null;
}

type Menu = 'new' | 'join';

export function StartScreen() {
  const [{ matches, error }, setMatchData] = useState<MatchData>({ matches: null, error: null });
  // Empty until the list arrives, and empty for good if it fails: the picker
  // just does not appear, and creating falls back to the server's default.
  const [maps, setMaps] = useState<MapSummary[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  // Both menus offer it, so it is asked for once, when the first one opens --
  // `null` until then.
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMatches().then((result) => {
      if (!cancelled) setMatchData(result);
    });
    void api.maps
      .list()
      .then((available) => {
        if (!cancelled) setMaps(available);
      })
      .catch(() => {
        // Not worth an error banner. Without a picker you get the default map,
        // which is what happened before there was one.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (menu === null || name !== null) return;
    let cancelled = false;
    void api
      .name()
      // A name typed while the answer was on its way is kept over it.
      .then((offered) => !cancelled && setName((typed) => typed ?? offered))
      // Without a suggestion the field starts empty, and the server makes one.
      .catch(() => !cancelled && setName((typed) => typed ?? ''));
    return () => {
      cancelled = true;
    };
  }, [menu, name]);

  const onRefresh = (): void => {
    void fetchMatches().then(setMatchData);
  };

  const toggle = (next: Menu) => (): void => setMenu((open) => (open === next ? null : next));

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Wargame</h1>

      <p>
        <button type="button" onClick={toggle('new')} aria-expanded={menu === 'new'}>
          New Game
        </button>{' '}
        <button type="button" onClick={toggle('join')} aria-expanded={menu === 'join'}>
          Join Game
        </button>{' '}
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>{' '}
        <Link to="/maps">Browse maps</Link>
      </p>

      {menu === 'new' && <NewGameMenu maps={maps} name={name} onName={setName} />}
      {menu === 'join' && <JoinMenu name={name} onName={setName} />}

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {matches === null && !error && <p>Loading…</p>}
      {matches?.length === 0 && <p>No matches yet.</p>}

      {matches && matches.length > 0 && (
        <ul>
          {matches.map((match) => (
            <li key={match.id}>
              <Link to={`/${match.id}`}>{match.id.slice(0, 8)}</Link>
              {' — '}
              {standing(match)}
              {' · '}
              {match.mapId}
              {match.seq === 0 ? ' · not started' : ` · ${match.seq} moves`}
              {' · '}
              {formatWhen(match.createdAt)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface MenuProps {
  /** `null` while the suggestion is on its way. */
  name: string | null;
  onName: (name: string) => void;
}

/**
 * How a game is to be played, on which map, and -- with somebody else -- which
 * seat and under what name. ⚠️ **The computer is shown and disabled** until
 * there is one to play against.
 */
function NewGameMenu({ maps, name, onName }: MenuProps & { maps: MapSummary[] }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<MatchMode>('hotSeat');
  // Derived from the list until the select is touched, so that what the select
  // shows and what create sends are the same map.
  const [chosenMap, setChosenMap] = useState<string | undefined>(undefined);
  const mapId = chosenMap ?? maps[0]?.id;
  const [seat, setSeat] = useState(1);
  // Minutes each player has, or none.
  const [clock, setClock] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = mode === 'remote';

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api.matches
      .create(
        remote ? { mapId, mode, clock, seat, name: name || undefined } : { mapId, mode, clock },
      )
      .then((match) => void navigate(`/${match.id}`))
      .catch((cause: unknown) => {
        // Let go again, or the menu is dead for good after one failure.
        setBusy(false);
        setError(message(cause, 'could not create a match'));
      });
  };

  return (
    <form onSubmit={onSubmit} aria-label="New game">
      <fieldset disabled={busy}>
        <legend>New game</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'hotSeat'}
            onChange={() => setMode('hotSeat')}
          />{' '}
          Two players on one device
        </label>
        <br />
        <label>
          <input type="radio" name="mode" disabled /> One player against the computer — not yet
        </label>
        <br />
        <label>
          <input type="radio" name="mode" checked={remote} onChange={() => setMode('remote')} />{' '}
          Multiplayer, joined by a code
        </label>
        {maps.length > 0 && (
          <p>
            <label>
              Map{' '}
              <select value={mapId} onChange={(event) => setChosenMap(event.target.value)}>
                {maps.map((map) => (
                  <option key={map.id} value={map.id}>
                    {mapLabel(map)}
                  </option>
                ))}
              </select>
            </label>
          </p>
        )}
        <p>
          <label>
            Clock{' '}
            <select
              value={clock ?? ''}
              onChange={(event) =>
                setClock(event.target.value === '' ? undefined : Number(event.target.value))
              }
            >
              <option value="">None</option>
              {CLOCK_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes each
                </option>
              ))}
            </select>
          </label>
        </p>
        {remote && (
          <p>
            <label>
              <input type="radio" name="seat" checked={seat === 1} onChange={() => setSeat(1)} />{' '}
              Player 1, moving first
            </label>{' '}
            <label>
              <input type="radio" name="seat" checked={seat === 2} onChange={() => setSeat(2)} />{' '}
              Player 2
            </label>
            <br />
            <NameField name={name} onName={onName} />
          </p>
        )}
        <button type="submit">{busy ? 'Starting…' : 'Start'}</button>
      </fieldset>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  );
}

/** A code to join by, and the name to join under. */
function JoinMenu({ name, onName }: MenuProps) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api.matches
      .join({ code, name: name || undefined })
      .then((match) => void navigate(`/${match.id}`))
      .catch((cause: unknown) => {
        setBusy(false);
        setError(message(cause, 'could not join that game'));
      });
  };

  return (
    <form onSubmit={onSubmit} aria-label="Join game">
      <fieldset disabled={busy}>
        <legend>Join a game</legend>
        <label>
          Code{' '}
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>
        <br />
        <NameField name={name} onName={onName} />
        <br />
        <button type="submit" disabled={code.trim() === ''}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </fieldset>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  );
}

// Left empty, the server keeps the name the guest has, or makes one up.
function NameField({ name, onName }: MenuProps) {
  return (
    <label>
      Your name{' '}
      <input
        value={name ?? ''}
        placeholder={name === null ? 'finding you a name…' : 'a name will be made up'}
        onChange={(event) => onName(event.target.value)}
        autoComplete="off"
      />
    </label>
  );
}

/**
 * Where a match stands, as a row says it. ⚠️ **The winner displaces the turn**
 * rather than joining it: `currentTurn` is never cleared, so a finished match
 * reading it would say whose turn it is forever -- true, and useless.
 */
function standing(match: MatchSummary): string {
  if (match.winner !== null) return `${match.winner} won`;
  if (match.code !== null) return `waiting for an opponent · code ${match.code}`;
  if (match.opponent !== null) {
    return `against ${match.opponent} · ${match.yourTurn ? 'your turn' : 'their turn'}`;
  }
  return `${match.currentTurn} to move`;
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

// Plain function rather than a hook: it does no state work, so the effect and
// the Refresh button can share it and each decide whether the result still
// matters by the time it arrives.
async function fetchMatches(): Promise<MatchData> {
  try {
    return { matches: await api.matches.list(), error: null };
  } catch (cause) {
    return { matches: null, error: message(cause, 'could not load matches') };
  }
}

function formatWhen(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
