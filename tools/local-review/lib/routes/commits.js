'use strict';

const { sendJson } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { defaultBase } = require('../git');
const { listCommits, uncommittedSummary } = require('../commits');
const { ghJson } = require('../gh');

// Keyed by "host/owner/repo#number" — the PR's commit list does not depend on
// any from/to selection, so it is cached independently of descriptorKey
// (which folds from/to in for the range-diff caches in lib/sources/pr-source.js).
const PR_COMMITS_CACHE = new Map();
const TTL_MS = 120000;

// GitHub's "list commits on a pull request" endpoint does not return commits
// older than ~250 from the tip, regardless of pagination — see
// https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request.
const PER_PAGE = 100;
const HARD_CAP = 250;

function isFresh(url) {
  return url.searchParams.get('fresh') === '1';
}

function prCacheKey(d) {
  return `${d.host}/${d.owner}/${d.repo}#${d.number}`;
}

/** One entry of `GET .../pulls/{number}/commits` -> our Commit shape. */
function mapGhCommit(entry) {
  const sha = entry.sha;
  const commit = entry.commit || {};
  const author = commit.author || {};
  const parents = (entry.parents || []).map((p) => p.sha);
  const lines = String(commit.message || '').split('\n');
  return {
    sha,
    short: sha.slice(0, 7),
    parents,
    author: author.name || (entry.author && entry.author.login) || '',
    date: author.date || '',
    committedAt: (commit.committer && commit.committer.date) || author.date || '',
    subject: lines[0] || '',
    body: lines.slice(1).join('\n').replace(/^\s+/, ''),
    merge: parents.length > 1,
    root: parents.length === 0,
  };
}

/**
 * Pages `.../pulls/{number}/commits` by hand instead of `gh api --paginate`:
 * that flag concatenates each page's raw JSON array back to back, which is
 * not valid JSON for a single `JSON.parse` (lib/gh.js's ghJson) unless `gh`
 * is also told to slurp them into one array. Paging manually keeps this
 * independent of that gh-version detail and easy to drive from a fixture.
 */
async function fetchAllPrCommits(descriptor) {
  let page = 1;
  let all = [];
  for (;;) {
    const url =
      `repos/${descriptor.owner}/${descriptor.repo}/pulls/${descriptor.number}/commits` +
      `?per_page=${PER_PAGE}&page=${page}`;
    const batch = await ghJson(['api', url]);
    all = all.concat(batch);
    if (batch.length < PER_PAGE || all.length >= HARD_CAP) break;
    page += 1;
  }
  const truncated = all.length >= HARD_CAP;
  if (truncated) all = all.slice(0, HARD_CAP);
  return { commits: all.map(mapGhCommit), truncated };
}

async function loadPrCommits(descriptor, fresh) {
  const key = prCacheKey(descriptor);
  const hit = PR_COMMITS_CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;

  const view = await ghJson([
    'pr',
    'view',
    String(descriptor.number),
    '--repo',
    `${descriptor.owner}/${descriptor.repo}`,
    '--json',
    'baseRefName',
  ]);
  const { commits, truncated } = await fetchAllPrCommits(descriptor);

  const result = { at: Date.now(), commits, truncated, base: view.baseRefName || null };
  PR_COMMITS_CACHE.set(key, result);
  return result;
}

async function list(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);

  if (descriptor.source === 'local') {
    const base = descriptor.base || (await defaultBase(descriptor.root));
    const [history, dirty] = await Promise.all([
      listCommits(descriptor.root, base),
      uncommittedSummary(descriptor.root),
    ]);
    sendJson(res, 200, {
      commits: history.commits,
      truncated: history.truncated,
      fallback: history.fallback,
      base: history.base,
      dirty,
    });
    return;
  }

  if (descriptor.source === 'pr') {
    const { commits, truncated, base } = await loadPrCommits(descriptor, isFresh(url));
    sendJson(res, 200, {
      commits,
      truncated,
      fallback: false,
      base,
      dirty: { dirty: false, files: 0 },
    });
    return;
  }

  const err = new Error(`Неизвестный источник: ${descriptor.source}`);
  err.userFacing = true;
  err.status = 400;
  throw err;
}

module.exports = { list };
