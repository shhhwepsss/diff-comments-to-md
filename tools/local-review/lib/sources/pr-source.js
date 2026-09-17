'use strict';

const { gh, ghJson } = require('../gh');
const { parsePatch, MAX_TEXT_BYTES, TEXT_TOO_BIG_MESSAGE } = require('../diff');
const { descriptorKey } = require('../descriptor');
const { resolvePr } = require('../pr-search');
const { rangeLabel } = require('../commits');

const CACHE = new Map(); // descriptorKey -> { at, files }
const TTL_MS = 120000;

const SHA_CACHE = new Map(); // descriptorKey -> { at, mergeBaseSha, headRefOid }

// The well-known empty-tree object id: every git object database has it,
// including GitHub's — used as the left side of a commit range that starts
// at the PR's root commit (no parent to diff against).
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// "owner/repo:sha" -> { at, left } — the first parent of a commit-range's
// `from`, resolved once per sha (a sha is immutable, so this never expires
// beyond the same TTL as everything else here; it just avoids a refetch on
// every /api/diff call for the same range).
const RANGE_LEFT_CACHE = new Map();

// Content is addressed by (commit sha, path): a sha is immutable, so once a
// blob is fetched it never needs to be refetched or expired — only bounded so
// a long-lived server does not grow this map without limit.
const CONTENT_CACHE = new Map(); // "<sha>:<path>" -> string | null
const CONTENT_CACHE_LIMIT = 200;

function cacheContent(key, value) {
  // Re-inserting moves the key to the end (Map preserves insertion order),
  // which is what makes the eviction below a simple LRU.
  CONTENT_CACHE.delete(key);
  CONTENT_CACHE.set(key, value);
  if (CONTENT_CACHE.size > CONTENT_CACHE_LIMIT) {
    CONTENT_CACHE.delete(CONTENT_CACHE.keys().next().value);
  }
}

/** GitHub API paths are segment-encoded, not whole-string-encoded: a literal
 * "/" in the URL is a path separator, so only the parts between slashes may
 * be percent-encoded (this is what lets paths carry spaces and Cyrillic). */
function encodePathSegments(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Verified against gh 2.96.0 (2026-09-11) with a real request to a public
 * repo: `gh api -H "Accept: application/vnd.github.raw+json"
 * "repos/cli/cli/contents/README.md?ref=trunk"` prints the file's raw bytes
 * on stdout — not the default JSON-with-base64 envelope. Per GitHub's REST
 * docs for "Get repository content", the raw/html media types work up to
 * 100 MB (the default JSON+base64 response is capped at 1 MB); we still cap
 * at MAX_TEXT_BYTES (5 MB, lib/diff.js) below, well under either limit.
 * A 404 (path absent at that sha — the "added"/"deleted" side of a diff)
 * comes back as gh exit code 1 with a JSON error body and a "Not Found"
 * stderr line, classified by lib/gh.js as ghReason 'not-found' — treated
 * here as "no text", not as a failure.
 * IMPORTANT gh limitation, discovered while implementing this: `gh api` with
 * this raw Accept header fails on *binary* content ("transform: short source
 * buffer", exit 1, truncated stdout) — some internal gh templating step
 * chokes on non-UTF8 bytes even though the Accept header asked for raw. This
 * is harmless here because a binary entry never reaches fetchContent at all
 * (loadPrTexts below returns nulls for entry.binary before ever calling gh).
 */
async function fetchContent(descriptor, sha, filePath) {
  const key = `${sha}:${filePath}`;
  if (CONTENT_CACHE.has(key)) {
    const cached = CONTENT_CACHE.get(key);
    cacheContent(key, cached); // touch for LRU
    return cached;
  }

  const url =
    `repos/${descriptor.owner}/${descriptor.repo}/contents/` +
    `${encodePathSegments(filePath)}?ref=${encodeURIComponent(sha)}`;
  let text = null;
  try {
    text = await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', url]);
  } catch (e) {
    if (e.ghReason !== 'not-found') throw e;
  }
  cacheContent(key, text);
  return text;
}

/**
 * The PR's two endpoints, resolved once and cached like `loadFiles` below
 * (same 120 s TTL, same `fresh` bypass): `gh pr view` for the branch tips,
 * then GitHub's compare API for the merge-base between them. Diffing against
 * baseRefOid directly would show every commit already on the base branch
 * since the PR was opened as a "change" — the merge-base is what `git diff
 * <mb> HEAD` / GitHub's own PR view actually compare against.
 */
async function loadShas(descriptor, fresh) {
  const key = descriptorKey(descriptor);
  const hit = SHA_CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;

  const view = await ghJson([
    'pr',
    'view',
    String(descriptor.number),
    '--repo',
    `${descriptor.owner}/${descriptor.repo}`,
    '--json',
    'baseRefOid,headRefOid',
  ]);
  const compare = await ghJson([
    'api',
    `repos/${descriptor.owner}/${descriptor.repo}/compare/${view.baseRefOid}...${view.headRefOid}`,
  ]);
  const mergeBaseSha = (compare.merge_base_commit && compare.merge_base_commit.sha) || view.baseRefOid;

  const result = { at: Date.now(), mergeBaseSha, headRefOid: view.headRefOid };
  SHA_CACHE.set(key, result);
  return result;
}

/**
 * old = merge-base:<oldPath ?? path>, new = head:<path>. Like the local-mode
 * loadTexts (lib/diff.js), the "added" (no old side) / "deleted" (no new
 * side) cases are not special-cased: fetchContent naturally returns null
 * when the path does not exist at that sha.
 */
async function loadPrTexts(descriptor, shas, entry) {
  if (entry.binary) return { oldText: null, newText: null };

  const oldPath = entry.oldPath || entry.path;
  const oldText = await fetchContent(descriptor, shas.mergeBaseSha, oldPath);
  const newText = await fetchContent(descriptor, shas.headRefOid, entry.path);

  const tooBig = (t) => t !== null && Buffer.byteLength(t, 'utf8') > MAX_TEXT_BYTES;
  if (tooBig(oldText) || tooBig(newText)) {
    return { oldText: null, newText: null, textUnavailable: TEXT_TOO_BIG_MESSAGE };
  }
  return { oldText, newText };
}

/** git quotes non-ASCII paths as "a/\320\264..."; undo that. */
function unquotePath(value) {
  if (!value.startsWith('"')) return value;
  const inner = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const next = inner[i + 1];
    if (/^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
    bytes.push(map[next] === undefined ? next.charCodeAt(0) : map[next]);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p) {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/**
 * Cuts `gh pr diff` output on `diff --git` boundaries, one block per file, and
 * reads status from the block header. The body goes to the existing parsePatch
 * (lib/diff.js:102) untouched — that is the whole point: line numbers in PR
 * mode are computed by exactly the same code as in local mode.
 */
function splitPrDiff(text) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { header: [line], body: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@') || current.body.length) current.body.push(line);
    else current.header.push(line);
  }

  return blocks
    .map((block) => {
      const head = block.header.join('\n');
      let status = 'M';
      let kind = 'M';
      let oldPath = null;

      const gitLine = /^diff --git (\S+|".*?") (\S+|".*?")$/m.exec(block.header[0]);
      let newPath = gitLine ? stripPrefix(unquotePath(gitLine[2])) : null;
      let fromPath = gitLine ? stripPrefix(unquotePath(gitLine[1])) : null;

      const minus = /^--- (\S+|".*?")$/m.exec(head);
      const plus = /^\+\+\+ (\S+|".*?")$/m.exec(head);
      if (plus) {
        const p = stripPrefix(unquotePath(plus[1]));
        if (p) newPath = p;
      }
      if (minus) {
        const p = stripPrefix(unquotePath(minus[1]));
        if (p) fromPath = p;
      }

      if (/^new file mode /m.test(head)) {
        status = 'A';
        kind = 'A';
      } else if (/^deleted file mode /m.test(head)) {
        status = 'D';
        kind = 'D';
        newPath = fromPath;
      } else if (/^rename to /m.test(head)) {
        status = 'R';
        kind = 'R';
        oldPath = unquotePath((/^rename from (.*)$/m.exec(head) || [])[1] || '') || fromPath;
        newPath = unquotePath((/^rename to (.*)$/m.exec(head) || [])[1] || '') || newPath;
      } else if (/^copy to /m.test(head)) {
        status = 'C';
        kind = 'C';
        oldPath = unquotePath((/^copy from (.*)$/m.exec(head) || [])[1] || '') || fromPath;
        newPath = unquotePath((/^copy to (.*)$/m.exec(head) || [])[1] || '') || newPath;
      }

      // Binary markers sit in the header, not the body: keep them for parsePatch.
      const binaryHeader = /^(Binary files .* differ|GIT binary patch)$/m.test(head);
      const body = (
        binaryHeader
          ? block.header.filter((l) => /^(Binary files|GIT binary patch)/.test(l))
          : []
      )
        .concat(block.body)
        .join('\n');

      return { path: newPath, oldPath, status, kind, body };
    })
    .filter((f) => f.path);
}

/** One `gh pr diff` per descriptor: /api/diff must not hit the network per file. */
async function loadFiles(descriptor, fresh) {
  const key = descriptorKey(descriptor);
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.files;

  const text = await gh([
    'pr',
    'diff',
    String(descriptor.number),
    '--repo',
    `${descriptor.owner}/${descriptor.repo}`,
  ]);
  const files = splitPrDiff(text)
    .map((f) => {
      const parsed = parsePatch(f.body);
      return {
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        kind: f.kind,
        hunks: parsed.hunks,
        binary: parsed.binary,
        additions: parsed.additions,
        deletions: parsed.deletions,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  CACHE.set(key, { at: Date.now(), files });
  return files;
}

/**
 * The first parent of a commit-range's `from`, via GitHub's single-commit
 * API — mirrors lib/commits.js's `${from}^` for the local source, since we
 * have no local clone to ask git directly. A root commit (no parents) falls
 * back to the empty tree, exactly like lib/commits.js's own root-commit case.
 */
async function resolveRangeLeft(descriptor, fresh) {
  const key = `${descriptor.owner}/${descriptor.repo}:${descriptor.from}`;
  const hit = RANGE_LEFT_CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.left;

  const commit = await ghJson([
    'api',
    `repos/${descriptor.owner}/${descriptor.repo}/commits/${descriptor.from}`,
  ]);
  const parents = commit.parents || [];
  const left = parents.length ? parents[0].sha : EMPTY_TREE_SHA1;
  RANGE_LEFT_CACHE.set(key, { at: Date.now(), left });
  return left;
}

/**
 * One entry of GitHub's "compare two commits" `files` array -> our shape.
 * The compare API has no explicit binary flag, and it reports 0/0 line counts
 * without a `patch` for changed binary files too. The only patch-less entry
 * that is known to be textual is a pure rename/copy (or an empty file being
 * added/removed) with no changes; everything else without a patch is treated
 * as binary, so the diff view shows a placeholder instead of trying to fetch
 * bytes that `gh api` cannot return as text.
 */
function mapCompareFile(f) {
  const STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' };
  const status = STATUS[f.status] || 'M';
  const additions = f.additions || 0;
  const deletions = f.deletions || 0;
  const unchanged = (f.changes || additions + deletions) === 0;
  const textualWithoutPatch = unchanged && ['renamed', 'copied', 'added', 'removed'].includes(f.status);
  const binary = !f.patch && !textualWithoutPatch;
  const parsed = f.patch ? parsePatch(f.patch) : { hunks: [], binary, additions, deletions };
  return {
    path: f.filename,
    oldPath: f.previous_filename || null,
    status,
    kind: status,
    hunks: parsed.hunks,
    binary: f.patch ? parsed.binary : binary,
    additions: f.patch ? parsed.additions : additions,
    deletions: f.patch ? parsed.deletions : deletions,
  };
}

// GitHub pages the compare `files` list (300 per page by default, 3000 max
// overall); ask for 100 at a time and keep going until a short page.
const COMPARE_PER_PAGE = 100;
const COMPARE_MAX_PAGES = 30;

/** `gh api .../compare/left...to`, all pages, per (descriptor, from, to): same shape of caching as loadFiles above. */
async function loadCommitRangeFiles(descriptor, fresh) {
  const key = descriptorKey(descriptor); // includes from/to (lib/descriptor.js)
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;

  const left = await resolveRangeLeft(descriptor, fresh);
  const raw = [];
  for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
    const compare = await ghJson([
      'api',
      `repos/${descriptor.owner}/${descriptor.repo}/compare/${left}...${descriptor.to}` +
        `?per_page=${COMPARE_PER_PAGE}&page=${page}`,
    ]);
    const pageFiles = compare.files || [];
    raw.push(...pageFiles);
    if (pageFiles.length < COMPARE_PER_PAGE) break;
  }
  const files = raw.map(mapCompareFile).sort((a, b) => a.path.localeCompare(b.path));

  const result = { at: Date.now(), files, left };
  CACHE.set(key, result);
  return result;
}

function createPrSource(descriptor) {
  const inRange = Boolean(descriptor.from && descriptor.to);
  return {
    id: descriptorKey(descriptor),
    kind: 'pr',
    descriptor,
    async meta() {
      return resolvePr(descriptor);
    },
    async listFiles(options) {
      const fresh = options && options.fresh;
      if (inRange) {
        const { files } = await loadCommitRangeFiles(descriptor, fresh);
        return {
          files: files.map((f) => ({
            path: f.path,
            oldPath: f.oldPath,
            status: f.status,
            kind: f.kind,
            additions: f.additions,
            deletions: f.deletions,
          })),
          range: { label: rangeLabel(descriptor.from, descriptor.to) },
        };
      }
      const files = await loadFiles(descriptor, fresh);
      return {
        files: files.map((f) => ({
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
          kind: f.kind,
          additions: f.additions,
          deletions: f.deletions,
        })),
        range: { label: `${descriptor.owner}/${descriptor.repo}#${descriptor.number}` },
      };
    },
    async fileDiff(filePath, context, options) {
      const fresh = options && options.fresh;
      if (inRange) {
        const { files, left } = await loadCommitRangeFiles(descriptor, fresh);
        const entry = files.find((f) => f.path === filePath);
        if (!entry) {
          const err = new Error(`Файл "${filePath}" отсутствует в диффе выбранных коммитов.`);
          err.userFacing = true;
          err.status = 404;
          throw err;
        }
        // Reuses loadPrTexts as-is: a commit range's (left, to) pair is the
        // same shape as a PR's (mergeBaseSha, headRefOid) pair, just with
        // different actual shas.
        const texts = await loadPrTexts(descriptor, { mergeBaseSha: left, headRefOid: descriptor.to }, entry);
        return Object.assign({}, entry, texts);
      }
      const files = await loadFiles(descriptor, fresh);
      const entry = files.find((f) => f.path === filePath);
      if (!entry) {
        const err = new Error(`Файл "${filePath}" отсутствует в диффе этого PR-а.`);
        err.userFacing = true;
        err.status = 404;
        throw err;
      }
      // `context` is ignored on purpose: the local source can vary -U<n>
      // (lib/diff.js:218), GitHub cannot — it always hands back a fixed -U3.
      const shas = await loadShas(descriptor, fresh);
      const texts = await loadPrTexts(descriptor, shas, entry);
      return Object.assign({}, entry, texts);
    },
  };
}

module.exports = { createPrSource, splitPrDiff, unquotePath };
