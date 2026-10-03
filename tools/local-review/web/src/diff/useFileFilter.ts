import { useMemo, useState } from 'react';
import type { FileEntry, OrphanFile } from '../api/types';
import { compileRule, hasRules, matchesSearch, passesRules, type CompiledRule, type FileRules } from './fileFilter';

/**
 * The quick search and the show/hide rules, with the file lists they produce.
 * Held above the sidebar because the feed of all files shows exactly what the
 * sidebar's tree shows. Session-only: a reload starts with no filter.
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
  /** Files of the diff that pass the search and the rules: the tree. */
  shown: FileEntry[];
  /** Found by the search, hidden by a rule. */
  hidden: FileEntry[];
  shownOrphans: OrphanFile[];
  hiddenOrphans: OrphanFile[];
};

export function useFileFilter(files: FileEntry[], orphans: OrphanFile[]): FileFilter {
  const [search, setSearch] = useState('');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');

  const includeRule = useMemo(() => compileRule(include), [include]);
  const excludeRule = useMemo(() => compileRule(exclude), [exclude]);
  const rules: FileRules = useMemo(
    () => ({ include: includeRule.regex, exclude: excludeRule.regex }),
    [includeRule, excludeRule],
  );

  // Search narrows everything; rules only decide between the tree and the
  // hidden section, so a file hidden by a rule can still be found.
  const lists = useMemo(() => {
    const foundFiles = files.filter((f) => matchesSearch(f.path, search));
    const foundOrphans = orphans.filter((f) => matchesSearch(f.path, search));
    return {
      shown: foundFiles.filter((f) => passesRules(f.path, rules)),
      hidden: foundFiles.filter((f) => !passesRules(f.path, rules)),
      shownOrphans: foundOrphans.filter((f) => passesRules(f.path, rules)),
      hiddenOrphans: foundOrphans.filter((f) => !passesRules(f.path, rules)),
    };
  }, [files, orphans, search, rules]);

  return useMemo(
    () => ({ search, setSearch, include, setInclude, exclude, setExclude, includeRule, excludeRule, rulesActive: hasRules(rules), ...lists }),
    [search, include, exclude, includeRule, excludeRule, rules, lists],
  );
}
