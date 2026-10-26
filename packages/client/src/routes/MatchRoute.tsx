import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { GameServer } from '@wargame/shared';
import { GameCanvas } from '../game/GameCanvas';
import { connectGameServer } from '../net/gameServer';
import type { ConnectionStatus } from '../net/gameServer';
import { api } from '../net/api';
import type { FailureKind } from '../net/api';

interface Failure {
  kind: FailureKind;
  reason: string;
}

// react-router reuses the component when only the param changes, so without
// the key a /a -> /b navigation would render GameCanvas against A's server --
// which the effect cleanup has already disposed -- until B resolves. Keying by
// matchId remounts the connection instead: every piece of its state resets and
// a mounted canvas can never see its server prop change, by construction.
export function MatchRoute() {
  const { matchId } = useParams<{ matchId: string }>();

  if (!matchId)
    return (
      <p>
        No match specified. <Link to="/">Back</Link>
      </p>
    );

  return <MatchConnection key={matchId} matchId={matchId} />;
}

/**
 * Owns the connection for one match -- exactly one, which the key above
 * enforces.
 *
 * A remote server has no state until a round trip finishes, so something has
 * to hold the not-ready case -- and a component shouldn't construct the thing
 * it talks to. GameCanvas receives a live server and nothing else.
 */
function MatchConnection({ matchId }: { matchId: string }) {
  const [server, setServer] = useState<GameServer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connected');
  const [attempt, setAttempt] = useState(0);
  // The code a game waits under, until a poll says somebody joined.
  const [code, setCode] = useState<string | null>(null);
  const [opponentHere, setOpponentHere] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let connected: GameServer | null = null;

    const onStart = (): void => setCode(null);
    const options = {
      onConnectionChange: setConnection,
      onStart,
      onPresenceChange: setOpponentHere,
    };
    void connectGameServer(matchId, options).then((result) => {
      if (!result.ok) {
        if (!cancelled) setFailure({ kind: result.kind, reason: result.reason });
        return;
      }
      connected = result.server;
      // The effect may already have been torn down while this was in flight --
      // StrictMode does exactly that. Dispose rather than leak a polling loop
      // nobody is listening to.
      if (cancelled) result.server.dispose();
      else {
        setServer(result.server);
        setCode(result.code);
        setOpponentHere(result.opponentHere);
      }
    });

    return () => {
      cancelled = true;
      connected?.dispose();
    };
  }, [matchId, attempt]);

  if (failure) {
    // A missing match will never resolve, so offering Retry would be a lie.
    return failure.kind === 'notFound' ? (
      <p style={{ padding: '2rem' }}>
        No match with that id. <Link to="/">Back to matches</Link>
      </p>
    ) : (
      <p style={{ padding: '2rem' }}>
        Could not reach the server: {failure.reason}{' '}
        <button
          type="button"
          onClick={() => {
            // Not redundant with the effect re-run: batched with setAttempt,
            // this paints "Connecting…" in the click's own render, where the
            // effect fires only after a frame of stale failure UI.
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>{' '}
        <Link to="/">Back to matches</Link>
      </p>
    );
  }

  if (!server) return <p style={{ padding: '2rem' }}>Connecting…</p>;

  if (code) return <WaitingRoom matchId={matchId} code={code} />;

  // ⚠️ The only way back: routes live in memory, so the browser's Back button
  // never leaves the page.
  return (
    <>
      <GameCanvas server={server} connection={connection} opponentHere={opponentHere} />
      <Link to="/">Back to matches</Link>
    </>
  );
}

/**
 * A game that waits for its second player: the code to send them, and a way
 * to call it off. The connection keeps polling behind it, and the game takes
 * its place when a poll comes back without the code.
 */
function WaitingRoom({ matchId, code }: { matchId: string; code: string }) {
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCancel = (): void => {
    setCancelling(true);
    api.matches
      .cancel(matchId)
      .then(() => void navigate('/'))
      .catch((cause: unknown) => {
        // Most likely somebody joined first, which the next poll will show.
        setCancelling(false);
        setError(cause instanceof Error ? cause.message : 'could not cancel the game');
      });
  };

  return (
    <div style={{ padding: '2rem' }}>
      <p>Waiting for an opponent. Send them this code to join with:</p>
      <p>
        <strong style={{ fontSize: '2rem', letterSpacing: '0.2em' }}>{code}</strong>
      </p>
      <button type="button" onClick={onCancel} disabled={cancelling}>
        Cancel game
      </button>{' '}
      <Link to="/">Back to matches</Link>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  );
}
