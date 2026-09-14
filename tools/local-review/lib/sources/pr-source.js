'use strict';

const { gh } = require('../gh');
const { parsePatch } = require('../diff');
const { descriptorKey } = require('../descriptor');
const { resolvePr } = require('../pr-search');

const CACHE = new Map(); // descriptorKey -> { at, files }
const TTL_MS = 120000;

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

function createPrSource(descriptor) {
  return {
    id: descriptorKey(descriptor),
    kind: 'pr',
    descriptor,
    async meta() {
      return resolvePr(descriptor);
    },
    async listFiles(options) {
      const files = await loadFiles(descriptor, options && options.fresh);
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
      const files = await loadFiles(descriptor, options && options.fresh);
      const entry = files.find((f) => f.path === filePath);
      if (!entry) {
        const err = new Error(`Файл "${filePath}" отсутствует в диффе этого PR-а.`);
        err.userFacing = true;
        err.status = 404;
        throw err;
      }
      // `context` is ignored on purpose: the local source can vary -U<n>
      // (lib/diff.js:218), GitHub cannot — it always hands back a fixed -U3.
      return entry;
    },
  };
}

module.exports = { createPrSource, splitPrDiff, unquotePath };
