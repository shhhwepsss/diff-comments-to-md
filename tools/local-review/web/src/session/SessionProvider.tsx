import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, failureMessage } from '../api/client';
import type { Descriptor, SessionCounts, SessionExportScope, SessionMark, SessionOverview, SessionPrInput } from '../api/types';
import { hashFor } from '../lib/hash';
import { copyToClipboard } from '../lib/clipboard';
import { useToast } from '../lib/toast';
import { createDraftStore } from '../review/drafts';
import { SessionDialogs } from './SessionDialogs';
import { SessionContextProvider, type SessionApi, type SessionRepo } from './sessionContext';
import {
  cleanupRows,
  descriptorOf,
  neighbourIndex,
  sessionIndex,
  toggledMark,
} from './sessionLogic';
import { readSessionPin, writeSessionPin } from './sessionPin';

type Dialog = 'general' | 'export' | null;
/** The cleanup dialog; `landOn` is where to go once it is answered (a session that has just started). */
type Cleanup = { landOn: string | null } | null;

const NO_COUNTS: SessionCounts = {};

/**
 * The running review session for the whole app. It sits above the per-PR
 * review (which is rebuilt for every PR) so that the session survives moving
 * from one PR to the next, and above the screens so that the search screen,
 * the header, the pinned list and the Zen pill all read the same one.
 *
 * `descriptor` is what the address shows. The PR on screen is the only thing
 * that moves the session along: opening a PR of the session — by the buttons,
 * a link, another tab's link — marks it visited and makes it the current one.
 */
export function SessionProvider({ descriptor, children }: { descriptor: Descriptor | null; children: ReactNode }) {
  const toast = useToast();
  const [overview, setOverview] = useState<SessionOverview | null>(null);
  const [pinned, setPinnedState] = useState(readSessionPin);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [cleanup, setCleanupState] = useState<Cleanup>(null);
  // The dialog can be answered twice over (its button, then the counts it just
  // changed emptying it); the landing must happen once.
  const cleanupRef = useRef<Cleanup>(null);
  const setCleanup = useCallback((next: Cleanup) => {
    cleanupRef.current = next;
    setCleanupState(next);
  }, []);
  const [drafts] = useState(createDraftStore);

  const session = overview?.session ?? null;
  const counts = overview?.counts ?? NO_COUNTS;
  const index = session ? sessionIndex(session, descriptor) : -1;
  // Callbacks outlive the render that made them; they read the latest of these.
  const live = useRef({ session, index });
  live.current = { session, index };

  const setPinned = useCallback((on: boolean) => {
    setPinnedState(on);
    writeSessionPin(on);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setOverview(await api.reviewSession());
    } catch (e) {
      toast(failureMessage('Не удалось прочитать сессию ревью', e), true);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opening a PR of the session makes it the current one and marks it
  // visited; the counts of the other PRs are read again on the way, since
  // comments may have been written or deleted since. A failed write costs the
  // bookkeeping only, never the review itself.
  const sessionId = session?.id ?? null;
  useEffect(() => {
    const { session: s, index: at } = live.current;
    if (!s) return;
    let alive = true;
    (async () => {
      try {
        const number = at >= 0 ? s.prs[at].number : null;
        if (number !== null && (s.current !== at || !s.visited[number])) {
          await api.updateReviewSession({ current: at, visited: [number] });
        }
        const fresh = await api.reviewSession();
        if (alive) setOverview(fresh);
      } catch {
        /* see above */
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, index]);

  const go = useCallback((at: number) => {
    const s = live.current.session;
    if (!s || !s.prs[at]) return;
    window.location.hash = hashFor(descriptorOf(s, s.prs[at]));
  }, []);

  const step = useCallback(
    (delta: number) => {
      const { session: s, index: at } = live.current;
      const next = s ? neighbourIndex(s, at, delta) : null;
      if (next === null) return false;
      go(next);
      return true;
    },
    [go],
  );

  const start = useCallback(
    async (repo: SessionRepo, prs: SessionPrInput[], carryOver: boolean) => {
      try {
        const res = await api.startReviewSession({ ...repo, prs, carryOver });
        setOverview({ session: res.session, counts: res.counts });
        const first = res.session.prs[res.session.current];
        const landOn = hashFor(descriptorOf(res.session, first));
        // Comments left by an earlier session would go into this export
        // together with the new ones: ask before the first PR opens.
        if (cleanupRows(res.session, res.counts).length > 0) setCleanup({ landOn });
        else window.location.hash = landOn;
        return true;
      } catch (e) {
        toast(failureMessage('Не удалось начать сессию', e), true);
        return false;
      }
    },
    [toast, setCleanup],
  );

  const finish = useCallback(async () => {
    try {
      await api.finishReviewSession();
      setOverview({ session: null, counts: NO_COUNTS });
      setDialog(null);
      setCleanup(null);
      toast('Сессия завершена. Комментарии PR-ов остались на месте.');
    } catch (e) {
      toast(failureMessage('Не удалось завершить сессию', e), true);
    }
  }, [toast, setCleanup]);

  const mark = useCallback(
    async (kind: SessionMark) => {
      const { session: s, index: at } = live.current;
      if (!s || at < 0) return;
      const number = s.prs[at].number;
      const next = toggledMark(s.marks[number], kind);
      try {
        const res = await api.updateReviewSession({ marks: { [number]: next } });
        setOverview((o) => (o ? { ...o, session: res.session } : o));
        if (!next) return;
        toast(`#${number} — ${kind === 'lgtm' ? 'без замечаний' : 'пропущен'}`);
        const after = neighbourIndex(s, at, 1);
        if (after !== null) go(after);
      } catch (e) {
        toast(failureMessage('Не удалось поставить отметку', e), true);
      }
    },
    [go, toast],
  );

  const copy = useCallback(
    async (scope: SessionExportScope) => {
      const { session: s, index: at } = live.current;
      if (!s) return;
      try {
        const number = scope === 'pr' && at >= 0 ? s.prs[at].number : undefined;
        const text = await api.sessionExportText(scope, number);
        const ok = await copyToClipboard(typeof text === 'string' ? text : String(text));
        toast(
          ok
            ? scope === 'pr'
              ? `Скопировано: только #${number}`
              : `Скопировано: вся сессия, ${s.prs.length} PR`
            : 'Не удалось скопировать — открой /api/review-session/export',
          !ok,
        );
      } catch (e) {
        toast(failureMessage('Не удалось скопировать', e), true);
      }
    },
    [toast],
  );

  const writeMd = useCallback(
    async (scope: SessionExportScope) => {
      try {
        const { session: s, index: at } = live.current;
        const result = await api.sessionExportFile(scope, scope === 'pr' && s && at >= 0 ? s.prs[at].number : undefined);
        toast(`Записан ${result.file} → ${result.path}`);
      } catch (e) {
        toast(failureMessage('Не удалось записать .md', e), true);
      }
    },
    [toast],
  );

  const closeCleanup = useCallback(() => {
    const open = cleanupRef.current;
    setCleanup(null);
    if (open?.landOn) window.location.hash = open.landOn;
  }, [setCleanup]);

  const api_ = useMemo<SessionApi>(
    () => ({
      loaded: overview !== null,
      session,
      counts,
      index,
      pinned,
      setPinned,
      refresh,
      start,
      finish,
      go,
      step,
      mark,
      openGeneral: () => setDialog('general'),
      openExport: () => setDialog('export'),
      openCleanup: () => setCleanup({ landOn: null }),
      copy,
      writeMd,
      drafts,
    }),
    [overview, session, counts, index, pinned, setPinned, refresh, start, finish, go, step, mark, copy, writeMd, drafts, setCleanup],
  );

  return (
    <SessionContextProvider value={api_}>
      {children}
      {session && (
        <SessionDialogs
          dialog={dialog}
          onCloseDialog={() => setDialog(null)}
          cleanup={cleanup !== null}
          onCloseCleanup={closeCleanup}
          onCleaned={(next) => setOverview((o) => (o ? { ...o, counts: next } : o))}
        />
      )}
    </SessionContextProvider>
  );
}
