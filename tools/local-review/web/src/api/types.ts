// Shapes of the local-review HTTP API (tools/local-review/lib/routes/*).

import type { Keybindings } from '../lib/keybindings';

export type Mode = 'working' | 'staged' | 'base' | 'commits';

export type LocalDescriptor = {
  source: 'local';
  root: string;
  mode: Mode;
  base: string;
  /** Selected commit range (short or full sha); set only while mode === 'commits'. */
  from?: string;
  to?: string;
};

export type PrDescriptor = {
  source: 'pr';
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** Selected commit range for the PR's "commits" view; absent means "все изменения". */
  from?: string;
  to?: string;
};

export type Descriptor = LocalDescriptor | PrDescriptor;

export type FileEntry = {
  path: string;
  oldPath?: string | null;
  status: string;
  kind: string;
  untracked: boolean;
  /** Added / removed lines of this file's diff; null when unknown (binary, untracked local file, older server). */
  additions: number | null;
  deletions: number | null;
  comments: number;
  /** Identity of this file's current diff; a viewed mark only holds while it is unchanged. */
  fingerprint: string | null;
  /** Marked viewed against exactly this fingerprint. */
  viewed: boolean;
};

export type OrphanFile = { path: string; comments: number; orphan: true };

export type PrMeta = {
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  state: string;
  isDraft: boolean;
  headRefName: string | null;
  baseRefName: string | null;
  headSha: string | null;
  url: string;
};

export type StateResponse = {
  repoRoot: string | null;
  source: 'local' | 'pr';
  mode?: Mode;
  base?: string;
  pr: PrMeta | null;
  rangeLabel: string;
  totalComments: number;
  /** GitHub cut the file list at its own `limit`; `total` is null when it does not say how many there are. Absent from an older server. */
  truncated?: { shown: number; total: number | null; limit: number } | null;
  files: FileEntry[];
  orphanFiles: OrphanFile[];
};

export type DiffLine = {
  type: 'add' | 'del' | 'context';
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type Hunk = { oldStart: number; newStart: number; heading: string; lines: DiffLine[] };

export type DiffResponse = {
  path: string;
  oldPath?: string | null;
  status: string;
  kind: string;
  untracked?: boolean;
  hunks: Hunk[];
  binary: boolean;
  /** null: GitHub gave neither a patch nor counts for this file (a very large PR). */
  additions: number | null;
  deletions: number | null;
  missing?: boolean;
  oldText?: string | null;
  newText?: string | null;
  textUnavailable?: string;
};

/** Commit range a comment was written against; omitted for the latest-commit-only selection. */
export type CommitContext = { from: string; to: string; label: string };

export type Comment = {
  id: string;
  /** null for a general comment about the whole review, not tied to a file. */
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  text: string;
  createdAt: string;
  updatedAt: string;
  commit?: CommitContext;
};

export type Commit = {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  /** ISO timestamp. */
  date: string;
  /** Committer date, ISO; a rebase or amend moves it. Empty from an older server. */
  committedAt?: string;
  subject: string;
  body: string;
  merge: boolean;
  /** A commit with no parents (the repository's first commit). */
  root: boolean;
};

export type DirtyStatus = { dirty: boolean; files: number };

export type CommitsResponse = {
  /** Oldest to newest. */
  commits: Commit[];
  truncated: boolean;
  fallback: boolean;
  base: string | null;
  dirty: DirtyStatus;
};

export type BrowseEntry = { name: string; path: string; isRepo: boolean; recent?: boolean };

export type BrowseResponse = {
  path: string | null;
  parent: string | null;
  separator: string;
  home?: string;
  isRepo?: boolean;
  entries: BrowseEntry[];
};

export type ValidateResponse = {
  ok: boolean;
  repoRoot: string | null;
  sameAsRequested: boolean;
  requested: string;
  error: string | null;
};

/** POST /api/local/pick-folder: the system dialog either returns a folder or was closed. */
export type PickFolderResponse = { path: string } | { cancelled: true };

export type RecentRepo = { root: string };

export type SessionResponse = {
  last: Descriptor | null;
  /** The repository `review` was started in, when it was started inside one. */
  defaults: Descriptor | null;
  recent: RecentRepo[];
  homeDir: string;
  storedPrs: number;
};

/** What POST /api/session reports about the ignore line it wrote (or did not). */
export type Gitignore = {
  changed: boolean;
  target?: 'project' | 'global';
  file?: string | null;
  error?: string;
};

/** How the diff screen lays files out: one file on screen, or all of them stacked. */
export type ViewMode = 'single' | 'all';

/** ~/.local-review/settings.json. */
export type Settings = {
  /** Appended after the comments in both exports; empty = comments alone. */
  copyPrompt: string;
  /** Where the `.local-review/` ignore line goes: repo root .gitignore or the machine-wide one. */
  gitignoreTarget: 'project' | 'global';
  /** Shortcut per action, e.g. `{ zen: 'Ctrl+Shift+F' }`; '' means not bound. */
  keybindings: Keybindings;
  /** View mode a browser starts in while it has no remembered choice: one file, or all files in a feed. */
  defaultViewMode: ViewMode;
  /** «Код» / «Просмотр» switched in one file switches every file that has a rendered view; off = each file on its own. */
  renderModeForAllFiles: boolean;
};

export type GhStatus = {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  host: string | null;
  message: string | null;
};

/** One row of the repository picker on the PR screen (lib/repos.js). */
export type RepoItem = {
  nameWithOwner: string;
  /** ISO date of the last push, or null when GitHub reports none. */
  pushedAt: string | null;
  isPrivate: boolean;
};

export type RepoListResponse = { items: RepoItem[] };

export type PrItem = {
  host: string;
  owner: string | null;
  repo: string | null;
  number: number;
  title: string;
  author: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  url: string;
};

export type PrSearchResponse = {
  mode: 'repo' | 'global';
  items: PrItem[];
  homeDir: string;
  storedPrs: number;
};
