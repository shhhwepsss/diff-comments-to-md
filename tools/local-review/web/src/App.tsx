import { useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@primer/react';
import { api, failureMessage } from './api/client';
import { hashFor, routeFromHash } from './lib/hash';
import { useToast } from './lib/toast';
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
  // The hash is the source of truth. With no hash at all (a fresh tab, or a
  // server that was just restarted) the repository `review` was launched in
  // wins over the remembered one: running the command inside a folder is an
  // explicit choice, the saved session is only the previous run's leftover.
  const [booted, setBooted] = useState(Boolean(hash));
  const toast = useToast();

  useEffect(() => {
    if (booted) return;
    let alive = true;
    api
      .session()
      .then((s) => {
        if (alive && !window.location.hash) {
          window.location.hash = hashFor(s.defaults) || hashFor(s.last) || '#/local';
        }
      })
      .catch((e) => {
        if (!alive) return;
        // Still usable without a session: fall back to the picker, but say why.
        toast(failureMessage('Не удалось загрузить сессию', e), true);
        if (!window.location.hash) window.location.hash = '#/local';
      })
      .finally(() => alive && setBooted(true));
    return () => {
      alive = false;
    };
  }, [booted, toast]);

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
