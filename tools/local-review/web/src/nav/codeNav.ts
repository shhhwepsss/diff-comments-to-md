import { createContext } from 'react';
import type { LspSession } from '../lsp/session';
import type { NavHistory } from './history';

/** The shortcuts of code navigation, as the settings page stores them. */
export type CodeNavKeys = { definition: string; navBack: string; navForward: string };

/**
 * What every file of a review needs for code navigation. Handed down by the
 * diff screen as context: the files of the feed are memoised components, and
 * these change only with the settings or the view (`sendText`).
 */
export type CodeNav = {
  session: LspSession;
  history: NavHistory;
  keys: CodeNavKeys;
  /**
   * The new side on screen is not the working tree (staged, a commit range):
   * the language server gets the text shown instead of reading the file.
   */
  sendText: boolean;
};

export const CodeNavContext = createContext<CodeNav | null>(null);
