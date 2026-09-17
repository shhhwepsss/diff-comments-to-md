'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

  add({ file, startLine, endLine, text, commit }) {
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

  /** The one and only bulk delete. Callers must pass confirm:true explicitly. */
  clearAll() {
    const removed = this.data.comments.length;
    this.data.comments = [];
    this.save();
    return removed;
  }
}

module.exports = { CommentStore, STORE_DIR, STORE_FILE, isGeneralComment, normalizeCommit };
