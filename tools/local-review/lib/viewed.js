'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gitTry } = require('./git');
const { resolveRange } = require('./diff');

/**
 * "Просмотрено" is stored together with a fingerprint of the file's diff, the
 * way GitHub's "Viewed" checkbox works: once the diff of that file changes
 * (new commits, an edited worktree file), the stored fingerprint no longer
 * matches and the file reads as not viewed again — without anyone having to
 * clear the flag. Nothing is ever compared except by equality, so the parts
 * that go into a fingerprint only need to change exactly when the diff does.
 */
function fingerprintOf(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

/**
 * The bucket a mark migrated from the first, pre-modes format sits in
 * (lib/store.js migrateViewed). It counts in any view whose fingerprint it
 * still matches, which is the view it was made in.
 */
const ANY_MODE = '*';

/**
 * Which view a mark belongs to. Each view diffs something else, so a file
 * marked in one is genuinely unread in another — and a commit range keys by
 * the range itself, because picking other commits is another diff again.
 * Local and PR descriptors never share a store (lib/stores/factory.js), so
 * the key does not repeat the source.
 *
 * Mode `base` also carries the revision it compares against, because two
 * bases are two different views of the same file. That revision is the *ref*
 * resolveRange settled on (lib/diff.js:36), not the merge-base commit: the
 * ref is what the reviewer chose and it stays the same as the branch moves,
 * while the merge-base commit would change under them and silently drop every
 * mark. `resolvedBase` must therefore come from resolveRange (or modeKeyFor
 * below), so that an empty base and the same branch named explicitly are one
 * key and not two.
 */
function modeKeyOf(descriptor, resolvedBase) {
  if (descriptor.from && descriptor.to) return `commits:${descriptor.from}..${descriptor.to}`;
  if (descriptor.source !== 'local') return 'pr:all';
  if (descriptor.mode !== 'base') return `mode:${descriptor.mode}`;
  return `mode:base:${resolvedBase || descriptor.base}`;
}

/**
 * The same key for a caller that has no resolved base at hand: asks git
 * through the very function the diff itself goes through, so "the
 * repository's default branch" means exactly one thing in both places.
 */
async function modeKeyFor(descriptor) {
  const needsBase =
    descriptor.source === 'local' && descriptor.mode === 'base' && !(descriptor.from && descriptor.to);
  if (!needsBase) return modeKeyOf(descriptor);
  const range = await resolveRange(descriptor.root, 'base', descriptor.base);
  return modeKeyOf(descriptor, range.base);
}

/**
 * modeKeyOf backwards, for the views git alone can rebuild: the key of a local
 * view -> what to diff ({ mode, base } or { mode: 'commits', from, to }).
 * Null for every other key — ANY_MODE, a PR's `pr:all`, anything not written
 * by modeKeyOf — so that a caller who cannot rebuild a view leaves it alone.
 * A commit range reads the same in a local and in a PR store; which of the
 * two the key came from is the caller's knowledge, not the key's.
 */
function localViewOf(modeKey) {
  if (modeKey === 'mode:working' || modeKey === 'mode:staged') return { mode: modeKey.slice('mode:'.length), base: '' };
  if (modeKey.startsWith('mode:base:')) {
    const base = modeKey.slice('mode:base:'.length);
    return base ? { mode: 'base', base } : null;
  }
  if (modeKey.startsWith('commits:')) {
    // `from` and `to` are whatever the request named, and a revision may itself
    // contain dots (`HEAD^{/fix..bug}`): a range that does not split in exactly
    // one way is not guessed at.
    const parts = modeKey.slice('commits:'.length).split('..');
    if (parts.length !== 2) return null;
    const [from, to] = parts;
    if (!from || !to || from.endsWith('.') || to.startsWith('.')) return null;
    return { mode: 'commits', from, to };
  }
  return null;
}

/**
 * The one invalidation rule: viewed only while this view's stored fingerprint
 * is the current one. `bucket` is what the store keeps for this file.
 */
function isViewed(bucket, modeKey, fingerprint) {
  if (!bucket || !fingerprint) return false;
  const record = bucket[modeKey] || bucket[ANY_MODE];
  return Boolean(record && record.fingerprint === fingerprint);
}

// Modes whose right-hand side is the worktree, not a blob git already has.
const WORKTREE_MODES = new Set(['working', 'base']);

// Paths per `git hash-object` call: keeps argv well under the Windows limit.
const HASH_BATCH = 100;

function isNullSha(sha) {
  return !sha || /^0+$/.test(sha);
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Worktree path -> blob id, computed by git itself so that it matches the id
 * the same content gets once staged or committed (clean filters, autocrlf):
 * a file marked viewed in `working` stays viewed in `staged` when nothing
 * but the mode changed. If git refuses a batch, the content hash stands in —
 * still a correct fingerprint, just not comparable across modes.
 */
async function hashWorktreeFiles(root, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += HASH_BATCH) {
    const batch = paths.slice(i, i + HASH_BATCH);
    const res = await gitTry(['hash-object', '--'].concat(batch), root);
    const ids = res === null ? [] : res.split('\n').map((l) => l.trim()).filter(Boolean);
    if (ids.length === batch.length) {
      batch.forEach((p, k) => out.set(p, ids[k]));
      continue;
    }
    for (const p of batch) {
      try {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
        out.set(p, `content:${digest}`);
      } catch {
        out.set(p, null);
      }
    }
  }
  return out;
}

/**
 * Local entries (from parseRawZ / listUntracked) -> the same entries with a
 * `fingerprint`. Old side: the blob id `git diff --raw` reports. New side:
 * that blob id too, unless git left it as 0000… because the file is only in
 * the worktree (unstaged edit, untracked file) — then the worktree content is
 * hashed. A deleted file has no new side at all, which is itself stable.
 *
 * `fingerprintApprox` marks an entry whose worktree hash is the stand-in of
 * hashWorktreeFiles (or none at all): such a fingerprint differs from the one
 * a blob id gives for the very same content, so a mismatch on it does not
 * mean the diff changed (lib/viewed-prune.js must not delete on it).
 */
async function withLocalFingerprints(root, mode, files) {
  const needsHash = (f) =>
    WORKTREE_MODES.has(mode) && isNullSha(f.newBlob) && isFile(path.join(root, f.path));
  const hashes = await hashWorktreeFiles(root, files.filter(needsHash).map((f) => f.path));
  return files.map((f) => {
    const newSide = hashes.has(f.path) ? hashes.get(f.path) : isNullSha(f.newBlob) ? null : f.newBlob;
    const oldSide = isNullSha(f.oldBlob) ? null : f.oldBlob;
    const entry = Object.assign({}, f, {
      fingerprint: fingerprintOf([f.kind, f.oldPath || null, f.path, oldSide, newSide]),
    });
    if (hashes.has(f.path) && (newSide === null || newSide.startsWith('content:'))) entry.fingerprintApprox = true;
    return entry;
  });
}

module.exports = {
  fingerprintOf,
  isViewed,
  modeKeyOf,
  modeKeyFor,
  localViewOf,
  withLocalFingerprints,
  hashWorktreeFiles,
  ANY_MODE,
};
