'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isGeneralComment } = require('./store');

const GENERAL_TITLE = 'Общие комментарии';
const CODE_TITLE = 'Комментарии к коду';

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
 *
 * A review session's export puts a PR's comments under the PR's own heading,
 * so it asks for two things: `level`, the depth of the headings (3 = `###`
 * under a `## PR` heading), and `sectioned`, which keeps the code comments
 * under their heading even when there are no general ones — a PR's section is
 * handed to an agent on its own, and the heading tells it what the blocks are.
 */
function renderMarkdown(comments, { level = 2, sectioned = false } = {}) {
  const hashes = '#'.repeat(level);
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

  if (!general.length && !sectioned) return codeBlocks + (code.length ? '\n' : '');

  const sections = [];
  if (general.length) sections.push(`${hashes} ${GENERAL_TITLE}\n\n${general.map(bodyOf).join('\n\n')}`);
  if (code.length) sections.push(`${hashes} ${CODE_TITLE}\n\n${codeBlocks}`);
  return sections.length ? sections.join('\n\n') + '\n' : '';
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

function promptOf(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

const SHORT_SHA = 7;

/** «1 PR», «2 PR-а», «5 PR-ов»: the noun after a count, by the Russian rule for 1 / 2–4 / the rest. */
function prCount(n) {
  const last = n % 10;
  const tens = n % 100;
  if (last === 1 && tens !== 11) return `${n} PR`;
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return `${n} PR-а`;
  return `${n} PR-ов`;
}

/** Why a PR with no comments is in the export at all: what the reviewer said about it. */
const NO_COMMENTS_LINE = {
  lgtm: 'Без замечаний (LGTM).',
  skip: 'Пропущен — не трогать.',
  none: 'Не отмечен — не трогать.',
};

function prUrl(session, pr) {
  return `https://${session.host}/${session.owner}/${session.repo}/pull/${pr.number}`;
}

/**
 * One PR of a session: its heading, branch and head, the link, then either
 * its comments with the copy prompt after them, or one line saying why there
 * are none. `level` is the depth of the PR heading (2 in a whole-session
 * export, 1 when the PR is exported alone); the comment headings sit below it.
 * Status wins over marks: a PR with comments is exported with them whatever
 * was marked on it.
 */
function renderSessionPr(session, pr, comments, { level, copyPrompt }) {
  const where = [];
  if (pr.headRefName) where.push(`Ветка: ${pr.headRefName}`);
  if (pr.headSha) where.push(`head: ${String(pr.headSha).slice(0, SHORT_SHA)}`);
  const head = [`${'#'.repeat(level)} PR #${pr.number} — ${pr.title}`];
  if (where.length) head.push(where.join(' · '));
  head.push(prUrl(session, pr));
  const parts = [head.join('\n')];

  if (comments.length) {
    parts.push(renderMarkdown(comments, { level: level + 1, sectioned: true }).trimEnd());
    const tail = promptOf(copyPrompt);
    if (tail) parts.push(tail);
  } else {
    const mark = session.marks && session.marks[pr.number];
    parts.push(NO_COMMENTS_LINE[mark] || NO_COMMENTS_LINE.none);
  }
  return parts;
}

/**
 * The text of a review session — the clipboard and the .md file are both this.
 * `scope: 'all'` is the whole session: a title, the «Для оркестратора»
 * section (the session's general comments, oldest first, then the
 * orchestrator prompt; left out when both are empty), and a section per PR in
 * session order. `scope: 'pr'` is one PR's section alone, one heading level
 * up and with no orchestrator part — it can be handed to an agent as it is.
 * `commentsByPr` maps a PR number to the comments of its own store.
 */
function exportSession({ session, scope, number, commentsByPr, copyPrompt, orchestratorPrompt }) {
  if (scope === 'pr') {
    const pr = session.prs.find((p) => p.number === number);
    if (!pr) return '';
    return renderSessionPr(session, pr, commentsByPr[pr.number] || [], { level: 1, copyPrompt }).join('\n\n') + '\n';
  }

  const parts = [`# Ревью: ${prCount(session.prs.length)} · ${session.owner}/${session.repo}`];
  const forOrchestrator = (session.general || [])
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((g) => promptOf(g.text))
    .filter(Boolean);
  const prompt = promptOf(orchestratorPrompt);
  if (prompt) forOrchestrator.push(prompt);
  if (forOrchestrator.length) parts.push(`## Для оркестратора\n\n${forOrchestrator.join('\n\n')}`);
  for (const pr of session.prs) {
    parts.push(...renderSessionPr(session, pr, commentsByPr[pr.number] || [], { level: 2, copyPrompt }));
  }
  return parts.join('\n\n') + '\n';
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
 * apart: both come from the same exportMarkdown() call site. A session's
 * export is written the same way under its own prefix (`session`).
 */
function writeMarkdownFile(repoRoot, markdown, date, prefix = 'review') {
  // The stamp is to the minute: a second export in the same minute is a new
  // file (`…-2.md`, `…-3.md`), never an overwrite of the first one.
  for (let n = 1; ; n += 1) {
    const name = `${prefix}-${stamp(date)}${n > 1 ? `-${n}` : ''}.md`;
    const abs = path.join(repoRoot, name);
    try {
      fs.writeFileSync(abs, markdown, { encoding: 'utf8', flag: 'wx' });
      return { name, path: abs };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
  }
}

module.exports = { anchorOf, commitLineOf, quoteOf, renderMarkdown, exportMarkdown, exportSession, prCount, writeMarkdownFile, sortComments, stamp };
