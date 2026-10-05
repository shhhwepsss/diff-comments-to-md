import type { PrCloneStatus, PrDescriptor } from '../api/types';

// Words and commands of the clone bar and dialog (CloneBar.tsx). Pure.

/** `owner/repo`, or `host/owner/repo` off github.com — what `gh repo clone` takes. */
export function repoArg(d: Pick<PrDescriptor, 'host' | 'owner' | 'repo'>): string {
  return !d.host || d.host === 'github.com' ? `${d.owner}/${d.repo}` : `${d.host}/${d.owner}/${d.repo}`;
}

/** A folder as a shell would need it typed: quoted when it has spaces or quotes. */
function shellPath(dir: string): string {
  if (!dir) return '…';
  return /^[\w@%+=:,./~-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`;
}

/** What «Клонировать» runs, to show before it does (the server runs the same, without a shell). */
export function cloneCommands(d: PrDescriptor, dir: string): string {
  const at = shellPath(dir.trim());
  return `gh repo clone ${repoArg(d)} ${at}\ncd ${at} && gh pr checkout ${d.number}`;
}

/** What «Использовать» checks of a folder; nothing in it is changed. */
export function linkCommands(d: PrDescriptor, dir: string): string {
  const at = shellPath(dir.trim());
  return `git -C ${at} remote -v    # должен быть ${repoArg(d)}\ngit -C ${at} rev-parse HEAD    # сверяется с head PR`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '?';
}

/**
 * Why the clone may not match the diff, or null when it does (or when that is
 * unknown and nothing better can be said).
 */
export function headWarning(c: PrCloneStatus, number: number): string | null {
  if (!c.bound || !c.valid || c.onHead !== false) return null;
  const at = c.branch ? `${c.branch} @ ${shortSha(c.head)}` : `HEAD ${shortSha(c.head)}`;
  const pr = c.prBranch ? `${c.prBranch} @ ${shortSha(c.prHead)}` : shortSha(c.prHead);
  return `Клон не на коммите PR #${number}: в клоне ${at}, а дифф показывает ${pr}. Файлы могут не совпадать — LSP получает показанный текст.`;
}
