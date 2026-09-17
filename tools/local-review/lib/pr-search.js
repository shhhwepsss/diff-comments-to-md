'use strict';

const { ghJson } = require('./gh');

const STATES = new Set(['open', 'closed', 'merged', 'all']);
const AUTHORS = new Set(['all', 'mine']);

function bad(message) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = 400;
  return err;
}

function normalizeState(state) {
  const s = state || 'open';
  if (!STATES.has(s)) throw bad(`Неизвестное состояние: ${s} (open | closed | merged | all)`);
  return s;
}

/** all = everyone's PRs; mine = only PRs opened by the logged-in gh user (@me). */
function normalizeAuthor(author) {
  const a = author || 'all';
  if (!AUTHORS.has(a)) throw bad(`Неизвестный фильтр автора: ${a} (all | mine)`);
  return a;
}

function splitRepo(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo).trim());
  if (!m) throw bad('Репозиторий указывается как owner/repo');
  return { owner: m[1], repo: m[2] };
}

/**
 * Two commands behind one result shape. The repository field is optional:
 * with it we get the branch name, without it gh search prs does not expose
 * headRefName at all (checked on gh 2.96.0), so it stays null until the PR
 * is opened.
 *
 * The author filter goes to gh as a flag, so the user's free-text query is
 * passed through untouched. It only changes the repository listing: without a
 * repository "all" cannot mean all of GitHub, so the global search is always
 * scoped to the user's own PRs, whatever the filter says.
 */
async function searchPrs({ repo, q, state, limit, author }) {
  const s = normalizeState(state);
  const who = normalizeAuthor(author);
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const query = (q || '').trim();

  if (repo) {
    const { owner, repo: name } = splitRepo(repo);
    const args = [
      'pr',
      'list',
      '--repo',
      `${owner}/${name}`,
      '--limit',
      String(n),
      '--json',
      'number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft',
    ];
    if (query) args.push('--search', query);
    if (who === 'mine') args.push('--author', '@me');
    args.push('--state', s);
    const rows = await ghJson(args);
    return {
      mode: 'repo',
      items: rows.map((r) => ({
        host: 'github.com',
        owner,
        repo: name,
        number: r.number,
        title: r.title,
        author: r.author ? r.author.login : null,
        headRefName: r.headRefName || null,
        baseRefName: r.baseRefName || null,
        state: r.state,
        isDraft: Boolean(r.isDraft),
        updatedAt: r.updatedAt,
        url: r.url,
      })),
    };
  }

  const args = [
    'search',
    'prs',
    '--author=@me',
    '--limit',
    String(n),
    '--json',
    'number,title,repository,author,state,updatedAt,url,isDraft',
  ];
  if (s === 'merged') args.push('--merged');
  else if (s !== 'all') args.push(`--state=${s}`);
  if (query) args.push(query);
  const rows = await ghJson(args);
  return {
    mode: 'global',
    items: rows.map((r) => {
      const full = (r.repository && r.repository.nameWithOwner) || '';
      const [owner, name] = full.split('/');
      return {
        host: 'github.com',
        owner: owner || null,
        repo: name || null,
        number: r.number,
        title: r.title,
        author: r.author ? r.author.login : null,
        headRefName: null,
        baseRefName: null,
        state: r.state,
        isDraft: Boolean(r.isDraft),
        updatedAt: r.updatedAt,
        url: r.url,
      };
    }),
  };
}

/** The screen header, and the place a globally-found PR gets its branch name. */
async function resolvePr({ host, owner, repo, number }) {
  const row = await ghJson([
    'pr',
    'view',
    String(number),
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url',
  ]);
  return {
    host: host || 'github.com',
    owner,
    repo,
    number: row.number,
    title: row.title,
    author: row.author ? row.author.login : null,
    state: row.state,
    isDraft: Boolean(row.isDraft),
    headRefName: row.headRefName || null,
    baseRefName: row.baseRefName || null,
    headSha: row.headRefOid || null,
    url: row.url,
  };
}

module.exports = { searchPrs, resolvePr, normalizeState, normalizeAuthor, splitRepo };
