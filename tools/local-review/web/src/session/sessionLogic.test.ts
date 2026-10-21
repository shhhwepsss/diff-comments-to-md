import { describe, expect, it } from 'vitest';
import type { ReviewSession } from '../api/types';
import {
  allOrder,
  cleanupRows,
  cleanupTotal,
  descriptorOf,
  doneCount,
  freshCount,
  neighbourIndex,
  oldCommentScopes,
  pickable,
  positionOf,
  prCount,
  prCountOf,
  prKey,
  sessionIndex,
  sessionOrder,
  shortTitle,
  statusLabel,
  statusOf,
  toggledMark,
  togglePick,
  togglePickAll,
  type PickItem,
} from './sessionLogic';

const row = (number: number, updatedAt: string, over: Partial<PickItem> = {}): PickItem => ({
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number,
  updatedAt,
  ...over,
});

// As gh lists them: the most recently updated first.
const found = [row(84, '2026-10-21T10:00:00Z'), row(82, '2026-10-21T09:00:00Z'), row(80, '2026-10-20T10:00:00Z'), row(86, '2026-10-19T10:00:00Z')];
const numbers = (items: PickItem[]) => items.map((i) => i.number);

describe('togglePick', () => {
  it('adds a row at the end and removes a picked one, keeping the others in click order', () => {
    let picked: string[] = [];
    for (const n of [82, 86, 84]) picked = togglePick(picked, prKey(row(n, '')));
    expect(picked).toEqual(['o/r#82', 'o/r#86', 'o/r#84']);
    expect(togglePick(picked, 'o/r#86')).toEqual(['o/r#82', 'o/r#84']);
  });

  it('puts a row picked again after the others', () => {
    expect(togglePick(togglePick(['o/r#1', 'o/r#2'], 'o/r#1'), 'o/r#1')).toEqual(['o/r#2', 'o/r#1']);
  });
});

describe('sessionOrder', () => {
  const picked = ['o/r#80', 'o/r#86', 'o/r#84'];

  it('follows the update time, newest first', () => {
    expect(numbers(sessionOrder(found, picked, 'updated'))).toEqual([84, 80, 86]);
  });

  it('follows the number, highest first', () => {
    expect(numbers(sessionOrder(found, picked, 'number'))).toEqual([86, 84, 80]);
  });

  it('follows the clicks in manual order', () => {
    expect(numbers(sessionOrder(found, picked, 'manual'))).toEqual([80, 86, 84]);
  });

  it('keeps list order for equal times and ignores picks that are no longer listed', () => {
    const same = [row(3, '2026-10-21T10:00:00Z'), row(2, '2026-10-21T10:00:00Z')];
    expect(numbers(sessionOrder(same, ['o/r#2', 'o/r#3'], 'updated'))).toEqual([3, 2]);
    expect(numbers(sessionOrder(found, ['o/r#999', 'o/r#82'], 'manual'))).toEqual([82]);
  });

  it('sorts a row with no valid time after the dated ones without losing it', () => {
    const mixed = [row(1, ''), row(2, '2026-10-21T10:00:00Z')];
    expect(sessionOrder(mixed, ['o/r#1', 'o/r#2'], 'updated')).toHaveLength(2);
  });
});

describe('allOrder', () => {
  it('orders every found row by the chosen key', () => {
    expect(numbers(allOrder(found, 'updated'))).toEqual([84, 82, 80, 86]);
    expect(numbers(allOrder(found, 'number'))).toEqual([86, 84, 82, 80]);
  });

  it('has no clicks to follow, so manual order goes by update time', () => {
    expect(numbers(allOrder(found, 'manual'))).toEqual([84, 82, 80, 86]);
  });

  it('takes only the repository of the first row: a session is over one repository', () => {
    const mixed = [row(5, '2026-10-21T10:00:00Z'), row(9, '2026-10-21T09:00:00Z', { repo: 'other' }), row(2, '2026-10-21T08:00:00Z')];
    expect(numbers(allOrder(mixed, 'updated'))).toEqual([5, 2]);
  });
});

describe('togglePickAll', () => {
  it('picks everything in the order of the sort, then clears when everything is picked', () => {
    const all = togglePickAll(found, [], 'number');
    expect(all).toEqual(['o/r#86', 'o/r#84', 'o/r#82', 'o/r#80']);
    expect(togglePickAll(found, all, 'number')).toEqual([]);
  });

  it('completes a partial pick rather than clearing it', () => {
    expect(togglePickAll(found, ['o/r#80'], 'updated')).toHaveLength(4);
  });

  it('picks nothing when no row says which repository it is in', () => {
    const unknown = [row(1, '2026-10-21T10:00:00Z', { owner: null, repo: null })];
    expect(togglePickAll(unknown, [], 'updated')).toEqual([]);
  });
});

describe('pickable', () => {
  const other = row(9, '2026-10-21T09:00:00Z', { repo: 'other' });
  const list = [...found, other];

  it('lets any row with a known repository start a pick', () => {
    expect(pickable(list, [], other)).toBe(true);
  });

  it('refuses a row of another repository once one is picked', () => {
    expect(pickable(list, ['o/r#84'], other)).toBe(false);
    expect(pickable(list, ['o/r#84'], found[1])).toBe(true);
  });

  it('refuses a row that does not say which repository it is in', () => {
    expect(pickable(list, [], row(1, '', { owner: null, repo: null }))).toBe(false);
  });
});

describe('positionOf', () => {
  it('is the 1-based place in the session, or null for a row that is not in it', () => {
    const ordered = sessionOrder(found, ['o/r#82', 'o/r#84'], 'manual');
    expect(positionOf(ordered, found[1])).toBe(1);
    expect(positionOf(ordered, found[0])).toBe(2);
    expect(positionOf(ordered, found[2])).toBeNull();
  });
});

describe('shortTitle', () => {
  it('drops a conventional-commit prefix', () => {
    expect(shortTitle('feat(local-review): пакетное ревью PR-ов')).toBe('пакетное ревью PR-ов');
    expect(shortTitle('fix: копирование пути')).toBe('копирование пути');
    expect(shortTitle('refactor(api)!: переименовать')).toBe('переименовать');
  });

  it('leaves a title without one, and a title that is only a prefix', () => {
    expect(shortTitle('Обновить vite до 8.3')).toBe('Обновить vite до 8.3');
    expect(shortTitle('Merge: main')).toBe('main');
    expect(shortTitle('feat:')).toBe('feat:');
  });
});

const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({
  id: 's1',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  prs: [84, 82, 80].map((number) => ({ number, title: `PR ${number}`, headRefName: `b${number}`, headSha: null })),
  current: 0,
  marks: {},
  visited: { 84: true },
  general: [],
  startedAt: '2026-10-21T10:00:00.000Z',
  finishedAt: null,
  ...over,
});

const c = (total: number, old = 0) => ({ total, old });

describe('statusOf', () => {
  it('is «не открыт» before the PR is opened and «открыт» after', () => {
    expect(statusOf(session(), 82, c(0))).toBe('todo');
    expect(statusOf(session(), 84, c(0))).toBe('seen');
    expect(statusOf(session(), 82, undefined)).toBe('todo');
  });

  it('shows a mark', () => {
    expect(statusOf(session({ marks: { 82: 'lgtm', 80: 'skip' } }), 82, c(0))).toBe('lgtm');
    expect(statusOf(session({ marks: { 82: 'lgtm', 80: 'skip' } }), 80, c(0))).toBe('skip');
  });

  it('puts comments of this session over a mark, and a mark over having looked', () => {
    expect(statusOf(session({ marks: { 84: 'lgtm' } }), 84, c(2))).toBe('comments');
    expect(statusOf(session({ marks: { 84: 'skip' } }), 84, c(0))).toBe('skip');
  });

  it('brings the mark back once the comments are gone', () => {
    const s = session({ marks: { 84: 'lgtm' } });
    expect(statusOf(s, 84, c(1))).toBe('comments');
    expect(statusOf(s, 84, c(0))).toBe('lgtm');
  });

  it('does not take comments from before the session for the reviewer\'s work', () => {
    expect(statusOf(session(), 82, c(3, 3))).toBe('old');
    expect(statusOf(session(), 84, c(3, 3))).toBe('old');
    // one written since: the PR has been worked on
    expect(statusOf(session(), 82, c(4, 3))).toBe('comments');
    // a mark made on such a PR is the reviewer's word and shows
    expect(statusOf(session({ marks: { 82: 'lgtm' } }), 82, c(3, 3))).toBe('lgtm');
  });
});

describe('freshCount', () => {
  it('is what was written since the session began, never negative', () => {
    expect(freshCount(c(5, 2))).toBe(3);
    expect(freshCount(c(1, 3))).toBe(0);
    expect(freshCount(undefined)).toBe(0);
  });
});

describe('statusLabel', () => {
  it('words every status, with the fresh count for comments', () => {
    expect(statusLabel('comments', c(5, 2))).toBe('есть замечания · 3');
    expect(statusLabel('lgtm', c(0))).toBe('без замечаний');
    expect(statusLabel('skip', c(0))).toBe('пропущен');
    expect(statusLabel('seen', c(0))).toBe('открыт, не отмечен');
    expect(statusLabel('todo', c(0))).toBe('не открыт');
  });

  it('says that old comments are there, and whether the PR was opened', () => {
    expect(statusLabel('old', c(3, 3))).toBe('не открыт · есть старые комментарии (3)');
    expect(statusLabel('old', c(3, 3), true)).toBe('открыт · есть старые комментарии (3)');
  });
});

describe('doneCount', () => {
  it('counts a PR as done when it has comments of this session or a mark, not when it was merely opened', () => {
    const s = session({ marks: { 82: 'lgtm' }, visited: { 84: true, 82: true, 80: true } });
    expect(doneCount(s, { 84: c(1), 82: c(0), 80: c(0) })).toBe(2);
    expect(doneCount(s, { 84: c(0), 82: c(0), 80: c(0) })).toBe(1);
  });

  it('does not count comments from before the session: a new session starts at nothing', () => {
    const fresh = session({ visited: { 84: true } });
    expect(doneCount(fresh, { 84: c(1, 1), 82: c(3, 3), 80: c(0) })).toBe(0);
  });
});

describe('prCount and prCountOf', () => {
  it('follows the Russian rule for 1 / 2–4 / the rest, teens included', () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 111].map(prCount)).toEqual([
      '1 PR', '2 PR-а', '4 PR-а', '5 PR-ов', '11 PR-ов', '12 PR-ов', '14 PR-ов', '21 PR', '22 PR-а', '25 PR-ов', '111 PR-ов',
    ]);
  });

  it('has no «-а» in the genitive after «из»', () => {
    expect([1, 2, 5, 11, 21].map(prCountOf)).toEqual(['1 PR', '2 PR-ов', '5 PR-ов', '11 PR-ов', '21 PR']);
  });
});

describe('oldCommentScopes', () => {
  const repo = { host: 'github.com', owner: 'o', repo: 'r' };

  it('asks about every comment when no session runs', () => {
    expect(oldCommentScopes(null, repo, [1, 2])).toEqual([{ before: undefined, numbers: [1, 2] }]);
  });

  it('limits PRs of the running session to what predates it, and takes all of the others', () => {
    expect(oldCommentScopes(session(), repo, [84, 1, 82])).toEqual([
      { before: undefined, numbers: [1] },
      { before: '2026-10-21T10:00:00.000Z', numbers: [84, 82] },
    ]);
  });

  it('knows nothing of a session over another repository', () => {
    expect(oldCommentScopes(session(), { ...repo, repo: 'other' }, [84])).toEqual([{ before: undefined, numbers: [84] }]);
  });
});

describe('sessionIndex and neighbourIndex', () => {
  const s = session();
  const pr = (number: number, over = {}) => ({ source: 'pr' as const, host: 'github.com', owner: 'o', repo: 'r', number, ...over });

  it('finds the session PR an address shows', () => {
    expect(sessionIndex(s, pr(80))).toBe(2);
    expect(sessionIndex(s, descriptorOf(s, s.prs[1]))).toBe(1);
  });

  it('is -1 for another number, another repository, a local folder and no review', () => {
    expect(sessionIndex(s, pr(1))).toBe(-1);
    expect(sessionIndex(s, pr(80, { repo: 'other' }))).toBe(-1);
    expect(sessionIndex(s, pr(80, { host: 'ghe.example' }))).toBe(-1);
    expect(sessionIndex(s, { source: 'local', root: '/x', mode: 'working', base: '' })).toBe(-1);
    expect(sessionIndex(s, null)).toBe(-1);
  });

  it('steps to the neighbours and stops at both ends', () => {
    expect(neighbourIndex(s, 1, 1)).toBe(2);
    expect(neighbourIndex(s, 1, -1)).toBe(0);
    expect(neighbourIndex(s, 0, -1)).toBeNull();
    expect(neighbourIndex(s, 2, 1)).toBeNull();
    expect(neighbourIndex(s, -1, 1)).toBeNull();
  });
});

describe('toggledMark', () => {
  it('sets a mark, switches to the other, and takes the same one off', () => {
    expect(toggledMark(undefined, 'lgtm')).toBe('lgtm');
    expect(toggledMark('lgtm', 'skip')).toBe('skip');
    expect(toggledMark('skip', 'skip')).toBeNull();
  });
});

describe('cleanup rows', () => {
  const counts = { 84: { total: 3, old: 2 }, 82: { total: 1, old: 0 }, 80: { total: 5, old: 5 } };

  it('lists the PRs that hold comments of an earlier session, in session order', () => {
    expect(cleanupRows(session(), counts).map((r) => [r.number, r.old])).toEqual([
      [84, 2],
      [80, 5],
    ]);
  });

  it('is empty when nothing predates the session', () => {
    expect(cleanupRows(session(), { 84: { total: 2, old: 0 } })).toEqual([]);
  });

  it('totals what is ticked: everything but the PRs the reviewer unticked', () => {
    const rows = cleanupRows(session(), counts);
    expect(cleanupTotal(rows, new Set())).toBe(7);
    expect(cleanupTotal(rows, new Set([80]))).toBe(2);
    expect(cleanupTotal(rows, new Set([80, 84]))).toBe(0);
  });
});
