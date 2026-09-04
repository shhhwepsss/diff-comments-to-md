'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git, gitTry, hasHead, revExists, mergeBase } = require('./git');

/**
 * Builds the argv prefix that selects what we compare.
 * working : worktree vs HEAD (staged + unstaged)
 * staged  : index vs HEAD
 * base    : worktree vs merge-base(<base>, HEAD)
 */
async function resolveRange(repoRoot, mode, base) {
  const head = await hasHead(repoRoot);

  if (mode === 'staged') {
    return { args: head ? ['diff', '--cached'] : ['diff', '--cached'], label: 'staged vs HEAD' };
  }

  if (mode === 'base') {
    if (!(await revExists(base, repoRoot))) {
      const err = new Error(`Ревизия "${base}" не найдена в этом репозитории.`);
      err.userFacing = true;
      throw err;
    }
    const mb = (await mergeBase(base, repoRoot)) || base;
    return { args: ['diff', mb], label: `worktree vs merge-base(${base})`, resolvedBase: mb };
  }

  // working
  return { args: head ? ['diff', 'HEAD'] : ['diff'], label: 'worktree vs HEAD' };
}

function splitZ(buf) {
  const parts = buf.toString('utf8').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * `git diff --raw -z -M` output, parsed.
 * Entries look like ":100644 100644 aaa bbb M\0path\0" and, for renames,
 * ":100644 100644 aaa bbb R096\0old\0new\0".
 */
function parseRawZ(tokens) {
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith(':')) continue;
    const fields = token.slice(1).split(' ');
    const status = fields[fields.length - 1] || 'M';
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      files.push({ path: tokens[i + 2], oldPath: tokens[i + 1], status, kind });
      i += 2;
    } else {
      files.push({ path: tokens[i + 1], oldPath: null, status, kind });
      i += 1;
    }
  }
  return files;
}

async function listUntracked(repoRoot) {
  const out = await gitTry(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
  if (out === null) return [];
  const parts = out.split('\0').filter(Boolean);
  return parts.map((p) => ({ path: p, oldPath: null, status: 'U', kind: 'U', untracked: true }));
}

async function listFiles(repoRoot, mode, base) {
  const range = await resolveRange(repoRoot, mode, base);
  const raw = await git(range.args.concat(['--raw', '-z', '-M', '--no-color']), repoRoot);
  const files = parseRawZ(splitZ(raw));

  // Untracked files never show up in `git diff`; they are the most common thing
  // a reviewer wants to see in a dirty worktree, so synthesize them.
  if (mode !== 'staged') {
    const untracked = await listUntracked(repoRoot);
    const known = new Set(files.map((f) => f.path));
    for (const f of untracked) if (!known.has(f.path)) files.push(f);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, range };
}

function looksBinary(buf) {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
  return false;
}

function splitLines(text) {
  // Handles LF and CRLF; trailing newline does not produce a phantom line.
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Unified-diff text -> hunks with real old/new line numbers. */
function parsePatch(patchText) {
  const lines = splitLines(patchText);
  const hunks = [];
  let current = null;
  let binary = false;
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk) {
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        binary = true;
        continue;
      }
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (header) {
      inHunk = true;
      current = {
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        heading: header[5] || '',
        lines: [],
      };
      hunks.push(current);
      current._oldCursor = current.oldStart;
      current._newCursor = current.newStart;
      continue;
    }
    if (!inHunk || !current) continue;

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the previous line, not a row.
      continue;
    }
    const marker = line[0];
    const text = line.slice(1);
    if (marker === '+') {
      current.lines.push({ type: 'add', oldLine: null, newLine: current._newCursor, text });
      current._newCursor += 1;
      additions += 1;
    } else if (marker === '-') {
      current.lines.push({ type: 'del', oldLine: current._oldCursor, newLine: null, text });
      current._oldCursor += 1;
      deletions += 1;
    } else if (marker === ' ' || line === '') {
      current.lines.push({
        type: 'context',
        oldLine: current._oldCursor,
        newLine: current._newCursor,
        text,
      });
      current._oldCursor += 1;
      current._newCursor += 1;
    } else {
      // diff --git / index / --- / +++ lines between hunks of a multi-file patch
      inHunk = false;
      current = null;
    }
  }

  for (const h of hunks) {
    delete h._oldCursor;
    delete h._newCursor;
  }
  return { hunks, binary, additions, deletions };
}

/** Untracked file -> a patch-shaped payload where every line is an addition. */
function syntheticNewFile(repoRoot, filePath) {
  const abs = path.join(repoRoot, filePath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { hunks: [], binary: false, additions: 0, deletions: 0, missing: true };
  }
  if (stat.isDirectory()) return { hunks: [], binary: false, additions: 0, deletions: 0 };

  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) return { hunks: [], binary: true, additions: 0, deletions: 0 };

  const lines = splitLines(buf.toString('utf8'));
  const hunk = {
    oldStart: 0,
    newStart: 1,
    heading: '',
    lines: lines.map((text, i) => ({ type: 'add', oldLine: null, newLine: i + 1, text })),
  };
  return {
    hunks: lines.length ? [hunk] : [],
    binary: false,
    additions: lines.length,
    deletions: 0,
  };
}

async function fileDiff(repoRoot, mode, base, filePath, context) {
  const range = await resolveRange(repoRoot, mode, base);
  const { files } = await listFiles(repoRoot, mode, base);
  const entry = files.find((f) => f.path === filePath);
  if (!entry) {
    const err = new Error(`Файл "${filePath}" отсутствует в текущем диффе.`);
    err.userFacing = true;
    err.status = 404;
    throw err;
  }

  if (entry.untracked) {
    return Object.assign({}, entry, syntheticNewFile(repoRoot, filePath));
  }

  const args = range.args.concat([
    '-M',
    '--no-color',
    `-U${Number.isFinite(context) ? context : 3}`,
    '--',
  ]);
  args.push(entry.path);
  if (entry.oldPath) args.push(entry.oldPath);

  const patch = (await git(args, repoRoot)).toString('utf8');
  return Object.assign({}, entry, parsePatch(patch));
}

module.exports = { resolveRange, listFiles, fileDiff, parsePatch, splitLines };
