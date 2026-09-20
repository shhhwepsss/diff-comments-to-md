'use strict';

const { ghJson } = require('./gh');

// One page is deliberate: the picker is a convenience over the manual input,
// not a complete mirror of GitHub. A repository past the first hundred is
// still reachable by typing owner/repo, which is what the field did before.
const PER_PAGE = 100;

/**
 * The repositories the logged-in user can open PRs in, newest push first.
 *
 * `/user/repos` with all three affiliations is a superset of `gh repo list`:
 * the latter only knows the repositories the user owns, so repositories they
 * were added to as a collaborator or through an organization would never
 * appear in the picker (checked on gh 2.96.0: 35 rows against 28).
 *
 * The response of that endpoint is large — a hundred repositories carry
 * hundreds of kilobytes of fields we do not use — so gh's built-in --jq
 * reduces every row to the three fields the screen needs before the JSON
 * ever reaches this process.
 *
 * Not cached: a call takes about 1.5 s and happens once per visit to the PR
 * screen, in parallel with the first search. If that ever becomes a problem,
 * a cache goes here and nothing else changes.
 */
async function listRepos() {
  const rows = await ghJson([
    'api',
    `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${PER_PAGE}`,
    '--jq',
    '[.[] | {nameWithOwner: .full_name, pushedAt: .pushed_at, isPrivate: .private}]',
  ]);
  return normalizeRepos(rows);
}

/**
 * Whatever gh returned, shaped into the list the screen renders: rows without
 * a name dropped, duplicates removed (a repository can match more than one
 * affiliation), newest push first. GitHub already sorts by push, but a row
 * can carry a null `pushed_at`, and those belong at the end rather than
 * wherever the API happened to put them.
 */
function normalizeRepos(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    if (!row || typeof row.nameWithOwner !== 'string') continue;
    const nameWithOwner = row.nameWithOwner.trim();
    if (!nameWithOwner || seen.has(nameWithOwner)) continue;
    seen.add(nameWithOwner);
    items.push({
      nameWithOwner,
      pushedAt: typeof row.pushedAt === 'string' ? row.pushedAt : null,
      isPrivate: Boolean(row.isPrivate),
    });
  }
  items.sort((a, b) => {
    if (a.pushedAt === b.pushedAt) return a.nameWithOwner.localeCompare(b.nameWithOwner);
    if (!a.pushedAt) return 1;
    if (!b.pushedAt) return -1;
    return a.pushedAt < b.pushedAt ? 1 : -1;
  });
  return items;
}

module.exports = { listRepos, normalizeRepos, PER_PAGE };
