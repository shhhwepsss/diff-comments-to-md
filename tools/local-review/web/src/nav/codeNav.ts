import { createContext } from 'react';
import type { LspCallDirection, LspLocation } from '../api/types';
import type { LspSession } from '../lsp/session';
import type { NavHistory } from './history';
import type { SymbolKind } from './navList';
import type { TextFile } from './textSearch';

/** The shortcuts of code navigation, as the settings page stores them. */
export type CodeNavKeys = {
  definition: string;
  references: string;
  implementation: string;
  callHierarchy: string;
  navBack: string;
  navForward: string;
};

/** The tabs of the navigation panel. */
export type NavTab = 'references' | 'implementation' | 'calls';

/** What the navigation panel was opened for: a symbol at a place in a file, and which tab to show. */
export type NavQuery = {
  tab: NavTab;
  /** For the calls tab: callers («Кто вызывает») or callees. */
  direction: LspCallDirection;
  word: string;
  path: string;
  /** Zero-based LSP position of the symbol. */
  line: number;
  character: number;
  /** The text on screen, when the server must be given it (staged, commits). */
  text?: string;
  /** What the hover said it is, when a hover was seen; the panel asks otherwise. */
  kind?: SymbolKind | null;
  /**
   * Found by text, without a language server (a PR with no clone): the
   * declarations to choose from, or every occurrence of the word. The panel
   * lists these and asks nothing.
   */
  textHits?: { kind: 'definitions' | 'references'; locations: LspLocation[]; skipped: number };
};

/** Navigation by text, for a PR with no local clone (nav/textSearch.ts). */
export type TextNav = {
  /** The new side of the files of the diff; `skipped` is how many were not read (a huge PR). */
  files: () => Promise<{ files: TextFile[]; skipped: number }>;
};

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
  /** Show the navigation panel (references, implementations, calls) for a symbol. */
  openPanel: (query: NavQuery) => void;
  /** Set when there is no language server to ask (a PR with no clone): navigation by text. */
  text: TextNav | null;
};

export const CodeNavContext = createContext<CodeNav | null>(null);
