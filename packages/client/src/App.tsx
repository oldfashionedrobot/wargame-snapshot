import { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { outOfDateStore } from './net/api';
import { MapViewer } from './routes/MapViewer';
import { MatchRoute } from './routes/MatchRoute';
import { StartScreen } from './routes/StartScreen';

// Declarative rather than a data router: loaders would fetch the match list
// before render, but a GameServer needs dispose() and loaders have no teardown
// hook -- so the match route would keep its effect anyway, leaving two data
// paradigms with the harder half unimproved.
//
// ⚠️ **In memory, and nothing ever writes to the URL.** A portal serves the
// build at a deep path it controls, where no path route would match; inside its
// iframe a URL cannot be seen or shared, and every change to it would add a
// Back-button entry to the portal's own page. A match is resumed from the list.
function App() {
  return (
    <MemoryRouter>
      <NewVersionBanner />
      <Routes>
        <Route path="/" element={<StartScreen />} />
        {/* ⚠️ Before `/:matchId` for the reader's sake only -- react-router
            ranks a static segment above a dynamic one whatever the order, so a
            match whose id is literally "maps" is unreachable either way. Ids
            are uuids, so that is a curiosity rather than a bug. */}
        <Route path="/maps" element={<MapViewer />} />
        <Route path="/:matchId" element={<MatchRoute />} />
      </Routes>
    </MemoryRouter>
  );
}

/**
 * Shown once the server has been seen on a newer build. A banner rather than a
 * block: the server stays compatible with the client it replaced. ⚠️ Promises
 * no timing, because on a portal a reload brings the new client only once the
 * portal has finished processing its build.
 *
 * ⚠️ **In a frame, only the page around it can bring the new build.** A portal
 * gives each upload an address of its own, and a frame reloading itself asks
 * that address again -- the old build, banner and all. A cross-origin frame
 * cannot reload its parent, so it asks the player to.
 */
export function NewVersionBanner() {
  const outOfDate = useSyncExternalStore(outOfDateStore.subscribe, outOfDateStore.get);
  if (!outOfDate) return null;
  return (
    <p style={{ margin: 0, padding: '6px 12px', color: 'var(--warn)' }}>
      A new version of the game is available.{' '}
      {window.self === window.top ? (
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      ) : (
        'Reload this page to play it.'
      )}
    </p>
  );
}

export default App;
