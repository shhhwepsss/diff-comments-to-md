import { useCallback, useMemo, useState } from 'react';
import type { FileEntry, OrphanFile } from '../api/types';
import {
  compileRule,
  hasRules,
  matchesSearch,
  matchesStatus,
  passesRules,
  statusKind,
  toggleStatus,
  type CompiledRule,
  type FileRules,
  type StatusKind,
} from './fileFilter';

/**
 * The quick search, the status toggles and the show/hide rules, with the file
 * lists they produce. Held above the sidebar because the feed of all files
 * shows exactly what the sidebar's tree shows. Session-only: a reload starts
 * with no filter.
 */
export type FileFilter = {
  search: string;
  setSearch: (next: string) => void;
  include: string;
  setInclude: (next: string) => void;
  exclude: string;
  setExclude: (next: string) => void;
  includeRule: CompiledRule;
  excludeRule: CompiledRule;
  rulesActive: boolean;
  /** Picked statuses; empty means every status. */
  kinds: ReadonlySet<StatusKind>;
  toggleKind: (kind: StatusKind, only?: boolean) => void;
  clearKinds: () => void;
  /** Files per status among those the search and the rules keep, whatever is picked. */
  kindCounts: Record<StatusKind, number>;
  /** Files of the diff that pass the search, the status and the rules: the tree. */
  shown: FileEntry[];
  /** Found by the search and the status, hidden by a rule. */
  hidden: FileEntry[];
  shownOrphans: OrphanFile[];
  hiddenOrphans: OrphanFile[];
};

const NO_KINDS: ReadonlySet<StatusKind> = new Set();

export function useFileFilter(files: FileEntry[], orphans: OrphanFile[]): FileFilter {
  const [search, setSearch] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<StatusKind>>(NO_KINDS);

  const includeRule = useMemo(() => compileRule(include), [include]);
  const excludeRule = useMemo(() => compileRule(exclude), [exclude]);
  const rules: FileRules = useMemo(
    () => ({ include: includeRule.regex, exclude: excludeRule.regex }),
    [includeRule, excludeRule],
  );

  const toggleKind = useCallback((kind: StatusKind, only = false) => setKinds((prev) => toggleStatus(prev, kind, only)), []);
  const clearKinds = useCallback(() => setKinds(NO_KINDS), []);

  // Search and status narrow everything; rules only decide between the tree
  // and the hidden section, so a file hidden by a rule can still be found.
  // Files outside the diff have no status, so the status leaves them alone.
  const lists = useMemo(() => {
    const searched = files.filter((f) => matchesSearch(f.path, search));
    const foundFiles = searched.filter((f) => matchesStatus(f, kinds));
    const foundOrphans = orphans.filter((f) => matchesSearch(f.path, search));
    const kindCounts: Record<StatusKind, number> = { A: 0, M: 0, D: 0, R: 0 };
    for (const f of searched) if (passesRules(f.path, rules)) kindCounts[statusKind(f)]++;
    return {
      kindCounts,
      shown: foundFiles.filter((f) => passesRules(f.path, rules)),
      hidden: foundFiles.filter((f) => !passesRules(f.path, rules)),
      shownOrphans: foundOrphans.filter((f) => passesRules(f.path, rules)),
      hiddenOrphans: foundOrphans.filter((f) => !passesRules(f.path, rules)),
    };
  }, [files, orphans, search, rules, kinds]);

  return useMemo(
    () => ({
      search,
      setSearch,
      include,
      setInclude,
      exclude,
      setExclude,
      includeRule,
      excludeRule,
      rulesActive: hasRules(rules),
      kinds,
      toggleKind,
      clearKinds,
      ...lists,
    }),
    [search, include, exclude, includeRule, excludeRule, rules, kinds, toggleKind, clearKinds, lists],
  );
}
