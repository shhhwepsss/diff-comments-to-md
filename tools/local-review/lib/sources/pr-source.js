'use strict';

const { gh, ghJson } = require('../gh');
const { parsePatch, MAX_TEXT_BYTES, TEXT_TOO_BIG_MESSAGE } = require('../diff');
const { descriptorKey } = require('../descriptor');
const { resolvePr } = require('../pr-search');
const { rangeLabel } = require('../commits');
const { fingerprintOf } = require('../viewed');

// descriptorKey -> { at, files, truncated } and, for a whole PR, `ends`: the
// two commits its patch was made between.
const CACHE = new Map();
const TTL_MS = 120000;

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
 * The two commits a PR's texts are read at: the branch tips its patch came
 * with (`ends`, see loadFiles), the base one replaced by GitHub's compare API
 * answer for the merge-base between them. Diffing against baseRefOid directly
 * would show every commit already on the base branch since the PR was opened
 * as a "change" — the merge-base is what `git diff <mb> HEAD` / GitHub's own
 * PR view actually compare against.
 */
async function loadShas(descriptor, ends) {
  // The merge-base of two given commits never changes.
  const compare = await ghJson(
    ['api', `repos/${descriptor.owner}/${descriptor.repo}/compare/${ends.baseSha}...${ends.headSha}`],
    { immutable: true }
  );
  const mergeBaseSha = (compare.merge_base_commit && compare.merge_base_commit.sha) || ends.baseSha;
  return { mergeBaseSha, headRefOid: ends.headSha };
}

/**
 * old = merge-base:<oldPath ?? path>, new = head:<path>. Like the local-mode
 * loadTexts (lib/diff.js), the "added" (no old side) / "deleted" (no new
 * side) cases are not special-cased: fetchContent naturally returns null
 * when the path does not exist at that sha.
 */
async function loadPrTexts(descriptor, shas, entry) {
  if (entry.binary && !entry.binaryUnsure) return { oldText: null, newText: null };

  const oldPath = entry.oldPath || entry.path;
  let oldText;
  let newText;
  try {
    [oldText, newText] = await Promise.all([
      fetchContent(descriptor, shas.mergeBaseSha, oldPath),
      fetchContent(descriptor, shas.headRefOid, entry.path),
    ]);
  } catch (e) {
    // gh cannot print binary content (see fetchContent above): for an entry
    // the API left undecided, that failure is the answer.
    if (!entry.binaryUnsure || !/short source buffer/.test(e.message)) throw e;
    return { oldText: null, newText: null, binary: true };
  }
  // Undecided and readable as text: not binary. It has no hunks, the client
  // diffs the two texts itself; the counts are known only when there is
  // nothing to count.
  const decided = {};
  if (entry.binaryUnsure) {
    if (`${oldText}${newText}`.includes('\0')) return { oldText: null, newText: null, binary: true };
    decided.binary = false;
    if (oldText === newText) Object.assign(decided, { additions: 0, deletions: 0 });
  }

  const tooBig = (t) => t !== null && Buffer.byteLength(t, 'utf8') > MAX_TEXT_BYTES;
  if (tooBig(oldText) || tooBig(newText)) {
    return Object.assign({ oldText: null, newText: null, textUnavailable: TEXT_TOO_BIG_MESSAGE }, decided);
  }
  return Object.assign({ oldText, newText }, decided);
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

      // The whole block, header included: its `index <old>..<new>` line
      // changes with either blob, even for a binary file whose body is empty.
      const fingerprint = fingerprintOf([kind, oldPath, newPath, block.header, block.body]);
      return { path: newPath, oldPath, status, kind, body, fingerprint };
    })
    .filter((f) => f.path);
}

// GitHub refuses to render a whole PR as one diff above 300 files or 20000
// lines: "HTTP 406: Sorry, the diff exceeded the maximum number of files
// (300). Consider using 'List pull requests files' API ...". Only this refusal
// switches to that API; any other 406 stays the error it is.
const DIFF_TOO_LARGE = /HTTP 406.*exceeded the maximum number of/;

/**
 * One `gh pr diff` per descriptor: /api/diff must not hit the network per file.
 * The PR's two ends are asked for beside the patch and kept with it, so a
 * file's hunks are never paired with the texts of another head: one entry,
 * one moment.
 */
async function loadFiles(descriptor, fresh) {
  const key = descriptorKey(descriptor);
  const hit = CACHE.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit;

  const [text, pr] = await Promise.all([
    gh(['pr', 'diff', String(descriptor.number), '--repo', `${descriptor.owner}/${descriptor.repo}`]).catch((e) => {
      if (!DIFF_TOO_LARGE.test(e.message)) throw e;
      return null;
    }),
    resolvePr(descriptor, { fresh: true }),
  ]);
  const ends = { baseSha: pr.baseSha, headSha: pr.headSha };
  if (text === null) {
    const result = Object.assign({ at: Date.now(), ends }, await loadPrFilesPaged(descriptor));
    CACHE.set(key, result);
    return result;
  }
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
        fingerprint: f.fingerprint,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const result = { at: Date.now(), files, truncated: null, ends };
  CACHE.set(key, result);
  return result;
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

  // A commit's parents never change.
  const commit = await ghJson(['api', `repos/${descriptor.owner}/${descriptor.repo}/commits/${descriptor.from}`], {
    immutable: true,
  });
  const parents = commit.parents || [];
  const left = parents.length ? parents[0].sha : EMPTY_TREE_SHA1;
  RANGE_LEFT_CACHE.set(key, { at: Date.now(), left });
  return left;
}

/**
 * One entry of GitHub's "compare two commits" `files` array -> our shape
 * ("list pull request files" returns the same entries). The API has no
 * explicit binary flag, and it reports 0/0 line counts without a `patch` for
 * changed binary files. A patch-less entry is textual when it is a pure
 * rename/copy (or an empty file being added/removed) with no changes, or when
 * it does count changed lines: that is a text file whose patch GitHub left
 * out as too large — it gets no hunks, and the client diffs the two texts
 * itself. Everything else without a patch is listed as binary — but only as
 * a guess (`binaryUnsure`): in a large diff GitHub stops computing patches
 * and reports a plain text file the same 0/0 way (156 of the 656 files of
 * microsoft/TypeScript#51387). loadPrTexts settles it when the file is
 * opened, by whether its content can be read as text.
 */
function mapCompareFile(f) {
  const STATUS = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' };
  const status = STATUS[f.status] || 'M';
  const additions = f.additions || 0;
  const deletions = f.deletions || 0;
  const unchanged = (f.changes || additions + deletions) === 0;
  const textualWithoutPatch = unchanged && ['renamed', 'copied', 'added', 'removed'].includes(f.status);
  const binary = !f.patch && unchanged && !textualWithoutPatch;
  const parsed = f.patch ? parsePatch(f.patch) : { hunks: [], binary, additions, deletions };
  return {
    path: f.filename,
    oldPath: f.previous_filename || null,
    status,
    kind: status,
    hunks: parsed.hunks,
    binary: f.patch ? parsed.binary : binary,
    binaryUnsure: !f.patch && unchanged,
    // No patch and 0/0: the counts are as undecided as `binary` is.
    additions: f.patch ? parsed.additions : unchanged ? null : additions,
    deletions: f.patch ? parsed.deletions : unchanged ? null : deletions,
    // The compare API has no old blob id; the patch covers the old side of a
    // text file, and `sha` (the new blob) the rest.
    fingerprint: fingerprintOf([status, f.previous_filename || null, f.filename, f.sha || null, f.patch || null]),
  };
}

// GitHub pages the compare `files` list (300 per page by default, 3000 max
// overall); ask for 100 at a time and keep going until a short page.
const COMPARE_PER_PAGE = 100;
const COMPARE_MAX_PAGES = 30;
// What it does in practice (checked on microsoft/TypeScript#51387, a range of
// 656 files): the first page carries at most 300 files whatever `per_page`
// says, and every later page carries none.
const COMPARE_FILES_MAX = 300;

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
  // At the cap GitHub gives no more, and does not say how many there are.
  const truncated = raw.length >= COMPARE_FILES_MAX ? { shown: raw.length, total: null, limit: COMPARE_FILES_MAX } : null;

  const result = { at: Date.now(), files, left, truncated };
  CACHE.set(key, result);
  return result;
}

// "List pull request files": 100 per page at most, 3000 files overall.
const PR_FILES_PER_PAGE = 100;
const PR_FILES_MAX = 3000;
const PR_FILES_PARALLEL = 5;

/**
 * The file list of a PR too large for `gh pr diff` (see DIFF_TOO_LARGE), from
 * `gh api .../pulls/{n}/files`. The PR itself is asked first for
 * `changed_files`: it tells how many pages there are, so they can be fetched a
 * few at a time instead of one by one, and whether GitHub's 3000-file cap cut
 * the list (`truncated`).
 */
async function loadPrFilesPaged(descriptor) {
  const pull = `repos/${descriptor.owner}/${descriptor.repo}/pulls/${descriptor.number}`;
  const total = (await ghJson(['api', pull])).changed_files || 0;
  const pages = Math.max(1, Math.ceil(Math.min(total, PR_FILES_MAX) / PR_FILES_PER_PAGE));
  const raw = [];
  for (let first = 1; first <= pages; first += PR_FILES_PARALLEL) {
    const batch = [];
    for (let page = first; page < first + PR_FILES_PARALLEL && page <= pages; page += 1) {
      batch.push(ghJson(['api', `${pull}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`]));
    }
    for (const pageFiles of await Promise.all(batch)) raw.push(...pageFiles);
  }
  return {
    files: raw.map(mapCompareFile).sort((a, b) => a.path.localeCompare(b.path)),
    truncated: total > raw.length ? { shown: raw.length, total, limit: PR_FILES_MAX } : null,
  };
}

/**
 * A cached file -> its row of the /api/state list. A binary file has no
 * lines, so its counts are null rather than the 0/0 the parsers report.
 */
function listEntry(f) {
  return {
    path: f.path,
    oldPath: f.oldPath,
    status: f.status,
    kind: f.kind,
    additions: f.binary ? null : f.additions,
    deletions: f.binary ? null : f.deletions,
    fingerprint: f.fingerprint,
  };
}

function createPrSource(descriptor) {
  const inRange = Boolean(descriptor.from && descriptor.to);
  return {
    id: descriptorKey(descriptor),
    kind: 'pr',
    descriptor,
    async meta(options) {
      return resolvePr(descriptor, options);
    },
    async listFiles(options) {
      const fresh = options && options.fresh;
      if (inRange) {
        const { files, truncated } = await loadCommitRangeFiles(descriptor, fresh);
        return {
          files: files.map(listEntry),
          range: { label: rangeLabel(descriptor.from, descriptor.to) },
          truncated,
        };
      }
      const { files, truncated } = await loadFiles(descriptor, fresh);
      return {
        files: files.map(listEntry),
        range: { label: `${descriptor.owner}/${descriptor.repo}#${descriptor.number}` },
        truncated,
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
      const { files, ends } = await loadFiles(descriptor, fresh);
      const entry = files.find((f) => f.path === filePath);
      if (!entry) {
        const err = new Error(`Файл "${filePath}" отсутствует в диффе этого PR-а.`);
        err.userFacing = true;
        err.status = 404;
        throw err;
      }
      // `context` is ignored on purpose: the local source can vary -U<n>
      // (lib/diff.js:218), GitHub cannot — it always hands back a fixed -U3.
      const shas = await loadShas(descriptor, ends);
      const texts = await loadPrTexts(descriptor, shas, entry);
      return Object.assign({}, entry, texts);
    },
  };
}

module.exports = { createPrSource, splitPrDiff, unquotePath };
