'use strict';

/**
 * Smoke-тест режима коммитов.
 *
 * Отдельный файл, потому что и сама фича отдельная: smoke.js проверяет
 * режимы working / staged / base и про коммиты ничего не знает.
 *
 * Проверяем инварианты, из-за которых фича вообще нужна:
 *   1. история ветки идёт от старого к новому, первый коммит помечен root
 *   2. одиночный коммит — это `git show`, первый — дифф от пустого дерева
 *   3. мердж показывается комбинированным диффом, у чистого мерджа он пуст
 *   4. номера строк в диффе коммита — реальные номера в файле после изменения
 *   5. контекст коммита доезжает до .md, а комментарий без него экспортируется
 *      ровно как раньше
 *   6. существующие режимы фича не трогает
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

/** Мердж с руками разрешённым конфликтом: комбинированный дифф непустой. */
function buildConflictRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-conflict-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'smoke@example.com'], root);
  git(['config', 'user.name', 'Smoke Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  write(root, 'f.txt', 'a\nb\nc\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'base'], root);

  git(['checkout', '-q', '-b', 'side'], root);
  write(root, 'f.txt', 'a\nSIDE\nc\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'side'], root);

  git(['checkout', '-q', 'main'], root);
  write(root, 'f.txt', 'a\nMAIN\nc\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'main change'], root);

  // Конфликт ожидаем — merge вернёт ненулевой код, это часть сценария.
  spawnSync('git', ['merge', '--no-ff', 'side'], { cwd: root, encoding: 'utf8' });
  write(root, 'f.txt', 'a\nRESOLVED\nc\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'Merge side with conflict'], root);
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

// --------------------------------------------------------------------- main

async function main() {
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

  console.log('\nистория ветки');
  const history = await call('/api/commits');
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

  console.log('\nодин коммит');
  const first = await call(`/api/commits/state?from=${commits[0].sha}&to=${commits[0].sha}&count=1`);
  ok(
    first.status === 200 && first.body.files.map((f) => f.path).join(',') === 'a.txt',
    'первый коммит: дифф от пустого дерева',
    JSON.stringify(first.body.files)
  );
  ok(/<empty-tree>/.test(first.body.command), 'команда первого коммита', first.body.command);

  const second = await call(`/api/commits/state?from=${commits[1].sha}&to=${commits[1].sha}&count=1`);
  ok(second.body.command === `git show ${commits[1].short}`, 'команда обычного коммита', second.body.command);

  const secondDiff = await call(`/api/commits/diff?file=a.txt&from=${commits[1].sha}&to=${commits[1].sha}`);
  const added = secondDiff.body.hunks[0].lines.find((l) => l.type === 'add');
  ok(
    secondDiff.body.additions === 1 && added.newLine === 3 && added.text === 'three',
    'номер строки — реальный номер в файле после изменения',
    JSON.stringify(added)
  );

  console.log('\nмердж-коммит');
  const merge = commits.find((c) => c.merge);
  const mergeState = await call(`/api/commits/state?from=${merge.sha}&to=${merge.sha}&count=1`);
  ok(mergeState.body.combined === true, 'мердж отдаётся комбинированным диффом');
  ok(mergeState.body.files.length === 0, 'у чистого мерджа комбинированный дифф пуст',
    JSON.stringify(mergeState.body.files));
  ok(mergeState.body.command === `git show --cc ${merge.short}`, 'команда мерджа', mergeState.body.command);

  console.log('\nдиапазон');
  const range = await call(`/api/commits/state?from=${commits[1].sha}&to=${commits[3].sha}&count=3`);
  ok(range.status === 200 && range.body.files.length >= 2, 'диапазон собирает файлы нескольких коммитов',
    JSON.stringify(range.body.files.map((f) => f.path)));
  ok(
    range.body.command === `git diff ${commits[1].short}^..${commits[3].short}`,
    'команда диапазона',
    range.body.command
  );
  ok(/^коммиты /.test(range.body.rangeLabel), 'подпись диапазона', range.body.rangeLabel);

  console.log('\nошибки — внятные, а не 500');
  const missing = await call('/api/commits/state?from=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  ok(missing.status === 404, 'несуществующий коммит -> 404', JSON.stringify(missing.body));
  ok(
    (await call('/api/commits/state')).status === 400,
    'запрос без from -> 400'
  );
  ok(
    (await call(`/api/commits/diff?from=${commits[0].sha}`)).status === 400,
    'дифф без file -> 400'
  );
  const notInRange = await call(`/api/commits/diff?file=b.txt&from=${commits[0].sha}&to=${commits[0].sha}`);
  ok(notInRange.status === 404, 'файл вне диффа выбранных коммитов -> 404', JSON.stringify(notInRange.body));

  console.log('\nэкспорт');
  await call(
    '/api/comments',
    json('POST', {
      file: 'a.txt',
      startLine: 3,
      endLine: 3,
      text: 'комментарий из диапазона',
      commit: { from: commits[1].short, to: commits[3].short, label: 'коммиты 2–4' },
    })
  );
  await call('/api/comments', json('POST', { file: 'a.txt', startLine: 4, endLine: 4, text: 'с последнего' }));
  const md = (await call('/api/export/text')).body;
  ok(
    md.includes(`a.txt:L3\n${commits[1].short}..${commits[3].short} · коммиты 2–4\nкомментарий из диапазона`),
    'комментарий из диапазона получил строку с коммитами',
    JSON.stringify(md)
  );
  ok(
    md.includes('a.txt:L4\nс последнего'),
    'комментарий без контекста экспортируется как раньше',
    JSON.stringify(md)
  );
  const stored = JSON.parse(
    fs.readFileSync(path.join(repo, '.local-review', 'comments.json'), 'utf8')
  ).comments;
  ok(
    stored.length === 2 && stored[0].commit && !stored[1].commit,
    'контекст коммита лежит в хранилище только там, где он есть',
    JSON.stringify(stored.map((c) => c.commit || null))
  );

  console.log('\nстарые режимы не тронуты');
  const working = await call('/api/state?mode=working');
  ok(
    working.status === 200 && working.body.files.some((f) => f.path === 'dirty.txt'),
    'режим working работает как раньше',
    JSON.stringify(working.body.files.map((f) => f.path))
  );
  ok(
    (await call('/api/state?mode=commits')).status === 400,
    '/api/state по-прежнему знает только working | staged | base'
  );

  await new Promise((resolve) => server.server.close(resolve));

  console.log('\nмердж с разрешённым конфликтом');
  const conflictRepo = buildConflictRepo();
  const conflictServer = await start({
    cwd: conflictRepo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  const conflictCall = makeClient(conflictServer.port);
  const head = (await conflictCall('/api/commits')).body.commits.find((c) => c.merge);
  const state = await conflictCall(`/api/commits/state?from=${head.sha}&to=${head.sha}&count=1`);
  ok(
    state.body.files.map((f) => f.path).join(',') === 'f.txt',
    'мердж с конфликтом: файл виден в комбинированном диффе',
    JSON.stringify(state.body.files)
  );
  const conflictDiff = await conflictCall(
    `/api/commits/diff?file=f.txt&from=${head.sha}&to=${head.sha}`
  );
  const resolved = conflictDiff.body.hunks
    .flatMap((h) => h.lines)
    .find((l) => l.text === 'RESOLVED');
  ok(
    resolved && resolved.type === 'add' && resolved.newLine === 2,
    'разрешённая строка стоит на реальном номере 2',
    JSON.stringify(resolved)
  );
  await new Promise((resolve) => conflictServer.server.close(resolve));

  console.log(`\n${checks - failures}/${checks} проверок прошло`);
  if (failures) {
    console.error(`\n${failures} проверок упало. Временные репозитории оставлены:\n  ${repo}\n  ${conflictRepo}\n`);
    process.exit(1);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(conflictRepo, { recursive: true, force: true });
  console.log('\nрежим коммитов: все проверки зелёные\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nСмоук режима коммитов упал с исключением:\n', err);
  process.exit(1);
});
