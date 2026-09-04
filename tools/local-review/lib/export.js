'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * `path:L42` for a single line, `path:L42-L50` for a range, bare `path` for a
 * file-level comment (binary / deleted files have no line to point at).
 * Line numbers are real numbers in the file after the change, so an agent can
 * open the file and land on the right line.
 */
function anchorOf(comment) {
  if (comment.startLine === null || comment.startLine === undefined) return comment.file;
  if (comment.endLine && comment.endLine !== comment.startLine) {
    return `${comment.file}:L${comment.startLine}-L${comment.endLine}`;
  }
  return `${comment.file}:L${comment.startLine}`;
}

function sortComments(comments) {
  return comments.slice().sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    const al = a.startLine === null || a.startLine === undefined ? -1 : a.startLine;
    const bl = b.startLine === null || b.startLine === undefined ? -1 : b.startLine;
    if (al !== bl) return al - bl;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function renderMarkdown(comments) {
  return (
    sortComments(comments)
      .map((c) => `${anchorOf(c)}\n${String(c.text).replace(/\r\n/g, '\n').trim()}`)
      .join('\n\n') + (comments.length ? '\n' : '')
  );
}

function stamp(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/** Writes review-<YYYY-MM-DD-HHmm>.md at the repo root. Read-only w.r.t. git. */
function writeMarkdownFile(repoRoot, comments, date) {
  const name = `review-${stamp(date)}.md`;
  const abs = path.join(repoRoot, name);
  fs.writeFileSync(abs, renderMarkdown(comments), 'utf8');
  return { name, path: abs };
}

module.exports = { anchorOf, renderMarkdown, writeMarkdownFile, sortComments, stamp };
