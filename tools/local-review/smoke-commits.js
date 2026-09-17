'use strict';

/**
 * Smoke-тест режима коммитов (портирован на новую архитектуру дескрипторов —
 * lib/descriptor.js, lib/routes/commits.js, lib/sources/{local,pr}-source.js).
 *
 * Отдельный файл от smoke.js по тем же причинам, что и раньше: и сама фича
 * отдельная, и smoke.js уже большой.
 *
 * Проверяем инварианты, из-за которых фича вообще нужна:
 *   1. история ветки идёт от старого к новому, первый коммит помечен root
 *   2. одиночный (root) коммит сравнивается с пустым деревом, oldText = null
 *   3. мердж-коммит диффится с первым родителем — у чистого мерджа,
 *      принёсшего изменения, этот дифф не пуст
 *   4. номера строк в диффе коммита — реальные номера в файле после изменения
 *   5. контекст коммита доезжает до .md, а комментарий без него экспортируется
 *      ровно как раньше
 *   6. режим коммитов работает и для локальной папки, и для GitHub PR (на
 *      фикстуре gh, без реальной сети)
 *   7. ошибки — 400 на отсутствующих from/to, 404 на несуществующем коммите
 *      и на файле вне диффа выбора, а не 500
 *   8. существующие режимы (working и т.д.) фича не трогает
 *
 * Выходит с ненулевым кодом на первом упавшем ожидании.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { start } = require('./review');

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.error(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`);
  return false;
}

function eq(actual, expected, label) {
  return ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    `ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`
  );
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} -> ${res.status}\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ------------------------------------------------------------------ fixture

/** Линейная история + ветка, влитая мерджем, + грязное рабочее дерево. */
function buildRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-commits-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'smoke@example.com'], root);
  git(['config', 'user.name', 'Smoke Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['config', 'core.autocrlf', 'false'], root);

  write(root, 'a.txt', 'one\ntwo\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'root commit'], root);

  write(root, 'a.txt', 'one\ntwo\nthree\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'second'], root);

  git(['checkout', '-q', '-b', 'side', 'HEAD'], root);
  write(root, 'c.txt', 'side\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'side work'], root);

  git(['checkout', '-q', 'main'], root);
  write(root, 'b.txt', 'bee\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'третий, с длинным сообщением на две строки рельса'], root);

  git(['merge', '-q', '--no-ff', 'side', '-m', 'Merge branch side'], root);

  write(root, 'a.txt', 'one\ntwo\nthree\nfour\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'after merge'], root);

  write(root, 'dirty.txt', 'незакоммиченное\n');
  return root;
}

function makeClient(port) {
  return async function call(pathname, options) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body };
  };
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const FIXTURE_GH = path.join(__dirname, 'smoke-fixtures', 'gh-fixture.js');

/** Points lib/gh.js at the fixture script and installs a manifest (mirrors smoke.js). */
function ghFixtures(manifest, dir) {
  const file = path.join(dir, `gh-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  process.env.LOCAL_REVIEW_GH_BIN = FIXTURE_GH;
  process.env.LOCAL_REVIEW_GH_FIXTURES = file;
  return file;
}

function encodePathSegments(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}
function ghContentsKey(p, ref) {
  return `api -H Accept: application/vnd.github.raw+json repos/o/r/contents/${encodePathSegments(p)}?ref=${ref}`;
}

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// --------------------------------------------------------------------- main

async function main() {
  // Never touch the real ~/.local-review, exactly like smoke.js.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-commits-home-'));
  process.env.LOCAL_REVIEW_HOME = home;

  const repo = buildRepo();
  const server = await start({
    cwd: repo,
    mode: 'working',
    base: 'HEAD~99', // заведомо несуществующая база -> фолбэк на последние коммиты
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  const call = makeClient(server.port);
  const localQ = `source=local&root=${encodeURIComponent(repo)}`;

  console.log('\nистория ветки (GET /api/commits, локальная папка)');
  const history = await call(`/api/commits?${localQ}`);
  const commits = history.body.commits;
  ok(history.status === 200 && commits.length === 6, 'в истории 6 коммитов', commits.length);
  ok(
    commits[0].subject === 'root commit' && commits[5].subject === 'after merge',
    'порядок от старого к новому',
    commits.map((c) => c.subject).join(' | ')
  );
  ok(commits[0].root === true, 'первый коммит помечен root');
  ok(
    commits.filter((c) => c.merge).length === 1,
    'мердж-коммит помечен merge',
    JSON.stringify(commits.map((c) => c.merge))
  );
  ok(history.body.fallback === true, 'без точки ветвления — последние коммиты HEAD');
  ok(history.body.dirty.dirty === true, 'грязное рабочее дерево видно UI', JSON.stringify(history.body.dirty));
  ok(history.body.truncated === false, 'история не обрезана — коммитов меньше лимита');

  // /api/commits doesn't care which mode the current screen is on — it just
  // needs root + base (contract: "local: works for any local mode").
  const historyViaDefaults = await call('/api/commits');
  eq(
    historyViaDefaults.body.commits.map((c) => c.sha),
    commits.map((c) => c.sha),
    '/api/commits без явного дескриптора берёт root/base из дефолтов запуска'
  );

  const commitsQ = (from, to) => `${localQ}&mode=commits&from=${from}&to=${to}`;

  console.log('\nодин коммит (root)');
  const rootState = await call(`/api/state?${commitsQ(commits[0].sha, commits[0].sha)}`);
  ok(
    rootState.status === 200 && rootState.body.files.map((f) => f.path).join(',') === 'a.txt',
    'первый коммит: дифф от пустого дерева',
    JSON.stringify(rootState.body.files)
  );
  eq(rootState.body.rangeLabel, `коммит ${commits[0].short}`, 'rangeLabel одиночного коммита');
  const rootDiff = await call(`/api/diff?file=a.txt&${commitsQ(commits[0].sha, commits[0].sha)}`);
  ok(rootDiff.body.oldText === null, 'root-коммит: oldText = null (пустое дерево)');
  eq(rootDiff.body.newText, 'one\ntwo\n', 'root-коммит: newText = содержимое файла на этом коммите');

  console.log('\nодин обычный коммит');
  const secondDiff = await call(`/api/diff?file=a.txt&${commitsQ(commits[1].sha, commits[1].sha)}`);
  const added = secondDiff.body.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add');
  ok(
    secondDiff.body.additions === 1 && added.newLine === 3 && added.text === 'three',
    'номер строки — реальный номер в файле после изменения',
    JSON.stringify(added)
  );
  eq(secondDiff.body.oldText, 'one\ntwo\n', 'обычный коммит: oldText = содержимое на родителе');
  eq(secondDiff.body.newText, 'one\ntwo\nthree\n', 'обычный коммит: newText = содержимое на этом коммите');

  console.log('\nмердж-коммит (дифф с первым родителем)');
  const merge = commits.find((c) => c.merge);
  const mergeState = await call(`/api/state?${commitsQ(merge.sha, merge.sha)}`);
  ok(
    mergeState.body.files.map((f) => f.path).join(',') === 'c.txt',
    'мердж-коммит: дифф с первым родителем показывает то, что принёс мердж',
    JSON.stringify(mergeState.body.files)
  );
  const mergeDiff = await call(`/api/diff?file=c.txt&${commitsQ(merge.sha, merge.sha)}`);
  ok(
    mergeDiff.body.additions === 1 && mergeDiff.body.hunks[0].lines[0].text === 'side',
    'у чистого мерджа, принёсшего изменения, дифф с первым родителем не пуст',
    JSON.stringify(mergeDiff.body.hunks)
  );

  console.log('\nпросмотренные файлы в режиме коммитов');
  const aIn = async (from, to) =>
    (await call(`/api/state?${commitsQ(from, to)}`)).body.files.find((f) => f.path === 'a.txt');
  const aSecond = await aIn(commits[1].sha, commits[1].sha);
  const markA = await call(
    `/api/viewed?${commitsQ(commits[1].sha, commits[1].sha)}`,
    json('POST', { file: 'a.txt', fingerprint: aSecond.fingerprint, viewed: true })
  );
  ok(markA.status === 200, 'отметка файла в режиме коммитов -> 200', JSON.stringify(markA.body));
  ok((await aIn(commits[1].sha, commits[1].sha)).viewed === true, 'a.txt в том же коммите просмотрен');
  ok((await aIn(commits[0].sha, commits[0].sha)).viewed === false, 'a.txt в другом коммите (другой дифф) не просмотрен');
  ok((await aIn(commits[1].sha, commits[1].sha)).viewed === true, 'возврат к тому же коммиту — отметка на месте');

  // Каждый диапазон — свой вид: отметка одного не трогает отметку другого.
  const aRange = await aIn(commits[1].sha, commits[3].sha);
  await call(
    `/api/viewed?${commitsQ(commits[1].sha, commits[3].sha)}`,
    json('POST', { file: 'a.txt', fingerprint: aRange.fingerprint, viewed: true })
  );
  ok((await aIn(commits[1].sha, commits[3].sha)).viewed === true, 'a.txt отмечен в диапазоне');
  ok((await aIn(commits[1].sha, commits[1].sha)).viewed === true, 'отметка диапазона не стёрла отметку одного коммита');
  await call(`/api/viewed?${commitsQ(commits[1].sha, commits[3].sha)}`, json('POST', { file: 'a.txt', viewed: false }));
  ok((await aIn(commits[1].sha, commits[1].sha)).viewed === true, 'снятие в диапазоне не трогает отметку одного коммита');
  await call(`/api/viewed?${commitsQ(commits[1].sha, commits[1].sha)}`, json('POST', { file: 'a.txt', viewed: false }));

  console.log('\nдиапазон');
  const range = await call(`/api/state?${commitsQ(commits[1].sha, commits[3].sha)}`);
  ok(
    range.status === 200 && range.body.files.length >= 2,
    'диапазон собирает файлы нескольких коммитов',
    JSON.stringify(range.body.files.map((f) => f.path))
  );
  eq(
    range.body.rangeLabel,
    `коммиты ${commits[1].short}..${commits[3].short}`,
    'rangeLabel диапазона'
  );

  console.log('\nошибки — внятные, а не 500');
  const noRange = await call(`/api/state?${localQ}&mode=commits`);
  ok(noRange.status === 400, 'режим «коммиты» без from/to -> 400', JSON.stringify(noRange.body));
  const missing = await call(
    `/api/state?${commitsQ('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')}`
  );
  ok(missing.status === 404, 'несуществующий коммит -> 404', JSON.stringify(missing.body));
  const notInRange = await call(`/api/diff?file=b.txt&${commitsQ(commits[0].sha, commits[0].sha)}`);
  ok(notInRange.status === 404, 'файл вне диффа выбранных коммитов -> 404', JSON.stringify(notInRange.body));

  console.log('\nэкспорт');
  await call(
    `/api/comments?${commitsQ(commits[1].sha, commits[3].sha)}`,
    json('POST', {
      file: 'a.txt',
      startLine: 3,
      endLine: 3,
      text: 'комментарий из диапазона',
      commit: { from: commits[1].short, to: commits[3].short, label: 'коммиты 2–4' },
    })
  );
  await call(`/api/comments?${localQ}`, json('POST', { file: 'a.txt', startLine: 4, endLine: 4, text: 'с последнего' }));
  const md = (await call(`/api/export/text?${localQ}`)).body;
  ok(
    md.includes(`a.txt:L3\n${commits[1].short}..${commits[3].short} · коммиты 2–4\nкомментарий из диапазона`),
    'комментарий из диапазона получил строку с коммитами',
    JSON.stringify(md)
  );
  ok(md.includes('a.txt:L4\nс последнего'), 'комментарий без контекста экспортируется как раньше', JSON.stringify(md));
  const stored = JSON.parse(fs.readFileSync(path.join(repo, '.local-review', 'comments.json'), 'utf8')).comments;
  ok(
    stored.length === 2 && stored[0].commit && !stored[1].commit,
    'контекст коммита лежит в хранилище только там, где он есть',
    JSON.stringify(stored.map((c) => c.commit || null))
  );

  console.log('\nстарые режимы не тронуты');
  const working = await call(`/api/state?${localQ}&mode=working`);
  ok(
    working.status === 200 && working.body.files.some((f) => f.path === 'dirty.txt'),
    'режим working работает как раньше',
    JSON.stringify(working.body.files.map((f) => f.path))
  );

  await new Promise((resolve) => server.server.close(resolve));
  fs.rmSync(repo, { recursive: true, force: true });

  // --------------------------------------------------------- GitHub PR ---
  console.log('\nGitHub PR: список коммитов и дифф по диапазону (на фикстуре gh)');

  const prRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-commits-pr-'));
  const prServer = await start({ cwd: prRoot, mode: 'working', base: 'origin/main', port: 0, host: '127.0.0.1', open: false });
  const prCall = makeClient(prServer.port);

  const C1 = 'c1111111111111111111111111111111111111a'; // root of the PR's own history: no parent
  const C2 = 'c2222222222222222222222222222222222222b';
  const viewKey = (n) =>
    `pr view ${n} --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url`;
  const commitsListKey = `api repos/o/r/pulls/30/commits?per_page=100&page=1`;

  ghFixtures(
    {
      [viewKey(30)]: {
        code: 0,
        stdout: JSON.stringify({
          number: 30,
          title: 'PR с диапазоном коммитов',
          author: { login: 'octocat' },
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feat/range',
          baseRefName: 'main',
          headRefOid: C2,
          url: 'https://github.com/o/r/pull/30',
        }),
      },
      'pr view 30 --repo o/r --json baseRefName': { code: 0, stdout: JSON.stringify({ baseRefName: 'main' }) },
      // The whole-PR diff: the "no range selected" view, which keeps its own
      // viewed marks (a different diff of the same file than any range).
      'pr diff 30 --repo o/r': {
        code: 0,
        stdout: [
          'diff --git a/x.txt b/x.txt',
          'index 1111111..2222222 100644',
          '--- a/x.txt',
          '+++ b/x.txt',
          '@@ -1 +1 @@',
          '-первая версия',
          '+вторая версия',
          '',
        ].join('\n'),
      },
      [commitsListKey]: {
        code: 0,
        stdout: JSON.stringify([
          {
            sha: C1,
            commit: { author: { name: 'Octo Cat', date: '2026-09-01T10:00:00Z' }, message: 'первый коммит PR-а' },
            parents: [],
          },
          {
            sha: C2,
            commit: {
              author: { name: 'Octo Cat', date: '2026-09-02T10:00:00Z' },
              message: 'второй коммит PR-а\n\nтело сообщения',
            },
            parents: [{ sha: C1 }],
          },
        ]),
      },
      [`api repos/o/r/commits/${C1}`]: { code: 0, stdout: JSON.stringify({ sha: C1, parents: [] }) },
      [`api repos/o/r/commits/${C2}`]: { code: 0, stdout: JSON.stringify({ sha: C2, parents: [{ sha: C1 }] }) },
      [`api repos/o/r/compare/${EMPTY_TREE_SHA1}...${C2}?per_page=100&page=1`]: {
        code: 0,
        stdout: JSON.stringify({
          files: [
            {
              filename: 'x.txt',
              status: 'added',
              additions: 1,
              deletions: 0,
              patch: '@@ -0,0 +1 @@\n+первая версия',
            },
          ],
        }),
      },
      [`api repos/o/r/compare/${C1}...${C2}?per_page=100&page=1`]: {
        code: 0,
        stdout: JSON.stringify({
          files: [
            {
              filename: 'x.txt',
              status: 'modified',
              additions: 1,
              deletions: 1,
              patch: '@@ -1 +1 @@\n-первая версия\n+вторая версия',
            },
          ],
        }),
      },
      [ghContentsKey('x.txt', EMPTY_TREE_SHA1)]: { code: 1, stderr: 'HTTP 404: Not Found\n' },
      [ghContentsKey('x.txt', C1)]: { code: 0, stdout: 'первая версия\n' },
      [ghContentsKey('x.txt', C2)]: { code: 0, stdout: 'вторая версия\n' },
    },
    home
  );

  const prHistory = await prCall('/api/commits?source=pr&host=github.com&owner=o&repo=r&number=30');
  ok(prHistory.status === 200, 'GET /api/commits для PR -> 200', JSON.stringify(prHistory.body).slice(0, 200));
  eq(
    prHistory.body.commits.map((c) => c.sha),
    [C1, C2],
    'коммиты PR-а от старого к новому'
  );
  ok(prHistory.body.commits[0].root === true, 'первый коммит PR-а помечен root (родителей нет)');
  eq(prHistory.body.dirty, { dirty: false, files: 0 }, 'у PR-а незакоммиченных изменений не бывает');
  eq(prHistory.body.fallback, false, 'у PR-а нет понятия «фолбэк»');
  eq(prHistory.body.base, 'main', 'база истории PR-а = его baseRefName');

  const prQ = (from, to) => `source=pr&host=github.com&owner=o&repo=r&number=30&from=${from}&to=${to}`;

  console.log('\nPR: диапазон от корневого коммита (пустое дерево слева)');
  const prRootState = await prCall(`/api/state?${prQ(C1, C2)}`);
  ok(
    prRootState.status === 200 && prRootState.body.files.map((f) => f.path).join(',') === 'x.txt',
    'PR: файл из compare-диффа попал в список',
    JSON.stringify(prRootState.body.files)
  );
  eq(prRootState.body.rangeLabel, `коммиты ${C1.slice(0, 7)}..${C2.slice(0, 7)}`, 'PR: rangeLabel диапазона (не ветка PR-а)');
  const prRootDiff = await prCall(`/api/diff?file=x.txt&${prQ(C1, C2)}`);
  ok(prRootDiff.body.oldText === null, 'PR: диапазон от корневого коммита -> oldText = null (пустое дерево)');
  eq(prRootDiff.body.newText, 'вторая версия\n', 'PR: newText = содержимое на верхнем коммите диапазона');
  const prRootAdded = prRootDiff.body.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add');
  ok(prRootAdded && prRootAdded.newLine === 1, 'PR: номер строки в диффе диапазона реальный', JSON.stringify(prRootAdded));

  console.log('\nPR: диапазон одного коммита (левая сторона — его настоящий родитель)');
  const prSingleDiff = await prCall(`/api/diff?file=x.txt&${prQ(C2, C2)}`);
  eq(prSingleDiff.body.oldText, 'первая версия\n', 'PR: oldText берётся с реального первого родителя');
  eq(prSingleDiff.body.newText, 'вторая версия\n', 'PR: newText берётся с верхнего коммита диапазона');

  console.log('\nPR: просмотренные файлы в диапазоне коммитов');
  const xIn = async (from, to) =>
    (await prCall(`/api/state?${prQ(from, to)}`)).body.files.find((f) => f.path === 'x.txt');
  const xSingle = await xIn(C2, C2);
  await prCall(`/api/viewed?${prQ(C2, C2)}`, json('POST', { file: 'x.txt', fingerprint: xSingle.fingerprint, viewed: true }));
  ok((await xIn(C2, C2)).viewed === true, 'PR: x.txt в диапазоне одного коммита просмотрен');
  ok((await xIn(C1, C2)).viewed === false, 'PR: x.txt в другом диапазоне (другой патч) не просмотрен');

  // "Все изменения" — отдельный вид со своими отметками.
  const wholeQ = 'source=pr&host=github.com&owner=o&repo=r&number=30';
  const xWhole = async () => (await prCall(`/api/state?${wholeQ}`)).body.files.find((f) => f.path === 'x.txt');
  ok((await xWhole()).viewed === false, 'PR: отметка диапазона не переносится на «Все изменения»');
  await prCall(`/api/viewed?${wholeQ}`, json('POST', { file: 'x.txt', fingerprint: (await xWhole()).fingerprint, viewed: true }));
  ok((await xWhole()).viewed === true, 'PR: x.txt отмечен в «Все изменения»');
  ok((await xIn(C2, C2)).viewed === true, 'PR: отметка в «Все изменения» не стёрла отметку диапазона');
  await prCall(`/api/viewed?${wholeQ}`, json('POST', { file: 'x.txt', viewed: false }));
  ok((await xWhole()).viewed === false && (await xIn(C2, C2)).viewed === true, 'PR: снятие в «Все изменения» не трогает диапазон');

  console.log('\nPR: ошибки — 400 без пары from/to');
  const oneSided = await prCall(`/api/state?source=pr&host=github.com&owner=o&repo=r&number=30&from=${C1}`);
  ok(oneSided.status === 400, 'PR: только from без to -> 400', JSON.stringify(oneSided.body));

  console.log('\nPR: комментарий по диапазону коммитов + экспорт');
  await prCall(
    `/api/comments?${prQ(C1, C2)}`,
    json('POST', {
      file: 'x.txt',
      startLine: 1,
      endLine: 1,
      text: 'комментарий к диапазону PR-а',
      commit: { from: C1.slice(0, 7), to: C2.slice(0, 7), label: 'коммиты PR-а' },
    })
  );
  const prMd = (await prCall(`/api/export/text?source=pr&host=github.com&owner=o&repo=r&number=30`)).body;
  ok(
    prMd.includes(`x.txt:L1\n${C1.slice(0, 7)}..${C2.slice(0, 7)} · коммиты PR-а\nкомментарий к диапазону PR-а`),
    'PR: комментарий диапазона экспортирован с контекстом коммитов',
    JSON.stringify(prMd)
  );

  console.log('\nPR: без диапазона поведение прежнее');
  eq(
    (await prCall('/api/state?source=pr&host=github.com&owner=o&repo=r&number=30')).body.rangeLabel,
    'main ← feat/range',
    'PR без выбранного диапазона: rangeLabel — по-прежнему база ← ветка'
  );

  await new Promise((resolve) => prServer.server.close(resolve));

  console.log(`\n${checks - failures}/${checks} проверок прошло`);
  if (failures) {
    console.error(`\n${failures} проверок упало. Временная папка PR-режима оставлена:\n  ${prRoot}\n`);
    process.exit(1);
  }
  fs.rmSync(prRoot, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log('\nрежим коммитов: все проверки зелёные\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nСмоук режима коммитов упал с исключением:\n', err);
  process.exit(1);
});
