'use strict';

/**
 * End-to-end smoke test.
 *
 * Builds a throwaway git repository, starts the real server against it, drives
 * every API endpoint over HTTP and asserts the invariants:
 *   1. export (.md + clipboard text) never mutates comments
 *   2. the only bulk delete is clear-all, and only with an explicit confirm
 *   3. comments survive a server restart (they live in a file, not in memory)
 *   4. exported line numbers are real line numbers in the post-change file
 *
 * Exits non-zero on the first failure.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { start } = require('./review');
const { splitLines } = require('./lib/diff');

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
  return abs;
}

// ------------------------------------------------------------------ fixture

function buildRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-smoke-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'smoke@example.com'], root);
  git(['config', 'user.name', 'Smoke Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['config', 'core.autocrlf', 'false'], root);

  // --- commit 1: the baseline -------------------------------------------
  write(root, 'src/app.js', ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n') + '\n');
  write(
    root,
    'src/to-rename.js',
    [
      'const answer = 42;',
      'const question = "unknown";',
      'function ask() {',
      '  return question;',
      '}',
      'module.exports = { answer, ask };',
    ].join('\n') + '\n'
  );
  write(root, 'src/to-delete.js', 'module.exports = null;\n');
  write(root, 'assets/logo.bin', Buffer.from([0, 1, 2, 3, 0, 255, 7, 9]));
  write(root, 'документы/мой файл.txt', 'первая строка\nвторая строка\n');
  write(root, 'crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');
  write(root, 'big.txt', Array.from({ length: 3000 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'baseline'], root);

  // --- second commit so `--base HEAD~1` has something to compare ---------
  write(root, 'src/app.js', ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n') + '\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'second'], root);

  // --- dirty worktree ----------------------------------------------------
  // app.js: insert two lines after line 2 -> "inserted A" lands on line 3.
  write(
    root,
    'src/app.js',
    ['line 1', 'line 2', 'inserted A', 'inserted B', 'line 3', 'line 4', 'line 5', 'line 6'].join(
      '\n'
    ) + '\n'
  );
  git(['mv', 'src/to-rename.js', 'src/renamed.js'], root);
  fs.appendFileSync(path.join(root, 'src/renamed.js'), 'const extra = true;\n');
  fs.unlinkSync(path.join(root, 'src/to-delete.js'));
  write(root, 'assets/logo.bin', Buffer.from([0, 9, 9, 9, 0, 1, 2, 3]));
  write(root, 'документы/мой файл.txt', 'первая строка\nвторая строка\nтретья строка\n');
  write(root, 'crlf.txt', 'alpha\r\nbeta изменилась\r\ngamma\r\n');
  write(
    root,
    'big.txt',
    Array.from({ length: 3000 }, (_, i) => (i === 1500 ? `row ${i + 1} touched` : `row ${i + 1}`)).join(
      '\n'
    ) + '\n'
  );
  write(root, 'brand new.txt', 'новый файл\nвторая строка нового файла\n');

  return root;
}

// -------------------------------------------------------------------- HTTP

function makeClient(port) {
  const origin = `http://127.0.0.1:${port}`;
  return async function call(pathname, options) {
    const res = await fetch(origin + pathname, options);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body };
  };
}

function json(method, payload) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

// -------------------------------------------------------------------- suite

async function main() {
  const repo = buildRepo();
  console.log(`\ntemp repo: ${repo}\n`);

  let server = await start({
    cwd: repo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  let call = makeClient(server.port);

  // ---------------------------------------------------------------- state
  console.log('state / diff');
  const state = await call('/api/state');
  ok(state.status === 200, 'GET /api/state -> 200', `status ${state.status}`);
  const paths = state.body.files.map((f) => f.path);
  ok(paths.includes('src/app.js'), 'изменённый файл в списке', paths.join(', '));
  ok(paths.includes('src/renamed.js'), 'переименование в списке');
  ok(paths.includes('src/to-delete.js'), 'удалённый файл в списке');
  ok(paths.includes('brand new.txt'), 'untracked-файл с пробелом в имени в списке');
  ok(paths.includes('документы/мой файл.txt'), 'кириллический путь с пробелом в списке');

  const renamed = state.body.files.find((f) => f.path === 'src/renamed.js');
  ok(renamed && renamed.oldPath === 'src/to-rename.js', 'у переименования сохранён oldPath',
    JSON.stringify(renamed));

  const binary = await call('/api/diff?file=' + encodeURIComponent('assets/logo.bin'));
  ok(binary.status === 200 && binary.body.binary === true, 'бинарный файл помечен binary',
    JSON.stringify(binary.body).slice(0, 200));

  const deleted = await call('/api/diff?file=' + encodeURIComponent('src/to-delete.js'));
  ok(deleted.status === 200, 'дифф удалённого файла отдаётся без падения');
  ok(
    deleted.body.hunks.every((h) => h.lines.every((l) => l.type === 'del')),
    'у удалённого файла только удалённые строки'
  );

  const crlf = await call('/api/diff?file=crlf.txt');
  ok(
    crlf.status === 200 &&
      crlf.body.hunks.some((h) => h.lines.some((l) => l.type === 'add' && !l.text.includes('\r'))),
    'CRLF: возврат каретки не попадает в текст строки'
  );

  const big = await call('/api/diff?file=big.txt');
  ok(big.status === 200 && big.body.hunks.length > 0, 'большой файл отдаётся');
  const bigTouched = big.body.hunks
    .flatMap((h) => h.lines)
    .find((l) => l.type === 'add' && l.text.includes('touched'));
  ok(bigTouched && bigTouched.newLine === 1501, 'номер строки в большом файле = 1501',
    JSON.stringify(bigTouched));

  const untracked = await call('/api/diff?file=' + encodeURIComponent('brand new.txt'));
  ok(
    untracked.status === 200 && untracked.body.additions === 2,
    'untracked-файл показан как 2 добавленные строки',
    JSON.stringify(untracked.body.additions)
  );

  const missing = await call('/api/diff?file=nope.txt');
  ok(missing.status === 404, 'дифф несуществующего файла -> 404, а не stacktrace');

  // ------------------------------------------------- invariant 4: numbers
  console.log('\nинвариант 4: реальные номера строк');
  const appDiff = await call('/api/diff?file=' + encodeURIComponent('src/app.js'));
  const added = appDiff.body.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add');
  const fileLines = splitLines(fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'));
  let numbersMatch = added.length > 0;
  for (const line of added) {
    if (fileLines[line.newLine - 1] !== line.text) numbersMatch = false;
  }
  ok(numbersMatch, 'newLine указывает на реальную строку файла после изменений',
    JSON.stringify(added));
  const insertedA = added.find((l) => l.text === 'inserted A');
  ok(insertedA && insertedA.newLine === 3, '"inserted A" = строка 3', JSON.stringify(insertedA));

  // ------------------------------------------------------------- comments
  console.log('\nCRUD комментариев');
  const created = [];
  const specs = [
    { file: 'src/app.js', startLine: 3, endLine: 3, text: 'Однострочный комментарий' },
    { file: 'src/app.js', startLine: 3, endLine: 4, text: 'Комментарий к диапазону' },
    { file: 'документы/мой файл.txt', startLine: 3, endLine: 3, text: 'Кириллица и пробелы' },
    { file: 'assets/logo.bin', startLine: null, endLine: null, text: 'Комментарий к файлу' },
    { file: 'big.txt', startLine: 1501, endLine: 1501, text: 'Большой файл' },
  ];
  for (const spec of specs) {
    const res = await call('/api/comments', json('POST', spec));
    ok(res.status === 201, `POST /api/comments (${spec.file})`, JSON.stringify(res.body));
    created.push(res.body.comment);
  }

  const empty = await call('/api/comments', json('POST', { file: 'src/app.js', text: '   ' }));
  ok(empty.status === 400, 'пустой комментарий отклоняется');

  const afterCreate = await call('/api/comments');
  eq(afterCreate.body.comments.length, 5, 'создано ровно 5 комментариев');

  const stateWithCounts = await call('/api/state');
  const appFile = stateWithCounts.body.files.find((f) => f.path === 'src/app.js');
  eq(appFile.comments, 2, 'счётчик комментариев у файла в списке');

  // edit touches only the target
  const editRes = await call(
    `/api/comments/${created[0].id}`,
    json('PUT', { text: 'Отредактировано' })
  );
  ok(editRes.status === 200, 'PUT комментария -> 200');
  const afterEdit = (await call('/api/comments')).body.comments;
  eq(afterEdit.length, 5, 'после редактирования комментариев по-прежнему 5');
  eq(
    afterEdit.find((c) => c.id === created[0].id).text,
    'Отредактировано',
    'отредактирован именно нужный комментарий'
  );
  eq(
    afterEdit.find((c) => c.id === created[1].id).text,
    'Комментарий к диапазону',
    'соседний комментарий не тронут'
  );

  // delete touches only the target
  const delRes = await call(`/api/comments/${created[4].id}`, { method: 'DELETE' });
  ok(delRes.status === 200, 'DELETE комментария -> 200');
  const afterDelete = (await call('/api/comments')).body.comments;
  eq(afterDelete.length, 4, 'после удаления одного осталось 4');
  ok(
    afterDelete.every((c) => c.id !== created[4].id),
    'удалён именно тот комментарий'
  );

  // --------------------------------------------- invariant 1: export is pure
  console.log('\nинвариант 1: экспорт не меняет комментарии');
  const before = (await call('/api/comments')).body.comments;
  const text1 = await call('/api/export/text');
  const file1 = await call('/api/export/file', { method: 'POST' });
  const text2 = await call('/api/export/text');
  const file2 = await call('/api/export/file', { method: 'POST' });
  const after = (await call('/api/comments')).body.comments;

  eq(after.length, before.length, 'после 4 экспортов количество комментариев не изменилось');
  eq(
    after.map((c) => c.id).sort(),
    before.map((c) => c.id).sort(),
    'после экспортов те же самые id'
  );
  ok(file1.status === 200 && file2.status === 200, 'POST /api/export/file -> 200');
  ok(
    fs.existsSync(file1.body.path) && /^review-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(file1.body.file),
    'файл review-<YYYY-MM-DD-HHmm>.md создан в корне репозитория',
    file1.body.file
  );

  const markdown = fs.readFileSync(file1.body.path, 'utf8');
  eq(markdown, text1.body, '.md и текст для буфера совпадают');
  ok(markdown.includes('src/app.js:L3\n'), 'формат одиночной строки path:L3', markdown);
  ok(markdown.includes('src/app.js:L3-L4\n'), 'формат диапазона path:L3-L4', markdown);
  ok(markdown.includes('assets/logo.bin\n'), 'комментарий к файлу — без :L', markdown);
  ok(
    markdown.includes('документы/мой файл.txt:L3\n'),
    'кириллический путь с пробелом в экспорте',
    markdown
  );

  // exported numbers still point at the real lines
  for (const block of markdown.split('\n\n')) {
    const head = block.split('\n')[0];
    const m = /^(.*):L(\d+)(?:-L(\d+))?$/.exec(head);
    if (!m) continue;
    const abs = path.join(repo, m[1]);
    if (!fs.existsSync(abs)) continue;
    const lines = splitLines(fs.readFileSync(abs, 'utf8'));
    ok(
      Number(m[2]) >= 1 && Number(m[3] || m[2]) <= lines.length,
      `номер строки из экспорта существует в файле (${head})`,
      `в файле ${lines.length} строк`
    );
  }

  // ---------------------------------- invariant 2: clear-all needs confirm
  console.log('\nинвариант 2: массовое удаление только с подтверждением');
  const noConfirm = await call('/api/comments/clear-all', json('POST', {}));
  ok(noConfirm.status === 400, 'clear-all без confirm -> 400', JSON.stringify(noConfirm.body));
  const falseConfirm = await call('/api/comments/clear-all', json('POST', { confirm: false }));
  ok(falseConfirm.status === 400, 'clear-all с confirm:false -> 400');
  const stringConfirm = await call('/api/comments/clear-all', json('POST', { confirm: 'true' }));
  ok(stringConfirm.status === 400, 'clear-all с confirm:"true" (строка) -> 400');
  eq(
    (await call('/api/comments')).body.comments.length,
    4,
    'после отклонённых clear-all комментарии на месте'
  );

  // ------------------------------------- invariant 3: survives a restart
  console.log('\nинвариант 3: переживают перезапуск сервера');
  const storeFile = path.join(repo, '.local-review', 'comments.json');
  ok(fs.existsSync(storeFile), '.local-review/comments.json существует на диске');
  const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  eq(onDisk.comments.length, 4, 'в файле хранилища 4 комментария');

  await new Promise((resolve) => server.server.close(resolve));
  server = await start({
    cwd: repo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  call = makeClient(server.port);
  const afterRestart = (await call('/api/comments')).body.comments;
  eq(afterRestart.length, 4, 'после рестарта сервера комментариев по-прежнему 4');
  eq(
    afterRestart.map((c) => c.id).sort(),
    after.map((c) => c.id).sort(),
    'после рестарта те же id'
  );

  // -------------------------------------------------------- .gitignore
  console.log('\nпрочее');
  const gitignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  ok(gitignore.split(/\r?\n/).includes('.local-review/'), '.gitignore содержит .local-review/',
    JSON.stringify(gitignore));
  const gitignoreLinesBefore = gitignore.split(/\r?\n/).length;
  const restart2 = await start({
    cwd: repo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  await new Promise((resolve) => restart2.server.close(resolve));
  eq(
    fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split(/\r?\n/).length,
    gitignoreLinesBefore,
    '.gitignore не дублируется при повторном запуске'
  );

  // repo stays untouched by the tool (read-only invariant 5)
  const status = git(['status', '--porcelain'], repo);
  ok(
    !status.split('\n').some((l) => l.includes('.local-review')),
    'хранилище не попадает в git status',
    status
  );

  // modes
  const staged = await call('/api/state?mode=staged');
  ok(staged.status === 200, 'режим staged отвечает 200');
  git(['add', 'src/app.js'], repo);
  const stagedAfterAdd = await call('/api/state?mode=staged');
  ok(
    stagedAfterAdd.body.files.some((f) => f.path === 'src/app.js'),
    'staged показывает добавленный в индекс файл',
    JSON.stringify(stagedAfterAdd.body.files.map((f) => f.path))
  );
  const baseMode = await call('/api/state?mode=base&base=HEAD~1');
  ok(baseMode.status === 200 && baseMode.body.files.length > 0, 'режим base работает');
  const badBase = await call('/api/state?mode=base&base=не-существует');
  ok(badBase.status === 400, 'несуществующая база -> 400 с текстом, а не 500',
    JSON.stringify(badBase.body));

  // port already taken -> next free one
  const a = await start({ cwd: repo, mode: 'working', base: 'origin/main', port: 45311, host: '127.0.0.1', open: false });
  const b = await start({ cwd: repo, mode: 'working', base: 'origin/main', port: 45311, host: '127.0.0.1', open: false });
  ok(a.port === 45311 && b.port === 45312, 'занятый порт -> берётся следующий свободный',
    `${a.port} / ${b.port}`);
  await new Promise((r) => a.server.close(r));
  await new Promise((r) => b.server.close(r));

  // not a git repo -> readable error
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-notgit-'));
  let notRepoError = null;
  try {
    await start({ cwd: notRepo, mode: 'working', base: 'origin/main', port: 0, host: '127.0.0.1', open: false });
  } catch (e) {
    notRepoError = e;
  }
  ok(
    notRepoError && notRepoError.userFacing && /не git-репозиторий/i.test(notRepoError.message),
    'запуск вне git-репозитория -> внятная ошибка'
  );

  // empty diff -> empty file list, no crash
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-clean-'));
  git(['init', '-q', '-b', 'main'], clean);
  git(['config', 'user.email', 'smoke@example.com'], clean);
  git(['config', 'user.name', 'Smoke Test'], clean);
  write(clean, 'a.txt', 'a\n');
  write(clean, '.gitignore', '.local-review/\n');
  git(['add', '-A'], clean);
  git(['commit', '-q', '-m', 'init'], clean);
  const cleanServer = await start({ cwd: clean, mode: 'working', base: 'origin/main', port: 0, host: '127.0.0.1', open: false });
  const cleanCall = makeClient(cleanServer.port);
  const cleanState = await cleanCall('/api/state');
  eq(cleanState.body.files.length, 0, 'чистый репозиторий -> пустой список файлов');
  await new Promise((r) => cleanServer.server.close(r));

  // ----------------------------------- clear-all with confirm actually clears
  console.log('\nclear-all с подтверждением');
  const cleared = await call('/api/comments/clear-all', json('POST', { confirm: true }));
  ok(cleared.status === 200 && cleared.body.removed === 4, 'clear-all удалил 4 комментария',
    JSON.stringify(cleared.body));
  eq((await call('/api/comments')).body.comments.length, 0, 'в API пусто');
  eq(
    JSON.parse(fs.readFileSync(storeFile, 'utf8')).comments.length,
    0,
    'в файле хранилища тоже пусто'
  );

  await new Promise((resolve) => server.server.close(resolve));

  console.log(`\n${checks - failures}/${checks} проверок прошло`);
  if (failures) {
    console.error(`\n${failures} проверок упало. Временный репозиторий оставлен: ${repo}\n`);
    process.exit(1);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });
  fs.rmSync(notRepo, { recursive: true, force: true });
  console.log('\nвсе проверки зелёные\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nСмоук упал с исключением:\n', err);
  process.exit(1);
});
