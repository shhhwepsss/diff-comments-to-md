import { createContext, useContext } from 'react';
import type { ReviewSession, SessionCounts, SessionExportScope, SessionMark, SessionPrInput } from '../api/types';
import type { DraftStore } from '../review/drafts';

/** The repository a session is over. */
export type SessionRepo = { host: string; owner: string; repo: string };

export type SessionApi = {
  /** False until the first answer from the server: the search screen waits with its banner. */
  loaded: boolean;
  /** The session being reviewed, or null. */
  session: ReviewSession | null;
  /** Comments per PR of the session, as of the last read. */
  counts: SessionCounts;
  /** Index in the session of the PR on screen; -1 when the screen shows something else. */
  index: number;
  /** The list of PRs pinned beside the diff (a per-browser preference). */
  pinned: boolean;
  setPinned: (on: boolean) => void;
  /** Re-reads the session and the counts. */
  refresh: () => Promise<void>;
  /**
   * Starts a session over `prs` in this order and lands on its first PR —
   * through the cleanup dialog when some of them carry comments of an earlier
   * session. `carryOver` continues the running session with a new line-up.
   */
  start: (repo: SessionRepo, prs: SessionPrInput[], carryOver: boolean) => Promise<boolean>;
  finish: () => Promise<void>;
  /** Opens the session's PR at `index`. */
  go: (index: number) => void;
  /** Opens the neighbour of the PR on screen; false when there is none. */
  step: (delta: number) => boolean;
  /** Marks the PR on screen (the same mark again takes it off) and moves on to the next one. */
  mark: (kind: SessionMark) => Promise<void>;
  openGeneral: () => void;
  openExport: () => void;
  openCleanup: () => void;
  copy: (scope: SessionExportScope) => Promise<void>;
  writeMd: (scope: SessionExportScope) => Promise<void>;
  /** Unsaved text of the session's comment forms; survives closing the dialog. */
  drafts: DraftStore;
};

const SessionContext = createContext<SessionApi | null>(null);

export const SessionContextProvider = SessionContext.Provider;

export function useSession(): SessionApi {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
