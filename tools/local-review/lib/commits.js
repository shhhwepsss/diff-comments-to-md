'use strict';

/**
 * История коммитов ветки и дифф по одному коммиту / диапазону коммитов.
 *
 * Модуль стоит рядом с diff.js и переиспользует его парсеры, но ни один из
 * существующих режимов (working / staged / base) через него не ходит: фича
 * «выбор диапазона коммитов» живёт отдельно и её можно выключить, не трогая
 * остальное.
 *
 * Мердж-коммит диффится с первым родителем (`sha^` == `sha^1` в git) — точно
 * так же, как любой другой одиночный коммит; отдельного «комбинированного»
 * (`--cc`) пути здесь больше нет.
 */

const { git, gitText, gitTry, hasHead, revExists, mergeBase, gitShow } = require('./git');
const { parsePatch, parseRawZ, splitZ, MAX_TEXT_BYTES, TEXT_TOO_BIG_MESSAGE } = require('./diff');

// Разделители внутри --format: в сообщении коммита их не бывает, в отличие от
// любого печатного символа, который кто-нибудь да напишет.
const FIELD = '\x1f';
const RECORD = '\x1e';

const DEFAULT_LIMIT = 200;

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 =
  '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

const emptyTreeCache = new Map();

/** Хеш пустого дерева — левая сторона диффа для самого первого (root) коммита. */
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

async function assertCommit(repoRoot, sha, what) {
  if (!(await revExists(sha, repoRoot))) {
    throw userError(`Коммит "${what || sha}" не найден в этом репозитории.`, 404);
  }
}

/**
 * Левая сторона диффа выбора и argv для `git diff`: от первого родителя
 * нижнего коммита (`from^`, что для мерджа и есть первый родитель) до
 * верхнего. У самого первого (root) коммита родителя нет — сравниваем с
 * пустым деревом.
 */
async function rangeArgs(repoRoot, from, to) {
  const parent = await gitTry(['rev-parse', '--verify', '--quiet', `${from}^`], repoRoot);
  const left = parent ? parent.trim() : await emptyTree(repoRoot);
  return { args: ['diff', left, to], left };
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/** Файлы, затронутые выбором (одним коммитом или диапазоном). */
async function listCommitFiles(repoRoot, from, to) {
  await assertCommit(repoRoot, from);
  if (to !== from) await assertCommit(repoRoot, to);

  const { args } = await rangeArgs(repoRoot, from, to);
  const raw = await git(args.concat(['--raw', '-z', '-M', '--no-color', '--no-abbrev']), repoRoot);
  const files = parseRawZ(splitZ(raw));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

/**
 * Полный текст файла по обе стороны выбора (для построчного дифф-виджета),
 * тем же правилом, что и loadTexts в lib/diff.js: старый текст — `gitShow`
 * на левой стороне (родитель нижнего коммита или пустое дерево), новый —
 * `gitShow` на верхнем коммите. И то и другое естественно даёт null, когда
 * пути не существует на этой стороне (добавленный / удалённый файл).
 */
async function loadCommitTexts(repoRoot, left, to, entry) {
  if (entry.binary) return { oldText: null, newText: null };

  const oldPath = entry.oldPath || entry.path;
  const oldBuf = await gitShow(left, oldPath, repoRoot);
  const newBuf = await gitShow(to, entry.path, repoRoot);

  if ((oldBuf && oldBuf.length > MAX_TEXT_BYTES) || (newBuf && newBuf.length > MAX_TEXT_BYTES)) {
    return { oldText: null, newText: null, textUnavailable: TEXT_TOO_BIG_MESSAGE };
  }
  return {
    oldText: oldBuf !== null ? oldBuf.toString('utf8') : null,
    newText: newBuf !== null ? newBuf.toString('utf8') : null,
  };
}

async function commitFileDiff(repoRoot, from, to, filePath, context) {
  const { files } = await listCommitFiles(repoRoot, from, to);
  const entry = files.find((f) => f.path === filePath);
  if (!entry) {
    throw userError(`Файл "${filePath}" отсутствует в диффе выбранных коммитов.`, 404);
  }
  const unified = Number.isFinite(context) ? context : 3;

  const { args, left } = await rangeArgs(repoRoot, from, to);
  const diffArgs = args.concat(['-M', '--no-color', `-U${unified}`, '--', entry.path]);
  if (entry.oldPath) diffArgs.push(entry.oldPath);
  const patch = (await git(diffArgs, repoRoot)).toString('utf8');

  const result = Object.assign({}, entry, parsePatch(patch));
  const texts = await loadCommitTexts(repoRoot, left, to, result);
  return Object.assign(result, texts);
}

function rangeLabel(from, to) {
  if (from === to) return `коммит ${short(from)}`;
  return `коммиты ${short(from)}..${short(to)}`;
}

module.exports = {
  listCommits,
  uncommittedSummary,
  listCommitFiles,
  commitFileDiff,
  rangeLabel,
  emptyTree,
  short,
};
