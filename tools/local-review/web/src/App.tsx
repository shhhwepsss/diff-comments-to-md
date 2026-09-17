import { useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@primer/react';
import { api } from './api/client';
import { DEFAULT_HASH, hashFor, routeFromHash } from './lib/hash';
import type { ThemePref } from './lib/theme';
import { ReviewProvider } from './review/ReviewContext';
import { AppHeader } from './components/AppHeader';
import { DiffScreen } from './screens/DiffScreen';
import { LocalPicker } from './screens/LocalPicker';
import { PrSearch } from './screens/PrSearch';
import { SettingsScreen } from './settings/SettingsScreen';

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const getHash = () => window.location.hash;

type Props = { theme: ThemePref; onTheme: (t: ThemePref) => void };

export function App({ theme, onTheme }: Props) {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  // The hash is the source of truth. With no hash at all (a fresh tab, or a
  // server that was just restarted) the repository `review` was launched in
  // wins over the remembered one: running the command inside a folder is an
  // explicit choice, the saved session is only the previous run's leftover.
  const [booted, setBooted] = useState(Boolean(hash));

  useEffect(() => {
    if (booted) return;
    let alive = true;
    api
      .session()
      .then((s) => {
        if (alive && !window.location.hash) {
          window.location.hash = hashFor(s.defaults) || hashFor(s.last) || DEFAULT_HASH;
        }
      })
      .catch(() => {
        if (alive && !window.location.hash) window.location.hash = DEFAULT_HASH;
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
        {route.screen === 'diff' ? (
          <DiffScreen />
        ) : route.screen === 'settings' ? (
          <SettingsScreen back={route.back} />
        ) : route.screen === 'pr' ? (
          <PrSearch />
        ) : (
          <LocalPicker />
        )}
      </div>
    </div>
  );

  // A new descriptor is a new review: remount so no state leaks across.
  // The file in the hash is left out of the key: switching files is not a new review.
  return route.screen === 'diff' ? (
    <ReviewProvider key={hashFor(route.descriptor)} initial={route.descriptor} initialFile={route.file}>
      {shell}
    </ReviewProvider>
  ) : (
    shell
  );
}
