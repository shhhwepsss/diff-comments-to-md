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
 * The line right after the anchor for a comment written in commits mode:
 * `<from>..<to>` (or bare `<to>` when it is a single commit), plus
 * ` · <label>` when the client sent one. A comment with no `commit` context
 * (every comment from working / staged / base, and one left on just the
 * latest commit before commits mode started recording it) has no such line —
 * its block is exactly `anchor\ntext`, unchanged from before commits mode.
 */
function commitLineOf(comment) {
  const ctx = comment.commit;
  if (!ctx || !ctx.to) return null;
  const range = ctx.from && ctx.from !== ctx.to ? `${ctx.from}..${ctx.to}` : ctx.to;
  return ctx.label ? `${range} · ${ctx.label}` : range;
}

const REF_HEADING = { thread: 'Замечание', comment: 'Замечание', review: 'Замечание', description: 'Описание PR-а' };

/**
 * The remark on GitHub a comment answers, as a markdown quote that goes right
 * above the comment's text: who wrote it and where, then what they wrote.
 * The code the thread hangs under is added only when the comment has no line
 * to point at (the thread is outdated) — otherwise the anchor already says
 * where to look. null for a comment with no `ref`: its block stays as it was.
 */
function quoteOf(comment) {
  const ref = comment.ref;
  if (!ref || !ref.quote) return null;
  const who = ref.author ? ` @${ref.author}` : '';
  const where = ref.url ? ` — ${ref.url}` : '';
  const lines = [`${REF_HEADING[ref.kind] || REF_HEADING.comment}${who}${where}`];
  const lineless = comment.startLine === null || comment.startLine === undefined;
  if (ref.code && lineless && comment.file) lines.push('```', ...ref.code.split('\n'), '```');
  lines.push(...ref.quote.split('\n'));
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/** A comment's text, under the remark it answers when there is one. */
function bodyOf(comment) {
  const quote = quoteOf(comment);
  return quote ? `${quote}\n${textOf(comment)}` : textOf(comment);
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
      return `${head}\n${bodyOf(c)}`;
    })
    .join('\n\n');

  if (!general.length) return codeBlocks + (code.length ? '\n' : '');

  const sections = [`${GENERAL_HEADING}\n\n${general.map(bodyOf).join('\n\n')}`];
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

module.exports = { anchorOf, commitLineOf, quoteOf, renderMarkdown, exportMarkdown, writeMarkdownFile, sortComments, stamp };
