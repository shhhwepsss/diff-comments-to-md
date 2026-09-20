import type { Descriptor } from '../api/types';
import type { Route } from './hash';

// One name for the whole app: the browser tab and the brand in the header say
// the same thing, because they answer the same question — which repository is
// this window looking at. With several reviews open the tab strip is the only
// place that answer is visible without switching tabs, so it carries the
// repository rather than the product name.

/** What both places say while no repository is open: the pickers and settings. */
export const PRODUCT_NAME = 'local-review';

/** The folder name of a repository root, for places a full path is too long for. */
export function repoName(root: string): string {
  return root.split(/[/\\]/).filter(Boolean).pop() || root;
}

/** The title of what the address points at; the product name when that is nothing. */
export function titleFor(route: Route): string {
  return route.screen === 'diff' ? descriptorTitle(route.descriptor) : PRODUCT_NAME;
}

function descriptorTitle(d: Descriptor): string {
  if (d.source === 'pr') return `${d.owner}/${d.repo} #${d.number}`;
  return repoName(d.root) || PRODUCT_NAME;
}
