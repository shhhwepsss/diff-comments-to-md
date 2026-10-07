'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ANY_MODE } = require('./viewed');

const STORE_DIR = '.local-review';
const STORE_FILE = 'comments.json';

/**
 * A general comment is about the review as a whole, like GitHub's review
 * summary: it lives in the same `comments` array, with `file: null` and no
 * lines. Files written before general comments existed simply have none.
 */
function isGeneralComment(comment) {
  return comment.file === null;
}

/**
 * { from, to, label } — the commit range within which the comment was
 * written. Kept only on file comments written in commits mode (a general
 * comment has no file/line to begin with, so it never carries one) so that
 * a comment written in `working` / `staged` / `base` is stored exactly as
 * it always has been.
 */
function normalizeCommit(commit) {
  if (!commit || typeof commit !== 'object') return null;
  const to = commit.to ? String(commit.to) : '';
  if (!to) return null;
  return {
    from: commit.from ? String(commit.from) : to,
    to,
    label: commit.label ? String(commit.label) : '',
  };
}

const REF_KINDS = ['thread', 'comment', 'review', 'description'];
const REF_QUOTE_LIMIT = 4000;
const REF_CODE_LIMIT = 2000;

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function plainText(value) {
  return String(value || '').replace(/\r\n/g, '\n');
}

/**
 * { kind, id, author, url, quote, code? } — the remark on GitHub this comment
 * answers. The quote is a snapshot taken when the comment was written: the
 * export must say the same thing after the remark is edited or deleted, and
 * with no network at all. `code` is the piece of the diff a review thread
 * hangs under. A comment written anywhere but under such a remark has no ref
 * and is stored exactly as before.
 */
function normalizeRef(ref) {
  if (!ref || typeof ref !== 'object' || !REF_KINDS.includes(ref.kind)) return null;
  const quote = clip(plainText(ref.quote).trim(), REF_QUOTE_LIMIT);
  if (!quote) return null;
  const out = {
    kind: ref.kind,
    id: ref.id ? String(ref.id).slice(0, 200) : '',
    author: ref.author ? String(ref.author).slice(0, 100) : '',
    url: ref.url ? String(ref.url).slice(0, 500) : '',
    quote,
  };
  // Not trimmed at the start: a diff line begins with its own space, `+` or `-`.
  const code = clip(plainText(ref.code).trimEnd(), REF_CODE_LIMIT);
  if (code.trim()) out.code = code;
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The first shape of `viewed` was one record per file: { path: { fingerprint,
 * viewedAt } }. Such a record predates the split into views, so it is kept
 * under ANY_MODE and counts in whichever view its fingerprint still matches —
 * which is the view it was made in, since every view fingerprints its own
 * diff. Nothing is dropped and the format version does not move: a store that
 * was already per-mode passes through untouched.
 */
function migrateViewed(viewed) {
  const out = {};
  for (const [file, value] of Object.entries(viewed)) {
    if (!isPlainObject(value)) continue;
    out[file] = typeof value.fingerprint === 'string' ? { [ANY_MODE]: value } : value;
  }
  return out;
}

class CommentStore {
  /**
   * Takes an absolute path to the JSON file. The store is a dumb JSON blob on
   * disk and deliberately knows nothing about local repos vs pull requests —
   * that mapping lives in lib/stores/factory.js and nowhere else.
   */
  constructor(filePath) {
    this.file = filePath;
    this.dir = path.dirname(filePath);
    this.data = { version: 1, comments: [] };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.comments)) {
        this.data = { version: parsed.version || 1, comments: parsed.comments };
        // Optional: files written before "viewed" existed simply have none.
        if (isPlainObject(parsed.viewed)) this.data.viewed = migrateViewed(parsed.viewed);
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // Never lose a corrupted file silently — move it aside, start clean.
        try {
          fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      this.data = { version: 1, comments: [] };
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  all() {
    return this.data.comments.slice();
  }

  countsByFile() {
    const counts = {};
    for (const c of this.data.comments) {
      if (isGeneralComment(c)) continue;
      counts[c.file] = (counts[c.file] || 0) + 1;
    }
    return counts;
  }

  add({ file, startLine, endLine, text, commit, ref }) {
    const now = new Date().toISOString();
    const comment = {
      id: crypto.randomUUID(),
      file,
      startLine: startLine === null || startLine === undefined ? null : Number(startLine),
      endLine: endLine === null || endLine === undefined ? null : Number(endLine),
      text: String(text),
      createdAt: now,
      updatedAt: now,
    };
    if (comment.startLine !== null && comment.endLine === null) comment.endLine = comment.startLine;
    if (
      comment.startLine !== null &&
      comment.endLine !== null &&
      comment.endLine < comment.startLine
    ) {
      const tmp = comment.startLine;
      comment.startLine = comment.endLine;
      comment.endLine = tmp;
    }
    // A general comment (file === null) never carries a commit context.
    if (file !== null) {
      const ctx = normalizeCommit(commit);
      if (ctx) comment.commit = ctx;
    }
    const remark = normalizeRef(ref);
    if (remark) comment.ref = remark;
    this.data.comments.push(comment);
    this.save();
    return comment;
  }

  update(id, text) {
    const comment = this.data.comments.find((c) => c.id === id);
    if (!comment) return null;
    comment.text = String(text);
    comment.updatedAt = new Date().toISOString();
    this.save();
    return comment;
  }

  remove(id) {
    const index = this.data.comments.findIndex((c) => c.id === id);
    if (index === -1) return false;
    this.data.comments.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * { [path]: { [modeKey]: { fingerprint, viewedAt } } } — what was marked
   * viewed, in which view, and against which diff. One bucket per view
   * (lib/viewed.js modeKeyOf) so that marking a file in `base` does not erase
   * the mark made on the same file in `working`. Whether a mark still holds
   * is decided by the caller against the current fingerprint (lib/viewed.js
   * isViewed); a stale mark is left in place and is harmless. Stale marks
   * are swept separately, once per server start (lib/viewed-prune.js).
   */
  viewedFiles() {
    return Object.assign({}, this.data.viewed || {});
  }

  setViewed(file, modeKey, fingerprint) {
    // Created on first use, so a review nobody marked keeps its file as-is.
    if (!this.data.viewed) this.data.viewed = {};
    const bucket = isPlainObject(this.data.viewed[file]) ? this.data.viewed[file] : {};
    const record = { fingerprint: String(fingerprint), viewedAt: new Date().toISOString() };
    bucket[modeKey] = record;
    this.data.viewed[file] = bucket;
    this.save();
    return record;
  }

  /**
   * Takes the mark off in this view. A mark migrated from the flat, pre-modes
   * format (ANY_MODE) goes too: it is the mark the reviewer is looking at, and
   * it has no view of its own to stay in.
   */
  unsetViewed(file, modeKey) {
    const bucket = this.data.viewed && this.data.viewed[file];
    if (!isPlainObject(bucket)) return false;
    let removed = false;
    for (const key of [modeKey, ANY_MODE]) {
      if (Object.prototype.hasOwnProperty.call(bucket, key)) {
        delete bucket[key];
        removed = true;
      }
    }
    if (!removed) return false;
    if (Object.keys(bucket).length === 0) delete this.data.viewed[file];
    this.save();
    return true;
  }

  /**
   * Deletes exactly the marks listed — [{ file, modeKey, fingerprint }] — and
   * returns how many went. A mark whose fingerprint is not the listed one any
   * more was made again after the list was drawn up, and stays. A file left
   * with no marks loses its key. Nothing is written when nothing was deleted,
   * so a store with no stale marks keeps its file byte for byte.
   */
  dropViewed(marks) {
    const viewed = this.data.viewed;
    if (!isPlainObject(viewed)) return 0;
    let removed = 0;
    for (const { file, modeKey, fingerprint } of marks) {
      const bucket = Object.prototype.hasOwnProperty.call(viewed, file) ? viewed[file] : null;
      if (!isPlainObject(bucket) || !Object.prototype.hasOwnProperty.call(bucket, modeKey)) continue;
      const record = bucket[modeKey];
      if (!isPlainObject(record) || record.fingerprint !== fingerprint) continue;
      delete bucket[modeKey];
      removed += 1;
      if (Object.keys(bucket).length === 0) delete viewed[file];
    }
    if (removed > 0) this.save();
    return removed;
  }

  /**
   * The one and only bulk delete. Callers must pass confirm:true explicitly.
   * Only comments go: viewed marks are not comments and stay.
   */
  clearAll() {
    const removed = this.data.comments.length;
    this.data.comments = [];
    this.save();
    return removed;
  }
}

module.exports = { CommentStore, STORE_DIR, STORE_FILE, isGeneralComment, normalizeCommit, normalizeRef };
