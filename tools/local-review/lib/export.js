'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isGeneralComment } = require('./store');

const GENERAL_HEADING = '## Общие комментарии';
const CODE_HEADING = '## Комментарии к коду';

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

function textOf(comment) {
  return String(comment.text).replace(/\r\n/g, '\n').trim();
}

/**
 * The line right after the anchor for a comment written in commits mode and
 * not on the latest commit alone: `<from>..<to>` (or bare `<to>` when it is
 * a single commit), plus ` · <label>` when the client sent one. A comment
 * with no `commit` context (every comment from working / staged / base, and
 * one left on just the latest commit) has no such line — its block is
 * exactly `anchor\ntext`, unchanged from before commits mode existed.
 */
function commitLineOf(comment) {
  const ctx = comment.commit;
  if (!ctx || !ctx.to) return null;
  const range = ctx.from && ctx.from !== ctx.to ? `${ctx.from}..${ctx.to}` : ctx.to;
  return ctx.label ? `${range} · ${ctx.label}` : range;
}

/**
 * Without general comments the output is exactly what it has always been:
 * `anchor\ntext` blocks, nothing else. General comments, when there are any,
 * come first under their own heading, oldest first, and the code comments
 * follow under a second heading.
 */
function renderMarkdown(comments) {
  const general = comments
    .filter(isGeneralComment)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const code = comments.filter((c) => !isGeneralComment(c));
  const codeBlocks = sortComments(code)
    .map((c) => {
      const commitLine = commitLineOf(c);
      const head = commitLine ? `${anchorOf(c)}\n${commitLine}` : anchorOf(c);
      return `${head}\n${textOf(c)}`;
    })
    .join('\n\n');

  if (!general.length) return codeBlocks + (code.length ? '\n' : '');

  const sections = [`${GENERAL_HEADING}\n\n${general.map(textOf).join('\n\n')}`];
  if (code.length) sections.push(`${CODE_HEADING}\n\n${codeBlocks}`);
  return sections.join('\n\n') + '\n';
}

/**
 * What both the clipboard and the .md file get: the comments, a blank line,
 * then the user's copy prompt (readSettings in lib/config.js) at the very
 * end — an instruction about the review above it. A blank prompt changes
 * nothing: the text stays byte-for-byte renderMarkdown's.
 */
function exportMarkdown(comments, prompt) {
  const markdown = renderMarkdown(comments);
  const tail = String(prompt || '').replace(/\r\n/g, '\n').trim();
  if (!tail) return markdown;
  return markdown ? `${markdown}\n${tail}\n` : `${tail}\n`;
}

function stamp(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

/**
 * Writes review-<YYYY-MM-DD-HHmm>.md at the repo root. Read-only w.r.t. git.
 * Takes the finished markdown, so the file and the clipboard cannot drift
 * apart: both come from the same exportMarkdown() call site.
 */
function writeMarkdownFile(repoRoot, markdown, date) {
  const name = `review-${stamp(date)}.md`;
  const abs = path.join(repoRoot, name);
  fs.writeFileSync(abs, markdown, 'utf8');
  return { name, path: abs };
}

module.exports = { anchorOf, commitLineOf, renderMarkdown, exportMarkdown, writeMarkdownFile, sortComments, stamp };
