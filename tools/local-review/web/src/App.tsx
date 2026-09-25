import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@primer/react';
import { api, failureMessage } from './api/client';
import { DEFAULT_HASH, hashFor, routeFromHash } from './lib/hash';
import { useToast } from './lib/toast';
import type { ThemePref } from './lib/theme';
import { isTypingTarget, keybindingsFrom, matchesEvent, KEYBINDING_DEFAULTS, type Keybindings } from './lib/keybindings';
import { titleFor } from './lib/title';
import { readZen, writeZen } from './lib/zen';
import { readCommentsPanel, writeCommentsPanel } from './lib/commentsPanel';
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

/** True while a Primer dialog or side sheet is open: Esc belongs to it, not to Zen. */
function portalOpen(): boolean {
  return Boolean(document.getElementById('__primerPortalRoot__')?.childElementCount);
}

type Props = { theme: ThemePref; onTheme: (t: ThemePref) => void };

export function App({ theme, onTheme }: Props) {
  const hash = useSyncExternalStore(subscribeHash, getHash);
  // The hash is the source of truth. With no hash at all (a fresh tab, or a
  // server that was just restarted) the repository `review` was launched in
  // wins over the remembered one: running the command inside a folder is an
  // explicit choice, the saved session is only the previous run's leftover.
  const [booted, setBooted] = useState(Boolean(hash));
  const toast = useToast();
  const [zen, setZenState] = useState(readZen);
  const [keys, setKeys] = useState<Keybindings>(KEYBINDING_DEFAULTS);

  const setZen = useCallback((on: boolean) => {
    setZenState(on);
    writeZen(on);
  }, []);
  const [commentsPanel, setCommentsPanelState] = useState(readCommentsPanel);
  const setCommentsPanel = useCallback((open: boolean) => {
    setCommentsPanelState(open);
    writeCommentsPanel(open);
  }, []);

  const route = routeFromHash(hash);
  const onSettings = route.screen === 'settings';
  const diffScreen = route.screen === 'diff';
  // Zen is a diff-screen layout. On the pickers and in the settings it is
  // ignored, so leaving the diff can never cost the navigation.
  const zenActive = zen && diffScreen;
  // The tab strip is the only place the open repository shows while the window
  // is in the background, so the title follows the address, not the loaded
  // review: it is right from the first paint and stays right in Zen, where the
  // header that would otherwise say it is not drawn at all.
  const title = titleFor(route);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // The shortcut lives in ~/.local-review/settings.json, which only the
  // settings page writes: read it at boot and again on the way out of that
  // page. A failure here costs the shortcut, nothing else.
  useEffect(() => {
    if (onSettings) return;
    let alive = true;
    api
      .settings()
      .then((s) => alive && setKeys(keybindingsFrom(s.keybindings)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [onSettings]);

  useEffect(() => {
    if (!diffScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || portalOpen()) return;
      if (e.key === 'Escape') {
        if (!zen) return;
        e.preventDefault();
        setZen(false);
        return;
      }
      if (matchesEvent(keys.commentsPanel, e)) {
        e.preventDefault();
        setCommentsPanel(!commentsPanel);
        return;
      }
      if (!matchesEvent(keys.zen, e)) return;
      e.preventDefault();
      setZen(!zen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [diffScreen, keys.zen, keys.commentsPanel, setZen, zen, commentsPanel, setCommentsPanel]);

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
      .catch((e) => {
        if (!alive) return;
        // Still usable without a session: fall back to the picker, but say why.
        toast(failureMessage('Не удалось загрузить сессию', e), true);
        if (!window.location.hash) window.location.hash = DEFAULT_HASH;
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

  const shell = (
    <div className={zenActive ? 'rv-app is-zen' : 'rv-app'}>
      {!zenActive && (
        <AppHeader route={route} theme={theme} onTheme={onTheme} commentsPanel={commentsPanel} onCommentsPanel={setCommentsPanel} />
      )}
      <div className="rv-main">
        {route.screen === 'diff' ? (
          <DiffScreen zen={zenActive} onZen={setZen} commentsPanel={commentsPanel} onCommentsPanel={setCommentsPanel} />
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
