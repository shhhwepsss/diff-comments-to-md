'use strict';

/**
 * История коммитов ветки и дифф по одному коммиту / диапазону коммитов.
 *
 * Модуль стоит рядом с diff.js и переиспользует его парсеры, но ни один из
 * существующих режимов (working / staged / base) через него не ходит: фича
 * «выбор диапазона коммитов» живёт отдельно и её можно выключить, не трогая
 * остальное.
 */

const { git, gitText, gitTry, hasHead, revExists, mergeBase } = require('./git');
const { parsePatch, parseRawZ, splitZ, splitLines } = require('./diff');

// Разделители внутри --format: в сообщении коммита их не бывает, в отличие от
// любого печатного символа, который кто-нибудь да напишет.
const FIELD = '\x1f';
const RECORD = '\x1e';

const DEFAULT_LIMIT = 200;

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 =
  '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

const emptyTreeCache = new Map();

/** Хеш пустого дерева — левая сторона диффа для самого первого коммита. */
async function emptyTree(repoRoot) {
  if (emptyTreeCache.has(repoRoot)) return emptyTreeCache.get(repoRoot);
  const raw = await gitTry(['rev-parse', '--show-object-format'], repoRoot);
  const sha = (raw || '').trim() === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
  emptyTreeCache.set(repoRoot, sha);
  return sha;
}

function userError(message, status) {
  const err = new Error(message);
  err.userFacing = true;
  if (status) err.status = status;
  return err;
}

// --------------------------------------------------------------- история

function parseCommitLog(text) {
  const commits = [];
  for (const record of text.split(RECORD)) {
    const line = record.replace(/^[\r\n]+/, '');
    if (!line.trim()) continue;
    const f = line.split(FIELD);
    if (f.length < 7) continue;
    const parents = f[2].trim() ? f[2].trim().split(/\s+/) : [];
    commits.push({
      sha: f[0],
      short: f[1],
      parents,
      author: f[3],
      date: f[4],
      subject: f[5],
      body: f[6].replace(/\s+$/, ''),
      merge: parents.length > 1,
      root: parents.length === 0,
    });
  }
  return commits;
}

/**
 * Коммиты текущей ветки от точки ветвления: merge-base(<base>, HEAD)..HEAD,
 * от старого к новому. Вся история целиком не грузится — берём не больше
 * limit коммитов и честно говорим, что список обрезан.
 *
 * Если база не найдена или ветка от неё не уходила (merge-base == HEAD),
 * откатываемся на последние коммиты HEAD: пустой рельс полезнее не делает.
 */
async function listCommits(repoRoot, base, limit) {
  if (!(await hasHead(repoRoot))) {
    return { commits: [], truncated: false, mergeBase: null, base: null, fallback: false };
  }

  const max = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : DEFAULT_LIMIT;
  const format = ['%H', '%h', '%P', '%an', '%aI', '%s', '%b'].join(FIELD) + RECORD;
  const run = async (rangeArg) =>
    parseCommitLog(
      await gitText(
        ['log', '--no-color', `--max-count=${max + 1}`, `--format=${format}`, rangeArg],
        repoRoot
      )
    );

  let mb = null;
  if (base && (await revExists(base, repoRoot))) mb = await mergeBase(base, repoRoot);

  let commits = mb ? await run(`${mb}..HEAD`) : [];
  let fallback = false;
  if (commits.length === 0) {
    commits = await run('HEAD');
    fallback = true;
  }

  const truncated = commits.length > max;
  if (truncated) commits = commits.slice(0, max);

  commits.reverse(); // git log отдаёт от нового к старому, рельс идёт слева направо
  return { commits, truncated, mergeBase: mb, base: base || null, fallback };
}

/**
 * Незакоммиченные изменения: дифф по коммитам их не показывает, поэтому UI
 * обязан предупредить, что картина может быть неполной.
 */
async function uncommittedSummary(repoRoot) {
  const out = await gitTry(['status', '--porcelain', '-z'], repoRoot);
  if (out === null) return { dirty: false, files: 0 };
  const parts = out.split('\0');
  let files = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    files += 1;
    const xy = entry.slice(0, 2);
    // Переименования занимают две записи: "R  new\0old\0".
    if (xy.includes('R') || xy.includes('C')) i += 1;
  }
  return { dirty: files > 0, files };
}

// ----------------------------------------------------------------- дифф

async function isMergeCommit(repoRoot, sha) {
  const out = await gitTry(['rev-list', '--parents', '-n', '1', sha], repoRoot);
  if (!out) return false;
  return out.trim().split(/\s+/).length > 2;
}

async function assertCommit(repoRoot, sha, what) {
  if (!(await revExists(sha, repoRoot))) {
    throw userError(`Коммит "${what || sha}" не найден в этом репозитории.`, 404);
  }
}

/**
 * argv для `git diff` по диапазону: от родителя нижнего коммита до верхнего.
 * У самого первого коммита родителя нет — сравниваем с пустым деревом.
 */
async function rangeArgs(repoRoot, from, to) {
  const parent = await gitTry(['rev-parse', '--verify', '--quiet', `${from}^`], repoRoot);
  const left = parent ? parent.trim() : await emptyTree(repoRoot);
  return ['diff', left, to];
}

/** Человекочитаемая git-команда, которую повторяет выбор. Показываем в UI. */
async function describeCommand(repoRoot, from, to) {
  if (from === to) {
    if (await isMergeCommit(repoRoot, from)) return `git show --cc ${short(from)}`;
    const parent = await gitTry(['rev-parse', '--verify', '--quiet', `${from}^`], repoRoot);
    return parent ? `git show ${short(from)}` : `git diff <empty-tree>..${short(from)}`;
  }
  const parent = await gitTry(['rev-parse', '--verify', '--quiet', `${from}^`], repoRoot);
  return parent
    ? `git diff ${short(from)}^..${short(to)}`
    : `git diff <empty-tree>..${short(to)}`;
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/** `git diff-tree --cc --raw`: записи начинаются с N двоеточий по числу родителей. */
function parseCombinedRawZ(tokens) {
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('::')) continue;
    const fields = token.replace(/^:+/, '').split(' ');
    const status = fields[fields.length - 1] || 'M';
    files.push({ path: tokens[i + 1], oldPath: null, status, kind: status[0] });
    i += 1;
  }
  return files;
}

/**
 * Комбинированный дифф мерджа (`@@@ -a,b -c,d +e,f @@@`): первые N символов
 * строки — маркеры по одному на родителя. Строка с '-' хоть у одного родителя
 * в результат не попала, строка без маркеров есть у всех — это контекст.
 */
function parseCombinedPatch(patchText) {
  const lines = splitLines(patchText);
  const hunks = [];
  let current = null;
  let parents = 2;
  let additions = 0;
  let deletions = 0;
  let binary = false;
  let inHunk = false;

  for (const line of lines) {
    if (!inHunk && (line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))) {
      binary = true;
      continue;
    }
    const header = /^(@{2,}) (.+?) \1(.*)$/.exec(line);
    if (header) {
      parents = header[1].length - 1;
      const groups = header[2].trim().split(/\s+/);
      const oldStart = Number(groups[0].slice(1).split(',')[0]);
      const newStart = Number(groups[groups.length - 1].slice(1).split(',')[0]);
      current = {
        oldStart,
        newStart,
        heading: (header[3] || '').trim(),
        lines: [],
        _oldCursor: oldStart,
        _newCursor: newStart,
      };
      hunks.push(current);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('\\')) continue;

    const markers = line.slice(0, parents);
    const text = line.slice(parents);
    if (!/^[-+ ]*$/.test(markers)) {
      inHunk = false;
      current = null;
      continue;
    }
    if (markers.includes('-')) {
      current.lines.push({ type: 'del', oldLine: current._oldCursor, newLine: null, text });
      current._oldCursor += 1;
      deletions += 1;
    } else if (markers.includes('+')) {
      current.lines.push({ type: 'add', oldLine: null, newLine: current._newCursor, text });
      current._newCursor += 1;
      additions += 1;
    } else {
      current.lines.push({
        type: 'context',
        oldLine: current._oldCursor,
        newLine: current._newCursor,
        text,
      });
      current._oldCursor += 1;
      current._newCursor += 1;
    }
  }

  for (const h of hunks) {
    delete h._oldCursor;
    delete h._newCursor;
  }
  return { hunks, binary, additions, deletions };
}

/**
 * Файлы, затронутые выбором. Одиночный мердж-коммит показываем как GitHub —
 * комбинированным диффом: у чистого мерджа он пуст, и это не ошибка.
 */
async function listCommitFiles(repoRoot, from, to) {
  await assertCommit(repoRoot, from);
  if (to !== from) await assertCommit(repoRoot, to);

  const combined = from === to && (await isMergeCommit(repoRoot, from));
  let files;
  if (combined) {
    const raw = await git(
      ['diff-tree', '--cc', '-r', '--raw', '-z', '--no-commit-id', '--no-color', from],
      repoRoot
    );
    files = parseCombinedRawZ(splitZ(raw));
  } else {
    const args = await rangeArgs(repoRoot, from, to);
    const raw = await git(args.concat(['--raw', '-z', '-M', '--no-color']), repoRoot);
    files = parseRawZ(splitZ(raw));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, combined };
}

async function commitFileDiff(repoRoot, from, to, filePath, context) {
  const { files, combined } = await listCommitFiles(repoRoot, from, to);
  const entry = files.find((f) => f.path === filePath);
  if (!entry) {
    throw userError(`Файл "${filePath}" отсутствует в диффе выбранных коммитов.`, 404);
  }
  const unified = Number.isFinite(context) ? context : 3;

  if (combined) {
    const patch = (
      await git(
        [
          'diff-tree',
          '--cc',
          '-r',
          '--no-commit-id',
          '--no-color',
          `-U${unified}`,
          from,
          '--',
          entry.path,
        ],
        repoRoot
      )
    ).toString('utf8');
    return Object.assign({}, entry, parseCombinedPatch(patch), { combined: true });
  }

  const args = (await rangeArgs(repoRoot, from, to)).concat([
    '-M',
    '--no-color',
    `-U${unified}`,
    '--',
    entry.path,
  ]);
  if (entry.oldPath) args.push(entry.oldPath);
  const patch = (await git(args, repoRoot)).toString('utf8');
  return Object.assign({}, entry, parsePatch(patch), { combined: false });
}

function rangeLabel(from, to, count) {
  if (from === to) return `коммит ${short(from)}`;
  return `коммиты ${short(from)}..${short(to)}${count ? ` (${count})` : ''}`;
}

module.exports = {
  listCommits,
  uncommittedSummary,
  listCommitFiles,
  commitFileDiff,
  describeCommand,
  rangeLabel,
  parseCombinedPatch,
  parseCombinedRawZ,
  isMergeCommit,
  emptyTree,
  short,
};
