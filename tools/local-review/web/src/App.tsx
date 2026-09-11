import { useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@primer/react';
import { api } from './api/client';
import { hashFor, routeFromHash } from './lib/hash';
import type { ThemePref } from './lib/theme';
import { ReviewProvider } from './review/ReviewContext';
import { AppHeader } from './components/AppHeader';
import { DiffScreen } from './screens/DiffScreen';
import { LocalPicker } from './screens/LocalPicker';
import { PrSearch } from './screens/PrSearch';

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const getHash = () => window.location.hash;

type Props = { theme: ThemePref; onTheme: (t: ThemePref) => void };

export function App({ theme, onTheme }: Props) {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  // The hash is the source of truth; the saved descriptor is consulted only
  // when there is no hash at all (a fresh tab after a server restart).
  const [booted, setBooted] = useState(Boolean(hash));

  useEffect(() => {
    if (booted) return;
    let alive = true;
    api
      .session()
      .then((s) => {
        if (alive && !window.location.hash) window.location.hash = hashFor(s.last) || '#/local';
      })
      .catch(() => {
        if (alive && !window.location.hash) window.location.hash = '#/local';
      })
      .finally(() => alive && setBooted(true));
    return () => {
      alive = false;
    };
  }, [booted]);

  if (!booted) {
    return (
      <div className="rv-center">
        <Spinner size="large" />
      </div>
    );
  }

  const route = routeFromHash(hash);

  const shell = (
    <div className="rv-app">
      <AppHeader route={route} theme={theme} onTheme={onTheme} />
      <div className="rv-main">
        {route.screen === 'diff' ? <DiffScreen /> : route.screen === 'pr' ? <PrSearch /> : <LocalPicker />}
      </div>
    </div>
  );

  // A new descriptor is a new review: remount so no state leaks across.
  return route.screen === 'diff' ? (
    <ReviewProvider key={hashFor(route.descriptor)} initial={route.descriptor}>
      {shell}
    </ReviewProvider>
  ) : (
    shell
  );
}
