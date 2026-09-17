'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gitTry } = require('./git');

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

/** The one invalidation rule: viewed only while the stored fingerprint is the current one. */
function isViewed(record, fingerprint) {
  return Boolean(record && fingerprint && record.fingerprint === fingerprint);
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
 */
async function withLocalFingerprints(root, mode, files) {
  const needsHash = (f) =>
    WORKTREE_MODES.has(mode) && isNullSha(f.newBlob) && isFile(path.join(root, f.path));
  const hashes = await hashWorktreeFiles(root, files.filter(needsHash).map((f) => f.path));
  return files.map((f) => {
    const newSide = hashes.has(f.path) ? hashes.get(f.path) : isNullSha(f.newBlob) ? null : f.newBlob;
    const oldSide = isNullSha(f.oldBlob) ? null : f.oldBlob;
    return Object.assign({}, f, {
      fingerprint: fingerprintOf([f.kind, f.oldPath || null, f.path, oldSide, newSide]),
    });
  });
}

module.exports = { fingerprintOf, isViewed, withLocalFingerprints, hashWorktreeFiles };
