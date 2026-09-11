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

/** Worktree status minus everything the tool is allowed to touch. */
function gitStatusOfProject(root) {
  return git(['status', '--porcelain'], root)
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/\.local-review|review-\d{4}-\d{2}-\d{2}-\d{4}\.md|\.gitignore/.test(l));
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

const FIXTURE_GH = path.join(__dirname, 'smoke-fixtures', 'gh-fixture.js');

/** Points lib/gh.js at the fixture script and installs a manifest. */
function ghFixtures(manifest, dir) {
  const file = path.join(dir, `gh-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  process.env.LOCAL_REVIEW_GH_BIN = FIXTURE_GH;
  process.env.LOCAL_REVIEW_GH_FIXTURES = file;
  return file;
}

/** Simulates "gh is not installed" with a real ENOENT. */
function noGh() {
  process.env.LOCAL_REVIEW_GH_BIN = path.join(os.tmpdir(), 'definitely-no-gh-here-12345');
  delete process.env.LOCAL_REVIEW_GH_FIXTURES;
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
  // Never touch the real ~/.local-review: the whole home config goes to a
  // throwaway directory for the duration of the test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-home-'));
  process.env.LOCAL_REVIEW_HOME = home;

  // Points every `start()` call in this suite at a throwaway static dir
  // instead of the real dist/ (which may not be built in this checkout).
  // Also doubles as the assertion fixture for the "GET / serves the
  // configured static dir" check right after the first server starts.
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-static-'));
  const staticIndexHtml = '<!doctype html><title>smoke ui</title><body>smoke-static-marker</body>\n';
  fs.writeFileSync(path.join(staticDir, 'index.html'), staticIndexHtml, 'utf8');
  process.env.LOCAL_REVIEW_STATIC_DIR = staticDir;

  const repo = buildRepo();
  console.log(`\ntemp repo: ${repo}`);
  console.log(`temp home: ${home}\n`);

  // Snapshot of git state before the tool touches anything (invariant 6).
  const headBefore = git(['rev-parse', 'HEAD'], repo).trim();
  const reflogBefore = git(['reflog', '--format=%H'], repo).split('\n').length;
  let statusBefore = gitStatusOfProject(repo);

  let server = await start({
    cwd: repo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  let call = makeClient(server.port);

  // ------------------------------------------------------------- static UI
  console.log('статика UI (LOCAL_REVIEW_STATIC_DIR)');
  const indexRes = await fetch(`http://127.0.0.1:${server.port}/`);
  const indexBody = await indexRes.text();
  ok(indexRes.status === 200, 'GET / -> 200', String(indexRes.status));
  ok(
    (indexRes.headers.get('content-type') || '').includes('text/html'),
    'GET / -> text/html',
    indexRes.headers.get('content-type')
  );
  eq(indexBody, staticIndexHtml, 'GET / отдаёт index.html из LOCAL_REVIEW_STATIC_DIR');

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

  // ------------------------------------------------- oldText / newText (working)
  console.log('\noldText / newText (working)');
  const appTextDiff = await call('/api/diff?file=' + encodeURIComponent('src/app.js'));
  eq(
    appTextDiff.body.oldText,
    git(['show', 'HEAD:src/app.js'], repo),
    'модифицированный файл: oldText = git show HEAD:path'
  );
  eq(
    appTextDiff.body.newText,
    fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'),
    'модифицированный файл: newText = содержимое на диске'
  );

  ok(deleted.body.newText === null, 'удалённый файл: newText = null');
  eq(
    deleted.body.oldText,
    git(['show', 'HEAD:src/to-delete.js'], repo),
    'удалённый файл: oldText = git show HEAD:path'
  );

  const renamedTextDiff = await call('/api/diff?file=' + encodeURIComponent('src/renamed.js'));
  eq(
    renamedTextDiff.body.oldText,
    git(['show', 'HEAD:src/to-rename.js'], repo),
    'переименованный файл: oldText берётся по старому пути'
  );
  eq(
    renamedTextDiff.body.newText,
    fs.readFileSync(path.join(repo, 'src/renamed.js'), 'utf8'),
    'переименованный файл: newText = содержимое на диске'
  );

  ok(
    binary.body.oldText === null && binary.body.newText === null,
    'бинарный файл: oldText и newText оба null',
    JSON.stringify(binary.body)
  );

  ok(untracked.body.oldText === null, 'untracked-файл: oldText = null');
  eq(
    untracked.body.newText,
    fs.readFileSync(path.join(repo, 'brand new.txt'), 'utf8'),
    'untracked-файл: newText = содержимое на диске'
  );

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
  // findRepoRoot normalises to forward slashes (lib/git.js:63), so compare
  // both sides through path.resolve rather than as raw strings.
  const samePath = (a, b) => path.resolve(a) === path.resolve(b);
  ok(
    samePath(path.dirname(file1.body.path), repo) && samePath(file1.body.dir, repo),
    'в локальном режиме .md пишется в корень репозитория',
    `${file1.body.dir} vs ${repo}`
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
  // The test itself just staged a file; re-baseline so invariant 6 measures
  // what the tool did, not what the test did.
  statusBefore = gitStatusOfProject(repo);
  const stagedAfterAdd = await call('/api/state?mode=staged');
  ok(
    stagedAfterAdd.body.files.some((f) => f.path === 'src/app.js'),
    'staged показывает добавленный в индекс файл',
    JSON.stringify(stagedAfterAdd.body.files.map((f) => f.path))
  );
  const stagedAppText = await call('/api/diff?file=' + encodeURIComponent('src/app.js') + '&mode=staged');
  eq(
    stagedAppText.body.oldText,
    git(['show', 'HEAD:src/app.js'], repo),
    'staged: oldText = git show HEAD:path'
  );
  eq(
    stagedAppText.body.newText,
    git(['show', ':src/app.js'], repo),
    'staged: newText = git show :path (индекс)'
  );

  const baseMode = await call('/api/state?mode=base&base=HEAD~1');
  ok(baseMode.status === 200 && baseMode.body.files.length > 0, 'режим base работает');

  const baseAppText = await call(
    '/api/diff?file=' + encodeURIComponent('src/app.js') + '&mode=base&base=HEAD~1'
  );
  eq(
    baseAppText.body.oldText,
    git(['show', 'HEAD~1:src/app.js'], repo),
    'base: oldText = git show <merge-base>:path'
  );
  eq(
    baseAppText.body.newText,
    fs.readFileSync(path.join(repo, 'src/app.js'), 'utf8'),
    'base: newText = содержимое на диске'
  );

  const badBase = await call('/api/state?mode=base&base=не-существует');
  ok(badBase.status === 400, 'несуществующая база -> 400 с текстом, а не 500',
    JSON.stringify(badBase.body));

  // ---------------------------------------------------- дескриптор в query
  console.log('\nдескриптор источника');
  const byDescriptor = await call(
    `/api/state?source=local&root=${encodeURIComponent(repo)}&mode=working`
  );
  ok(byDescriptor.status === 200, 'явный локальный дескриптор -> 200');
  eq(
    byDescriptor.body.files.map((f) => f.path).sort(),
    (await call('/api/state')).body.files.map((f) => f.path).sort(),
    'явный дескриптор и дефолтный дают один и тот же список файлов'
  );
  const noRoot = await call('/api/state?source=local');
  ok(noRoot.status === 400, 'source=local без root -> 400');
  const badSource = await call('/api/state?source=svn');
  ok(badSource.status === 400, 'неизвестный source -> 400, а не 500');

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
    await start({ cwd: notRepo, cwdExplicit: true, mode: 'working', base: 'origin/main', port: 0, host: '127.0.0.1', open: false });
  } catch (e) {
    notRepoError = e;
  }
  ok(
    notRepoError && notRepoError.userFacing && /не git-репозиторий/i.test(notRepoError.message),
    'запуск вне git-репозитория -> внятная ошибка'
  );

  // ... but launching *without* --cwd anywhere must open the folder picker
  // instead of refusing to start (acceptance criterion 4).
  const pickerServer = await start({
    cwd: notRepo,
    mode: 'working',
    base: 'origin/main',
    port: 0,
    host: '127.0.0.1',
    open: false,
  });
  const pickerCall = makeClient(pickerServer.port);
  ok(pickerServer.repoRoot === null, 'запуск без --cwd вне репозитория поднимает сервер');
  const pickerBrowse = await pickerCall('/api/browse?path=' + encodeURIComponent(notRepo));
  ok(pickerBrowse.status === 200, 'вне репозитория обзор каталогов работает');
  const pickerState = await pickerCall('/api/state');
  ok(
    pickerState.status === 400 && /источник|папк/i.test(pickerState.body.error),
    'вне репозитория запрос без дескриптора -> читаемое 400',
    JSON.stringify(pickerState.body)
  );
  const pickerWithDescriptor = await pickerCall(
    '/api/state?source=local&root=' + encodeURIComponent(repo)
  );
  ok(
    pickerWithDescriptor.status === 200 && pickerWithDescriptor.body.files.length > 0,
    'выбранная в UI папка открывается без перезапуска сервера'
  );
  await new Promise((r) => pickerServer.server.close(r));

  // ------------------------------------- инвариант 8: обзор каталогов
  console.log('\nинвариант 8: обзор каталогов не отдаёт файлы и не лезет вверх');
  const browseRepo = await call('/api/browse?path=' + encodeURIComponent(repo));
  ok(browseRepo.status === 200, 'GET /api/browse -> 200');
  const browseNames = browseRepo.body.entries.map((e) => e.name);
  ok(browseNames.includes('src'), 'подкаталог src в выдаче', browseNames.join(', '));
  ok(
    !browseNames.includes('crlf.txt') && !browseNames.includes('big.txt'),
    'файлы в выдачу не попадают',
    browseNames.join(', ')
  );
  ok(
    !JSON.stringify(browseRepo.body).includes('line 1') &&
      !JSON.stringify(browseRepo.body).includes('alpha'),
    'в ответе нет содержимого файлов'
  );
  eq(
    browseRepo.body.path,
    path.resolve(repo),
    'browse отдаёт ровно запрошенный каталог, а не родительский'
  );
  const browseSrc = await call('/api/browse?path=' + encodeURIComponent(path.join(repo, 'src')));
  eq(browseSrc.body.entries.length, 0, 'в src нет подкаталогов -> пустой список');
  const browseMissing = await call(
    '/api/browse?path=' + encodeURIComponent(path.join(repo, 'нет-такого'))
  );
  ok(browseMissing.status === 404, 'несуществующий каталог -> 404 с текстом');

  const vRoot = await call('/api/local/validate?root=' + encodeURIComponent(repo));
  ok(
    vRoot.body.ok === true && vRoot.body.sameAsRequested === true,
    'корень репозитория валиден и совпадает с запрошенным',
    JSON.stringify(vRoot.body)
  );
  const vSub = await call('/api/local/validate?root=' + encodeURIComponent(path.join(repo, 'src')));
  ok(
    vSub.body.ok === true && vSub.body.sameAsRequested === false,
    'подкаталог -> ok, но sameAsRequested:false',
    JSON.stringify(vSub.body)
  );
  const vNot = await call('/api/local/validate?root=' + encodeURIComponent(notRepo));
  ok(
    vNot.body.ok === false && /не git-репозиторий/i.test(vNot.body.error),
    'не-git каталог -> ok:false с читаемым текстом',
    JSON.stringify(vNot.body)
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

  // ------------------------------------------------------------ сессия
  console.log('\nсессия и .gitignore по подтверждению');
  const sess0 = await call('/api/session');
  ok(
    sess0.status === 200 && sess0.body.homeDir === home,
    'GET /api/session отдаёт домашний конфиг',
    JSON.stringify(sess0.body)
  );

  const gitignoreBeforeBrowse = fs.readFileSync(path.join(clean, '.gitignore'), 'utf8');
  await call('/api/browse?path=' + encodeURIComponent(clean));
  eq(
    fs.readFileSync(path.join(clean, '.gitignore'), 'utf8'),
    gitignoreBeforeBrowse,
    'обзор каталога НЕ пишет в .gitignore'
  );

  const noGitignoreRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-pick-'));
  git(['init', '-q', '-b', 'main'], noGitignoreRepo);
  const picked = await call(
    '/api/session',
    json('POST', {
      descriptor: { source: 'local', root: noGitignoreRepo, mode: 'working', base: 'origin/main' },
    })
  );
  ok(
    picked.status === 200 && picked.body.gitignore.changed === true,
    'подтверждение выбора папки пишет .local-review/ в .gitignore',
    JSON.stringify(picked.body)
  );
  ok(
    fs.readFileSync(path.join(noGitignoreRepo, '.gitignore'), 'utf8').includes('.local-review/'),
    'строка действительно в файле'
  );
  eq(
    (await call('/api/session')).body.recent[0].root,
    noGitignoreRepo,
    'выбранная папка попала в недавние'
  );

  // ------------------------------------------- Origin / Sec-Fetch-Site
  console.log('\nпроверка происхождения запроса');
  const crossSite = await call('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
  ok(crossSite.status === 403, 'Sec-Fetch-Site: cross-site -> 403', JSON.stringify(crossSite.body));
  const evilOrigin = await call('/api/state', { headers: { origin: 'http://evil.example' } });
  ok(evilOrigin.status === 403, 'чужой Origin -> 403', JSON.stringify(evilOrigin.body));
  const sameOrigin = await call('/api/state', {
    headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${server.port}` },
  });
  ok(sameOrigin.status === 200, 'свой Origin + same-origin -> 200');
  const noHeaders = await call('/api/state');
  ok(noHeaders.status === 200, 'запрос без Origin и Sec-Fetch-Site пропускается');

  // ------------------------------------------------------------ фикстура gh
  console.log('\nфикстура gh');
  const manifestFile = ghFixtures({ 'auth status': { code: 0, stdout: 'ok\n' } }, home);
  const probe = spawnSync(process.execPath, [FIXTURE_GH, 'auth', 'status'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LOCAL_REVIEW_GH_FIXTURES: manifestFile }),
  });
  ok(
    probe.status === 0 && probe.stdout.trim() === 'ok',
    'подставной gh отвечает по манифесту',
    JSON.stringify(probe.stdout)
  );
  const missProbe = spawnSync(process.execPath, [FIXTURE_GH, 'nope'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { LOCAL_REVIEW_GH_FIXTURES: manifestFile }),
  });
  ok(missProbe.status === 98, 'незаписанный сценарий -> явная ошибка фикстуры, а не тишина');

  // ------------------------------------- инвариант 9: читаемые ошибки gh
  console.log('\ngh: статус и классификация ошибок');
  ghFixtures(
    {
      'auth status': {
        code: 0,
        stdout: 'github.com\n  Logged in to github.com account octocat (keyring)\n',
      },
    },
    home
  );
  const st1 = await call('/api/gh/status');
  ok(
    st1.status === 200 && st1.body.installed === true && st1.body.authenticated === true,
    'gh залогинен -> installed:true, authenticated:true',
    JSON.stringify(st1.body)
  );
  eq(st1.body.login, 'octocat', 'логин вытащен из вывода gh auth status');

  ghFixtures(
    {
      'auth status': {
        code: 1,
        stderr: 'You are not logged into any GitHub hosts. Run gh auth login\n',
      },
    },
    home
  );
  const st2 = await call('/api/gh/status');
  ok(
    st2.status === 200 && st2.body.authenticated === false && /не залогинен/i.test(st2.body.message),
    'нет логина -> читаемое сообщение',
    JSON.stringify(st2.body)
  );

  noGh();
  const st3 = await call('/api/gh/status');
  ok(
    st3.status === 200 && st3.body.installed === false && /не установлен/i.test(st3.body.message),
    'gh не установлен -> читаемое сообщение, а не ENOENT-стек',
    JSON.stringify(st3.body)
  );
  ok(!/\n\s+at\s/.test(JSON.stringify(st3.body)), 'в ответе нет stack trace');

  const { classifyGhError } = require('./lib/gh');
  eq(
    classifyGhError({ code: 1, stderr: Buffer.from('API rate limit exceeded for user') }, [])
      .ghReason,
    'rate-limit',
    'rate limit классифицируется'
  );
  eq(
    classifyGhError(
      { code: 1, stderr: Buffer.from('dial tcp: lookup api.github.com: no such host') },
      []
    ).ghReason,
    'network',
    'сетевая ошибка классифицируется'
  );

  // ------------------------------------------------------------ поиск PR-ов
  console.log('\nпоиск PR-ов');
  const listKey =
    'pr list --repo o/r --limit 30 --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft --state open';
  const searchKey =
    'search prs --author=@me --limit 30 --json number,title,repository,author,state,updatedAt,url,isDraft --state=open';
  ghFixtures(
    {
      [listKey]: {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 25,
            title: 'Правка кириллицей',
            author: { login: 'octocat' },
            headRefName: 'feat/пробел и слеш',
            baseRefName: 'main',
            state: 'OPEN',
            isDraft: false,
            updatedAt: '2026-09-01T10:00:00Z',
            url: 'https://github.com/o/r/pull/25',
          },
        ]),
      },
      [searchKey]: { code: 0, stdout: '[]' },
    },
    home
  );

  const found = await call('/api/pr/search?repo=o/r&state=open');
  ok(
    found.status === 200 && found.body.items.length === 1,
    'поиск по репозиторию отдаёт PR',
    JSON.stringify(found.body)
  );
  eq(
    found.body.items[0].headRefName,
    'feat/пробел и слеш',
    'ветка с пробелом и кириллицей доезжает целиком'
  );
  eq(found.body.mode, 'repo', 'режим поиска — repo');

  const globalSearch = await call('/api/pr/search?state=open');
  eq(
    globalSearch.body.items.length,
    0,
    'пустой результат глобального поиска -> пустой список, не ошибка'
  );
  eq(globalSearch.body.mode, 'global', 'режим поиска — global');

  const badRepo = await call('/api/pr/search?repo=просто-строка');
  ok(
    badRepo.status === 400 && /owner\/repo/.test(badRepo.body.error),
    'некорректный репозиторий -> 400 с подсказкой',
    JSON.stringify(badRepo.body)
  );

  // -------------------------------------------------------- метаданные PR-а
  console.log('\nметаданные PR-а');
  const viewKey =
    'pr view 25 --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url';
  ghFixtures(
    {
      [viewKey]: {
        code: 0,
        stdout: JSON.stringify({
          number: 25,
          title: 'Заголовок PR-а',
          author: { login: 'octocat' },
          state: 'OPEN',
          isDraft: false,
          headRefName: 'feat/x',
          baseRefName: 'main',
          headRefOid: 'abc123',
          url: 'https://github.com/o/r/pull/25',
        }),
      },
      'pr view 999 --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url':
        {
          code: 1,
          stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 999.\n',
        },
    },
    home
  );

  const meta = await call('/api/pr/resolve?source=pr&host=github.com&owner=o&repo=r&number=25');
  ok(
    meta.status === 200 && meta.body.headRefName === 'feat/x' && meta.body.headSha === 'abc123',
    'метаданные PR-а разрешаются',
    JSON.stringify(meta.body)
  );
  const gone = await call('/api/pr/resolve?source=pr&host=github.com&owner=o&repo=r&number=999');
  ok(
    gone.status === 404 && /не найден/i.test(gone.body.error),
    'несуществующий PR -> 404 с читаемым текстом',
    JSON.stringify(gone.body)
  );
  const notPr = await call('/api/pr/resolve?source=local&root=' + encodeURIComponent(repo));
  ok(notPr.status === 400, 'локальный дескриптор в /api/pr/resolve -> 400');

  // ------------------------------------------------------- PR: дифф из gh
  console.log('\nPR: дифф из gh');
  const PR_DIFF = [
    'diff --git a/src/app.js b/src/app.js',
    'index 1111111..2222222 100644',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '@@ -10,3 +10,4 @@ function x() {',
    ' context 10',
    '+добавленная строка',
    ' context 11',
    ' context 12',
    'diff --git a/old name.txt b/новое имя.txt',
    'similarity index 90%',
    'rename from old name.txt',
    'rename to новое имя.txt',
    'diff --git a/assets/logo.bin b/assets/logo.bin',
    'index 3333333..4444444 100644',
    'Binary files a/assets/logo.bin and b/assets/logo.bin differ',
    'diff --git a/created.txt b/created.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/created.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-was here',
    '',
  ].join('\r\n');

  const prView = (n) => ({
    code: 0,
    stdout: JSON.stringify({
      number: n,
      title: 'Заголовок PR-а',
      author: { login: 'octocat' },
      state: 'OPEN',
      isDraft: false,
      headRefName: 'feat/x',
      baseRefName: 'main',
      headRefOid: 'abc123',
      url: `https://github.com/o/r/pull/${n}`,
    }),
  });
  const viewKeyFor = (n) =>
    `pr view ${n} --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url`;

  // gh's path segments are percent-encoded one segment at a time (spaces and
  // Cyrillic survive git paths, not raw URLs) — mirrors lib/sources/pr-source.js.
  function encodePathSegments(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }
  function ghContentsKey(p, ref) {
    return `api -H Accept: application/vnd.github.raw+json repos/o/r/contents/${encodePathSegments(p)}?ref=${ref}`;
  }

  ghFixtures(
    {
      [viewKeyFor(25)]: prView(25),
      [viewKeyFor(26)]: prView(26),
      [viewKeyFor(27)]: prView(27),
      'pr diff 25 --repo o/r': { code: 0, stdout: PR_DIFF },
      'pr diff 26 --repo o/r': { code: 0, stdout: '' },
      'pr diff 27 --repo o/r': {
        code: 1,
        stderr: 'HTTP 406: Sorry, this diff is taking too long to generate.\n',
      },
      // oldText/newText plumbing (§2 of the design doc) kicks in for every
      // /api/diff in PR mode from here on, so PR #25's file-text fetches need
      // fixtures too, not just its `pr diff`.
      'pr view 25 --repo o/r --json baseRefOid,headRefOid': {
        code: 0,
        stdout: JSON.stringify({ baseRefOid: 'earlyBaseSha', headRefOid: 'abc123' }),
      },
      'api repos/o/r/compare/earlyBaseSha...abc123': {
        code: 0,
        stdout: JSON.stringify({ merge_base_commit: { sha: 'earlyMergeBaseSha' } }),
      },
      [ghContentsKey('src/app.js', 'earlyMergeBaseSha')]: { code: 0, stdout: 'early old app content\n' },
      [ghContentsKey('src/app.js', 'abc123')]: { code: 0, stdout: 'early new app content\n' },
    },
    home
  );

  const prQuery = 'source=pr&host=github.com&owner=o&repo=r&number=25&fresh=1';
  const prState = await call(`/api/state?${prQuery}`);
  ok(
    prState.status === 200,
    'PR-дескриптор -> /api/state 200',
    JSON.stringify(prState.body).slice(0, 300)
  );
  const prPaths = prState.body.files.map((f) => f.path).sort();
  eq(
    prPaths,
    ['assets/logo.bin', 'created.txt', 'gone.txt', 'новое имя.txt', 'src/app.js'].sort(),
    'все пять файлов PR-а разобраны, включая кириллицу с пробелом'
  );
  eq(
    prState.body.files.find((f) => f.path === 'новое имя.txt').kind,
    'R',
    'переименование помечено R'
  );
  eq(
    prState.body.files.find((f) => f.path === 'новое имя.txt').oldPath,
    'old name.txt',
    'у переименования сохранён oldPath'
  );
  eq(prState.body.files.find((f) => f.path === 'created.txt').kind, 'A', 'новый файл помечен A');
  eq(prState.body.files.find((f) => f.path === 'gone.txt').kind, 'D', 'удалённый файл помечен D');
  eq(prState.body.pr.title, 'Заголовок PR-а', 'шапка PR-а приехала в /api/state');
  eq(prState.body.repoRoot, null, 'у PR-а нет локального корня');

  const prBin = await call(`/api/diff?file=${encodeURIComponent('assets/logo.bin')}&${prQuery}`);
  ok(prBin.body.binary === true, 'бинарный файл PR-а помечен binary', JSON.stringify(prBin.body));
  ok(
    prBin.body.oldText === null && prBin.body.newText === null,
    'бинарный файл PR-а: oldText/newText оба null',
    JSON.stringify(prBin.body)
  );

  const prApp = await call(`/api/diff?file=${encodeURIComponent('src/app.js')}&${prQuery}`);
  eq(prApp.body.oldText, 'early old app content\n', 'PR: oldText файла берётся не из baseRefOid, а из merge-base');
  eq(prApp.body.newText, 'early new app content\n', 'PR: newText файла берётся с head');
  const prAdded = prApp.body.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add');
  eq(prAdded.length, 1, 'в диффе PR-а одна добавленная строка');
  eq(
    prAdded[0].newLine,
    11,
    'номер строки из PR-диффа = 11 (@@ -10,3 +10,4 @@, после одного контекста)'
  );
  ok(!prAdded[0].text.includes('\r'), 'CRLF из ответа gh не попадает в текст строки');

  const prEmpty = await call(
    '/api/state?source=pr&host=github.com&owner=o&repo=r&number=26&fresh=1'
  );
  eq(prEmpty.body.files.length, 0, 'PR без изменённых файлов -> пустой список, не падение');

  const prRefused = await call(
    '/api/state?source=pr&host=github.com&owner=o&repo=r&number=27&fresh=1'
  );
  // 502 on purpose: GitHub refused, the tool did not break. What the invariant
  // demands is a sentence a human can read, never a stack trace.
  ok(
    prRefused.status >= 400 &&
      typeof prRefused.body.error === 'string' &&
      prRefused.body.error.length > 0 &&
      !/\n\s+at\s/.test(prRefused.body.error) &&
      !/ at .*\.js:\d+/.test(prRefused.body.error),
    'GitHub не отдал дифф -> читаемое сообщение без стека',
    JSON.stringify(prRefused.body)
  );

  // -------------------------------------------- PR: тексты файлов и их кэш
  console.log('\nPR: oldText/newText с merge-base/head и кэш содержимого');
  const PR_BASE_SHA = 'textsBaseSha';
  const PR_HEAD_SHA = 'textsHeadSha';
  const PR_MERGE_BASE_SHA = 'textsMergeBaseSha'; // deliberately != PR_BASE_SHA

  ghFixtures(
    {
      [viewKeyFor(25)]: prView(25),
      'pr diff 25 --repo o/r': { code: 0, stdout: PR_DIFF },
      'pr view 25 --repo o/r --json baseRefOid,headRefOid': {
        code: 0,
        stdout: JSON.stringify({ baseRefOid: PR_BASE_SHA, headRefOid: PR_HEAD_SHA }),
      },
      [`api repos/o/r/compare/${PR_BASE_SHA}...${PR_HEAD_SHA}`]: {
        code: 0,
        stdout: JSON.stringify({ merge_base_commit: { sha: PR_MERGE_BASE_SHA } }),
      },
      [ghContentsKey('src/app.js', PR_MERGE_BASE_SHA)]: { code: 0, stdout: 'merge-base app content\n' },
      [ghContentsKey('src/app.js', PR_HEAD_SHA)]: { code: 0, stdout: 'head app content\n' },
      [ghContentsKey('created.txt', PR_MERGE_BASE_SHA)]: { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
      [ghContentsKey('created.txt', PR_HEAD_SHA)]: { code: 0, stdout: 'head created content\n' },
      [ghContentsKey('gone.txt', PR_MERGE_BASE_SHA)]: { code: 0, stdout: 'merge-base gone content\n' },
      [ghContentsKey('gone.txt', PR_HEAD_SHA)]: { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
      [ghContentsKey('old name.txt', PR_MERGE_BASE_SHA)]: { code: 0, stdout: 'merge-base old-name content\n' },
      [ghContentsKey('новое имя.txt', PR_HEAD_SHA)]: { code: 0, stdout: 'head new-name content\n' },
    },
    home
  );

  const prTextQ = 'source=pr&host=github.com&owner=o&repo=r&number=25';
  const callLog = path.join(home, 'gh-calls.log');
  fs.writeFileSync(callLog, '');
  process.env.LOCAL_REVIEW_GH_CALL_LOG = callLog;
  const logLines = () => fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);

  // fresh=1 forces the sha cache (loadShas) populated by the earlier PR
  // section to be recomputed against *this* section's fixtures.
  const prAppTexts = await call(`/api/diff?file=${encodeURIComponent('src/app.js')}&${prTextQ}&fresh=1`);
  eq(
    prAppTexts.body.oldText,
    'merge-base app content\n',
    'PR: oldText берётся с merge-base, а не с baseRefOid'
  );
  eq(prAppTexts.body.newText, 'head app content\n', 'PR: newText берётся с head');

  const prCreatedTexts = await call(`/api/diff?file=${encodeURIComponent('created.txt')}&${prTextQ}`);
  ok(prCreatedTexts.body.oldText === null, 'PR: добавленный файл — oldText null (нет на merge-base)');
  eq(prCreatedTexts.body.newText, 'head created content\n', 'PR: добавленный файл — newText с head');

  const prGoneTexts = await call(`/api/diff?file=${encodeURIComponent('gone.txt')}&${prTextQ}`);
  eq(prGoneTexts.body.oldText, 'merge-base gone content\n', 'PR: удалённый файл — oldText с merge-base');
  ok(prGoneTexts.body.newText === null, 'PR: удалённый файл — newText null (нет на head)');

  const prRenamedTexts = await call(`/api/diff?file=${encodeURIComponent('новое имя.txt')}&${prTextQ}`);
  eq(
    prRenamedTexts.body.oldText,
    'merge-base old-name content\n',
    'PR: переименование — oldText со старого пути на merge-base'
  );
  eq(prRenamedTexts.body.newText, 'head new-name content\n', 'PR: переименование — newText с head');

  const prBinTexts = await call(`/api/diff?file=${encodeURIComponent('assets/logo.bin')}&${prTextQ}`);
  ok(
    prBinTexts.body.oldText === null && prBinTexts.body.newText === null,
    'PR: бинарный файл — тексты null'
  );
  ok(
    !logLines().some((l) => l.includes('contents/assets/logo.bin')),
    'PR: бинарный файл — gh за содержимым не запрашивается вовсе'
  );

  const appContentCallsBefore = logLines().filter((l) => l.includes('contents/src/app.js')).length;
  eq(
    appContentCallsBefore,
    2,
    'PR: за первый показ src/app.js — по одному обращению к gh на старую и новую версию'
  );

  await call(`/api/diff?file=${encodeURIComponent('src/app.js')}&${prTextQ}`);
  const appContentCallsAfter = logLines().filter((l) => l.includes('contents/src/app.js')).length;
  eq(
    appContentCallsAfter,
    appContentCallsBefore,
    'PR: повторный /api/diff для того же файла не обращается к gh за содержимым снова'
  );

  delete process.env.LOCAL_REVIEW_GH_CALL_LOG;

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

  // =====================================================================
  //            проверка девяти инвариантов раздела 5 спека
  // =====================================================================

  const prQ = 'source=pr&host=github.com&owner=o&repo=r&number=25';
  const prStorePath = path.join(home, 'pr', 'github.com__o__r__25.json');

  ghFixtures(
    {
      [viewKeyFor(25)]: prView(25),
      'pr diff 25 --repo o/r': { code: 0, stdout: PR_DIFF },
    },
    home
  );

  // ---------------------------------------------- инвариант 5: изоляция
  console.log('\nинвариант 5: стораджи не пересекаются');
  await call(
    '/api/comments',
    json('POST', { file: 'src/app.js', startLine: 3, endLine: 3, text: 'ЛОКАЛЬНЫЙ-МАРКЕР' })
  );
  await call(
    `/api/comments?${prQ}`,
    json('POST', { file: 'src/app.js', startLine: 11, endLine: 11, text: 'PR-МАРКЕР' })
  );

  const localOnDisk = fs.readFileSync(path.join(repo, '.local-review', 'comments.json'), 'utf8');
  const prOnDisk = fs.readFileSync(prStorePath, 'utf8');

  ok(
    localOnDisk.includes('ЛОКАЛЬНЫЙ-МАРКЕР') && !localOnDisk.includes('PR-МАРКЕР'),
    'инвариант 5: в локальном файле нет комментариев PR-а'
  );
  ok(
    prOnDisk.includes('PR-МАРКЕР') && !prOnDisk.includes('ЛОКАЛЬНЫЙ-МАРКЕР'),
    'инвариант 5: в PR-файле нет локальных комментариев'
  );
  ok(
    !fs.existsSync(path.join(repo, 'pr')),
    'инвариант 5: PR-сторадж не создаётся внутри репозитория'
  );
  ok(
    (await call(`/api/comments?${prQ}`)).body.comments.every((c) => c.text !== 'ЛОКАЛЬНЫЙ-МАРКЕР'),
    'инвариант 5: API PR-дескриптора не отдаёт локальные комментарии'
  );
  ok(
    (await call('/api/comments')).body.comments.every((c) => c.text !== 'PR-МАРКЕР'),
    'инвариант 5: API локального дескриптора не отдаёт комментарии PR-а'
  );
  const prCount = (await call(`/api/state?${prQ}`)).body.totalComments;
  const localCount = (await call('/api/state')).body.totalComments;
  ok(
    prCount === 1 && localCount === 1,
    'инвариант 5: счётчики двух режимов считаются раздельно',
    `PR ${prCount} / локальный ${localCount}`
  );

  // -------------------------------- инвариант 1 (PR): экспорт не меняет
  console.log('\nинвариант 1 (PR): экспорт не меняет комментарии');
  const prBefore = (await call(`/api/comments?${prQ}`)).body.comments;
  await call(`/api/export/text?${prQ}`);
  const prFile1 = await call(`/api/export/file?${prQ}`, { method: 'POST' });
  await call(`/api/export/text?${prQ}`);
  await call(`/api/export/file?${prQ}`, { method: 'POST' });
  const prAfter = (await call(`/api/comments?${prQ}`)).body.comments;
  eq(
    prAfter.map((c) => c.id).sort(),
    prBefore.map((c) => c.id).sort(),
    'инвариант 1: после 4 экспортов в PR-режиме те же id'
  );
  eq(
    path.dirname(prFile1.body.path),
    path.join(home, 'exports'),
    'инвариант 1: .md PR-режима записан в <home>/exports'
  );
  // The local export earlier in this suite may share the same minute stamp, so
  // a name collision proves nothing — the destination path is what matters.
  ok(
    !path.resolve(prFile1.body.path).startsWith(path.resolve(repo)),
    'инвариант 1: .md PR-режима записан вне репозитория',
    prFile1.body.path
  );

  // ------------------------- инвариант 4 (PR): реальные номера строк
  const prMd = await call(`/api/export/text?${prQ}`);
  ok(
    prMd.body.includes('src/app.js:L11'),
    'инвариант 4: якорь в экспорте PR-режима — реальный номер строки файла',
    prMd.body
  );

  // ------------------- инвариант 2 (PR): массовое удаление с confirm
  console.log('\nинвариант 2 (PR): массовое удаление только с подтверждением');
  for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
    const res = await call(`/api/comments/clear-all?${prQ}`, json('POST', body));
    ok(
      res.status === 400,
      `инвариант 2 (PR): clear-all с ${JSON.stringify(body)} -> 400`,
      JSON.stringify(res.body)
    );
  }
  eq(
    (await call(`/api/comments?${prQ}`)).body.comments.length,
    1,
    'инвариант 2 (PR): после отклонённых clear-all комментарий на месте'
  );

  // ---------------- инвариант 3 (PR): переживают перезапуск сервера
  console.log('\nинвариант 3 (PR): комментарии переживают перезапуск');
  const prIdsBefore = (await call(`/api/comments?${prQ}`)).body.comments.map((c) => c.id);
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
  const prIdsAfter = (await call(`/api/comments?${prQ}`)).body.comments.map((c) => c.id);
  eq(prIdsAfter, prIdsBefore, 'инвариант 3 (PR): те же id после рестарта');
  eq(
    JSON.parse(fs.readFileSync(prStorePath, 'utf8')).comments.length,
    1,
    'инвариант 3 (PR): в файле хранилища тот же комментарий'
  );

  // ---------------------- инвариант 6: ничего не пишем в репозиторий
  console.log('\nинвариант 6: тула не пишет в репозиторий');
  eq(git(['rev-parse', 'HEAD'], repo).trim(), headBefore, 'инвариант 6: HEAD не двигался');
  eq(
    git(['reflog', '--format=%H'], repo).split('\n').length,
    reflogBefore,
    'инвариант 6: reflog не пополнился — ни одной пишущей git-команды'
  );
  // The fixture worktree is dirty on purpose, so compare against the snapshot
  // taken before the server started, not against an empty list.
  const statusNow = gitStatusOfProject(repo);
  eq(
    statusNow,
    statusBefore,
    'инвариант 6: тула не изменила ни одного файла проекта',
    `${statusBefore.join(' | ')}  ->  ${statusNow.join(' | ')}`
  );
  const gitSource = fs.readFileSync(path.join(__dirname, 'lib', 'git.js'), 'utf8');
  ok(
    !/'(add|commit|checkout|reset|clean|rm|mv|push|stash|apply|restore)'/.test(gitSource),
    'инвариант 6: в lib/git.js нет пишущих git-команд'
  );

  // --------------------------------- инвариант 7: ноль зависимостей у сервера
  // 2026-09-11 spec revision (docs/superpowers/specs/2026-09-11-react-primer-ui-design.md
  // §"Что меняется"): the *server* still ships with zero runtime dependencies,
  // but the React/Vite/CodeMirror/Primer front end now lives in devDependencies
  // (bundled into tools/local-review/dist/ at build time, never required by
  // any file under tools/local-review/lib/ or review.js). So devDependencies
  // is no longer required to be empty — only the three that would actually
  // ship as runtime deps of the published package are.
  console.log('\nинвариант 7: ноль npm-зависимостей у сервера');
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
  );
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    ok(
      !pkg[key] || Object.keys(pkg[key]).length === 0,
      `инвариант 7: ${key} пуст`,
      JSON.stringify(pkg[key])
    );
  }
  const sources = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory() && d.name !== 'node_modules') walk(abs);
      else if (d.isFile() && abs.endsWith('.js')) sources.push(abs);
    }
  })(__dirname);
  const badRequire = [];
  for (const file of sources) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (!id.startsWith('node:') && !id.startsWith('.') && !id.startsWith('/')) {
        badRequire.push(`${file}: ${id}`);
      }
    }
  }
  eq(badRequire, [], 'инвариант 7: ни одного require внешнего пакета', badRequire.join(' | '));
  const httpCalls = [];
  for (const file of sources.filter((f) => f.includes('lib'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (/api\.github\.com|require\(\s*'node:https'\s*\)|\bfetch\(/.test(text)) httpCalls.push(file);
  }
  eq(httpCalls, [], 'инвариант 7: доступ к GitHub только через gh, без прямого HTTP', httpCalls.join(' | '));

  // ---------------------------- инвариант 8: обзор каталогов (добор)
  console.log('\nинвариант 8: обзор каталогов (дополнительно)');
  const browseAgain = await call('/api/browse?path=' + encodeURIComponent(repo));
  ok(
    !('content' in browseAgain.body) && !browseAgain.body.entries.some((e) => 'content' in e),
    'инвариант 8: в выдаче нет поля с содержимым'
  );
  const climb = await call('/api/browse');
  ok(
    climb.body.path === null && Array.isArray(climb.body.entries),
    'инвариант 8: без path сервер отдаёт стартовый набор, а не сканирует корень диска',
    JSON.stringify(climb.body).slice(0, 200)
  );

  // ------------------------- инвариант 9: читаемые сообщения об отказах
  console.log('\nинвариант 9: отказы gh дают читаемое сообщение');
  const SEARCH_KEY =
    'pr list --repo o/r --limit 30 --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft --state open';
  const stderrFor = (text) => ({ [SEARCH_KEY]: { code: 1, stderr: text } });

  const ghCases = [
    {
      name: 'gh не установлен',
      status: [200],
      setup: noGh,
      url: '/api/gh/status',
      expect: /не установлен/i,
      viaStatus: true,
    },
    {
      name: 'нет логина',
      status: [401],
      fixture: {
        [SEARCH_KEY]: {
          code: 4,
          stderr: 'gh auth login required: You are not logged into any GitHub hosts\n',
        },
      },
      url: '/api/pr/search?repo=o/r',
      expect: /не залогинен/i,
    },
    {
      name: 'лимит API',
      status: [429],
      fixture: stderrFor('API rate limit exceeded for user ID 1\n'),
      url: '/api/pr/search?repo=o/r',
      expect: /лимит/i,
    },
    {
      name: 'нет сети',
      status: [502],
      fixture: stderrFor('dial tcp: lookup api.github.com: no such host\n'),
      url: '/api/pr/search?repo=o/r',
      expect: /связи с GitHub/i,
    },
    {
      name: '404',
      status: [404],
      fixture: stderrFor('HTTP 404: Not Found (https://api.github.com/repos/o/r)\n'),
      url: '/api/pr/search?repo=o/r',
      expect: /не найден/i,
    },
  ];

  for (const c of ghCases) {
    if (c.setup) c.setup();
    else ghFixtures(c.fixture, home);
    const res = await call(c.url);
    const text = JSON.stringify(res.body);
    // A gh refusal is an upstream problem, never a crash. 200 for the status
    // screen; 4xx when the caller can fix it (log in, wait the limit out, ask
    // for a repo that exists); 502 when GitHub itself did not answer.
    ok(
      c.status.includes(res.status),
      `инвариант 9 (${c.name}): ожидаемый статус, не поломка сервера`,
      `${res.status} ${text}`
    );
    ok(c.expect.test(text), `инвариант 9 (${c.name}): читаемое сообщение`, text);
    ok(
      !/\\n\s+at\s|Error:\s+\w+Error/.test(text),
      `инвариант 9 (${c.name}): без stack trace`,
      text
    );
  }

  await new Promise((resolve) => server.server.close(resolve));

  console.log(`\n${checks - failures}/${checks} проверок прошло`);
  if (failures) {
    console.error(`\n${failures} проверок упало. Временный репозиторий оставлен: ${repo}\n`);
    process.exit(1);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });
  fs.rmSync(notRepo, { recursive: true, force: true });
  fs.rmSync(noGitignoreRepo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(staticDir, { recursive: true, force: true });
  console.log('\nвсе проверки зелёные\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nСмоук упал с исключением:\n', err);
  process.exit(1);
});
