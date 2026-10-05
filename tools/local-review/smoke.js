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

const FIXTURE_FOLDER_DIALOG = path.join(__dirname, 'smoke-fixtures', 'folder-dialog-fixture.js');

/** What the fake folder dialog prints and exits with on its next run. */
function folderDialogResult(result) {
  process.env.LOCAL_REVIEW_FOLDER_DIALOG_RESULT = JSON.stringify(result);
}

function json(method, payload) {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

// ------------------------------------------------------------------- LSP

/** Sorted `[path, line, character]` of places, for comparisons that do not depend on directory order. */
function placesOf(list) {
  return (list || []).map((l) => [l.path === null ? `external:${path.basename(l.external)}` : l.path, l.line, l.character]).sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b) ? -1 : 1
  );
}

/** References, implementations and the call hierarchy against the fixture (src/calls.ts). */
async function lspNavigationChecks(lsp, lspRepo, lspRoutes, symlinked) {
  console.log('\nLSP: ссылки');
  // `helper` in `export const value = helper() + helper();` (a.ts, line 1).
  const refs = await lsp({ method: 'references', path: 'src/a.ts', line: 1, character: 22 });
  ok(refs.status === 200 && refs.body.ok, 'POST /api/lsp references -> ok', JSON.stringify(refs.body));
  eq(placesOf(refs.body.locations), [
    ['external:lib.d.ts', 0, 0],
    ['src/a.ts', 0, 9], ['src/a.ts', 1, 21], ['src/a.ts', 1, 32],
    ['src/b.ts', 0, 16],
    ['src/calls.ts', 0, 9], ['src/calls.ts', 2, 20], ['src/calls.ts', 5, 9],
  ], 'references: все вхождения helper по файлам репозитория и одно снаружи');
  const callsRef = (refs.body.locations || []).find((l) => l.path === 'src/calls.ts' && l.line === 2);
  eq(callsRef && callsRef.preview, { text: 'return middle() + helper();', start: 2 }, 'references: превью строки без отступа и где оно начинается');
  const ext = (refs.body.locations || []).find((l) => l.path === null);
  ok(ext && ext.external === path.join(path.dirname(lspRepo), 'lib.d.ts') && !('preview' in ext),
    'references: место вне репозитория помечено external и не читается', JSON.stringify(ext));
  // The shown version (staged, a commit) is what the server sees and what the preview quotes.
  const shown = "import { helper } from './b';\n\nexport const value = helper(); // shown\n";
  const shownRefs = await lsp({ method: 'references', path: 'src/a.ts', line: 2, character: 22, text: shown });
  const shownA = (shownRefs.body.locations || []).find((l) => l.path === 'src/a.ts' && l.line === 2);
  eq(shownA && shownA.preview && shownA.preview.text, 'export const value = helper(); // shown', 'references: превью из показанного текста, а не с диска');
  if (symlinked) {
    const secret = await lsp({ method: 'references', path: 'src/a.ts', line: 0, character: 0, text: 'secret\n' });
    const viaLink = (secret.body.locations || []).find((l) => l.path === 'src/link.ts');
    ok(viaLink && viaLink.preview === null, 'references: файл-симлинк наружу в превью не читается', JSON.stringify(secret.body));
  }
  // Back to the file on disk for the rest.
  await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 22 });

  console.log('\nLSP: реализации');
  const impl = await lsp({ method: 'implementation', path: 'src/calls.ts', line: 7, character: 19 });
  eq([impl.body.ok, placesOf(impl.body.locations)], [true, [['src/calls.ts', 8, 13]]], 'implementation: Shape -> class Square');
  const none = await lsp({ method: 'implementation', path: 'src/calls.ts', line: 1, character: 18 });
  eq([none.body.ok, none.body.locations], [true, []], 'implementation: ничего не найдено -> пустой список');

  console.log('\nLSP: иерархия вызовов');
  const prep = await lsp({ method: 'prepareCallHierarchy', path: 'src/b.ts', line: 0, character: 18 });
  const root = prep.body.items && prep.body.items[0];
  ok(prep.body.ok && prep.body.items.length === 1 && root.name === 'helper' && root.kind === 12 && root.path === 'src/b.ts' &&
    root.line === 0 && root.character === 16 && typeof root.token === 'string' && root.item && root.item.data.fixture === true,
    'prepareCallHierarchy: элемент helper с подписью и исходным item', JSON.stringify(prep.body));
  eq(root && root.preview, { text: 'export function helper() {', start: 0 }, 'prepareCallHierarchy: превью строки объявления');
  const notCallable = await lsp({ method: 'prepareCallHierarchy', path: 'src/calls.ts', line: 7, character: 19 });
  eq([notCallable.body.ok, notCallable.body.items], [true, []], 'prepareCallHierarchy: не функция -> пустой список');

  const incoming = await lsp({ method: 'incomingCalls', path: 'src/b.ts', item: root.item, token: root.token });
  ok(incoming.body.ok, 'incomingCalls -> ok', JSON.stringify(incoming.body));
  const callers = (incoming.body.calls || []).map((c) => [c.node.name, c.node.path, placesOf(c.sites)]).sort();
  eq(callers, [
    ['a.ts', 'src/a.ts', [['src/a.ts', 1, 21], ['src/a.ts', 1, 32]]],
    ['middle', 'src/calls.ts', [['src/calls.ts', 5, 9]]],
    ['top', 'src/calls.ts', [['src/calls.ts', 2, 20]]],
  ], 'incomingCalls: кто вызывает helper и места вызовов в файле вызывающего');
  const top = (incoming.body.calls || []).find((c) => c.node.name === 'top');
  eq(top && top.sites[0].preview, { text: 'return middle() + helper();', start: 2 }, 'incomingCalls: превью места вызова');

  const outgoing = await lsp({ method: 'outgoingCalls', path: 'src/b.ts', item: top.node.item, token: top.node.token });
  const callees = (outgoing.body.calls || []).map((c) => [c.node.name, c.node.path, placesOf(c.sites)]).sort();
  eq(callees, [
    ['helper', 'src/b.ts', [['src/calls.ts', 2, 20]]],
    ['middle', 'src/calls.ts', [['src/calls.ts', 2, 9]]],
  ], 'outgoingCalls: что вызывает top, места вызовов — в файле top');

  const forged = Object.assign({}, root.item, { uri: 'file:///etc/passwd' });
  eq((await lsp({ method: 'incomingCalls', path: 'src/b.ts', item: forged, token: root.token })).status, 403,
    'incomingCalls: подменённый item -> 403');
  eq((await lsp({ method: 'outgoingCalls', path: 'src/b.ts', item: root.item })).status, 403, 'outgoingCalls: item без подписи -> 403');
  eq((await lsp({ method: 'incomingCalls', path: 'src/b.ts' })).status, 400, 'incomingCalls без item -> 400');
  eq((await lsp({ method: 'references', path: 'src/a.ts', line: 'x', character: 0 })).status, 400, 'references без позиции -> 400');
  eq((await lsp({ method: 'toString', path: 'src/a.ts', line: 0, character: 0 })).status, 400, 'метод из прототипа объекта -> 400');

  console.log('\nLSP: метод не поддерживается сервером');
  await lspRoutes.getManager().stopAll();
  process.env.LOCAL_REVIEW_LSP_FIXTURE_DROP = 'callHierarchyProvider,implementationProvider';
  try {
    const noCalls = await lsp({ method: 'prepareCallHierarchy', path: 'src/b.ts', line: 0, character: 18 });
    ok(noCalls.body.ok === false && noCalls.body.reason === 'not-supported' && /не поддерживает иерархию вызовов/.test(noCalls.body.message),
      'нет callHierarchyProvider -> not-supported с понятным текстом', JSON.stringify(noCalls.body));
    const noImpl = await lsp({ method: 'implementation', path: 'src/calls.ts', line: 7, character: 19 });
    eq([noImpl.body.ok, noImpl.body.reason], [false, 'not-supported'], 'нет implementationProvider -> not-supported');
    const stillRefs = await lsp({ method: 'references', path: 'src/a.ts', line: 1, character: 22 });
    ok(stillRefs.body.ok, 'остальные методы работают', JSON.stringify(stillRefs.body));
  } finally {
    delete process.env.LOCAL_REVIEW_LSP_FIXTURE_DROP;
    await lspRoutes.getManager().stopAll();
  }
}

const FIXTURE_LSP = path.join(__dirname, 'smoke-fixtures', 'lsp-fixture.js');

/** A launcher for the fake server where the registry looks first: <repo>/node_modules/.bin. */
function installFakeLsp(repo, bin) {
  const dir = path.join(repo, 'node_modules', '.bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${bin}.cmd`), `@"${process.execPath}" "${FIXTURE_LSP}" %*\r\n`);
  } else {
    const file = path.join(dir, bin);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE_LSP}" "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns something truthy or `ms` runs out. */
async function waitFor(probe, ms) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > until) return value;
    await sleep(50);
  }
}

/**
 * The language-server layer: framing, the registry's lookup, the manager's
 * life cycle (start, sync, crash, idle stop) through the real HTTP routes,
 * and the path checks of /api/lsp and /api/file. The server is the fixture
 * above; a check against the real typescript-language-server is a manual
 * step (README, «IDE-режим»).
 */
async function lspChecks(call, home) {
  const { encode, MessageReader, Connection } = require('./lib/lsp/jsonrpc');
  const registry = require('./lib/lsp/registry');
  const lspRoutes = require('./lib/routes/lsp');

  console.log('\nLSP: framing Content-Length');
  {
    const got = [];
    const reader = new MessageReader((m) => got.push(m));
    const one = encode({ jsonrpc: '2.0', id: 1, result: 'привет, мир' });
    const two = encode({ jsonrpc: '2.0', method: 'x', params: { s: '日本' } });
    const all = Buffer.concat([one, two]);
    // Byte by byte: the header, the length and a multi-byte character all split.
    for (let i = 0; i < all.length; i += 1) reader.feed(all.subarray(i, i + 1));
    eq(got, [{ jsonrpc: '2.0', id: 1, result: 'привет, мир' }, { jsonrpc: '2.0', method: 'x', params: { s: '日本' } }],
      'MessageReader: сообщения, порезанные по байту, собираются целиком');
    ok(one.toString('ascii').startsWith(`Content-Length: ${Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'привет, мир' }))}\r\n\r\n`),
      'encode: Content-Length в байтах, не в символах');
    got.length = 0;
    reader.feed(all);
    eq(got.length, 2, 'MessageReader: два сообщения в одном куске');
    const errors = [];
    const tolerant = new MessageReader((m) => got.push(m), (e) => errors.push(e.message));
    got.length = 0;
    tolerant.feed(Buffer.concat([Buffer.from('Content-Length: 3\r\n\r\n{x}', 'ascii'), two]));
    ok(errors.length === 1 && got.length === 1, 'MessageReader: битый JSON пропущен, следующее сообщение прочитано', JSON.stringify({ errors, got }));
    got.length = 0;
    errors.length = 0;
    tolerant.feed(Buffer.concat([Buffer.from('launcher: starting\n', 'ascii'), two]));
    ok(errors.length === 0 && got.length === 1, 'MessageReader: строка мусора перед первым заголовком не теряет сообщение',
      JSON.stringify({ errors, got }));
  }

  console.log('\nLSP: Connection');
  {
    const written = [];
    const conn = new Connection(
      { write: (buf) => new MessageReader((m) => written.push(m)).feed(buf) },
      { onRequest: (method, params) => (method === 'workspace/configuration' ? params.items.map(() => null) : undefined) }
    );
    const answer = conn.request('textDocument/hover', { a: 1 });
    conn.feed(encode({ jsonrpc: '2.0', id: written[0].id, result: { contents: 'ok' } }));
    eq(await answer, { contents: 'ok' }, 'request: ответ сопоставлен по id');
    const failing = conn.request('x', null);
    conn.feed(encode({ jsonrpc: '2.0', id: written[written.length - 1].id, error: { code: -32602, message: 'плохие параметры' } }));
    const failure = await failing.catch((e) => e);
    ok(failure instanceof Error && failure.code === -32602, 'request: ошибка сервера -> reject с её кодом', String(failure && failure.code));
    const late = await conn.request('slow', null, { timeoutMs: 30 }).catch((e) => e);
    ok(late.code === 'ETIMEDOUT', 'request: таймаут -> ETIMEDOUT', String(late.code));
    ok(written.some((m) => m.method === '$/cancelRequest'), 'request: по таймауту серверу уходит $/cancelRequest');
    conn.feed(encode({ jsonrpc: '2.0', id: 77, method: 'workspace/configuration', params: { items: [{}, {}] } }));
    await sleep(0);
    eq(written.find((m) => m.id === 77), { jsonrpc: '2.0', id: 77, result: [null, null] }, 'запрос сервера к клиенту получает ответ');
    conn.feed(encode({ jsonrpc: '2.0', id: 78, method: 'unknown/thing' }));
    await sleep(0);
    eq((written.find((m) => m.id === 78) || {}).error && written.find((m) => m.id === 78).error.code, -32601,
      'неизвестный запрос сервера -> MethodNotFound');
    const pending = conn.request('never', null);
    conn.close(new Error('закрыто'));
    eq((await pending.catch((e) => e)).message, 'закрыто', 'close: ожидающие запросы отклоняются');
  }

  // A repository with two TypeScript files that import each other.
  const lspRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-'));
  git(['init', '-q', '-b', 'main'], lspRepo);
  git(['config', 'user.email', 'smoke@example.com'], lspRepo);
  git(['config', 'user.name', 'Smoke Test'], lspRepo);
  git(['config', 'commit.gpgsign', 'false'], lspRepo);
  write(lspRepo, 'src/b.ts', 'export function helper() {\n  return 1;\n}\n');
  write(lspRepo, 'src/a.ts', "import { helper } from './b';\nexport const value = helper();\n");
  write(lspRepo, 'src/calls.ts', [
    "import { helper } from './b';",
    'export function top() {',
    '  return middle() + helper();',
    '}',
    'export function middle() {',
    '  return helper();',
    '}',
    'export interface Shape { area(): number }',
    'export class Square implements Shape { area() { return 1; } }',
  ].join('\n') + '\n');
  write(lspRepo, 'README.md', '# lsp\n');
  write(lspRepo, '.gitignore', 'node_modules/\n.local-review/\n');
  git(['add', '-A'], lspRepo);
  git(['commit', '-q', '-m', 'init'], lspRepo);
  write(lspRepo, 'src/a.ts', "import { helper } from './b';\nexport const value = helper() + helper();\nconst crash = outside;\n");
  write(lspRepo, 'assets/blob.bin', Buffer.from([0, 1, 2, 0]));
  installFakeLsp(lspRepo, 'typescript-language-server');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-outside-'));
  write(outsideDir, 'secret.ts', 'export const secret = 1;\n');
  let symlinked = false;
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret.ts'), path.join(lspRepo, 'src', 'link.ts'));
    symlinked = true;
  } catch {
    /* no symlinks here (Windows without the privilege): that check is skipped */
  }
  const fixtureLog = path.join(home, 'lsp-fixture.log');
  process.env.LOCAL_REVIEW_LSP_FIXTURE_LOG = fixtureLog;
  const methods = () => (fs.existsSync(fixtureLog) ? fs.readFileSync(fixtureLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).method) : []);

  console.log('\nLSP: реестр серверов');
  {
    eq(registry.serverFor('src/x.tsx').id, 'typescript', 'реестр: .tsx -> typescript-language-server');
    eq(registry.serverFor('Main.java').id, 'java', 'реестр: .java -> jdtls');
    eq(registry.serverFor('README.md'), null, 'реестр: .md -> нет сервера');
    eq(registry.languageIdFor(registry.serverFor('a.jsx'), 'a.jsx'), 'javascriptreact', 'реестр: languageId для .jsx');
    const found = registry.findExecutable('typescript-language-server', { root: lspRepo, env: { PATH: '' } });
    ok(found && found.source === 'node_modules', 'поиск: сначала <repo>/node_modules/.bin', JSON.stringify(found));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-path-'));
    installFakeLsp(binDir, 'gopls');
    const onPath = registry.findExecutable('gopls', { root: lspRepo, env: { PATH: path.join(binDir, 'node_modules', '.bin'), PATHEXT: '.CMD' } });
    ok(onPath && onPath.source === 'PATH', 'поиск: затем PATH', JSON.stringify(onPath));
    eq(registry.findExecutable('rust-analyzer', { root: lspRepo, env: { PATH: binDir } }), null, 'поиск: не найден -> null');
    if (process.platform !== 'win32') {
      const notExec = path.join(binDir, 'pyright-langserver');
      fs.writeFileSync(notExec, '#!/bin/sh\n');
      fs.chmodSync(notExec, 0o644);
      eq(registry.findExecutable('pyright-langserver', { env: { PATH: binDir } }), null, 'поиск: файл без права на запуск не считается');
    }
    const winFound = registry.findExecutable('gopls', {
      env: { PATH: path.join(binDir, 'node_modules', '.bin'), PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
    });
    ok(process.platform === 'win32' ? Boolean(winFound) : winFound === null, 'поиск: на Windows имя берётся с расширением из PATHEXT');
    installFakeLsp(binDir, 'jdtls');
    const java = registry.commandFor(registry.serverById('java'), lspRepo, {
      homeDir: home,
      env: { PATH: path.join(binDir, 'node_modules', '.bin') },
    });
    ok(
      java && java.args[0] === '-data' && java.args[1] === path.join(home, 'jdtls', registry.rootHash(lspRepo)),
      'jdtls: -data ~/.local-review/jdtls/<хеш репозитория>',
      JSON.stringify(java)
    );
    ok(/^[0-9a-f]{16}$/.test(registry.rootHash(lspRepo)) && registry.rootHash(lspRepo) !== registry.rootHash(outsideDir),
      'jdtls: у разных репозиториев разные каталоги данных');
    // TypeScript 7 serves LSP itself (`tsc --lsp --stdio`); typescript-language-server cannot run on it.
    const ts7 = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-ts7-'));
    installFakeLsp(ts7, 'tsc');
    installFakeLsp(ts7, 'typescript-language-server');
    write(ts7, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '7.0.2' }));
    const tsServer = registry.serverById('typescript');
    const native = registry.commandFor(tsServer, ts7, { homeDir: home, env: { PATH: '' } });
    eq(native && [path.basename(native.command).replace(/\.cmd$/i, ''), native.args, native.label], ['tsc', ['--lsp', '--stdio'], 'tsgo'],
      'TypeScript 7 в репозитории -> tsc --lsp --stdio');
    write(ts7, 'node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.9.3' }));
    const classic = registry.commandFor(tsServer, ts7, { homeDir: home, env: { PATH: '' } });
    eq(classic && [path.basename(classic.command).replace(/\.cmd$/i, ''), classic.args, classic.label],
      ['typescript-language-server', ['--stdio'], 'tsserver'], 'TypeScript 5 -> typescript-language-server --stdio');
    fs.rmSync(ts7, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }

  const lq = `source=local&root=${encodeURIComponent(lspRepo)}&mode=working`;
  const lsp = (body, q = lq) => call(`/api/lsp?${q}`, json('POST', body));

  console.log('\nLSP: статус и запросы');
  const status0 = await call(`/api/lsp/status?${lq}`);
  const ts0 = (status0.body.servers || []).find((s) => s.id === 'typescript');
  ok(status0.status === 200 && ts0 && ts0.found && ts0.found.source === 'node_modules' && ts0.state === 'stopped',
    'GET /api/lsp/status: tsserver найден в node_modules и ещё не запущен', JSON.stringify(ts0));
  ok(ts0 && ts0.extensions.includes('.ts') && typeof ts0.hint === 'string', 'статус: расширения и подсказка, что ставить');

  // `helper` on line 1 of a.ts (0-based: line 1, character 21).
  const def = await lsp({ method: 'definition', path: 'src/a.ts', line: 1, character: 22 });
  ok(def.status === 200 && def.body.ok, 'POST /api/lsp definition -> ok', JSON.stringify(def.body));
  eq((def.body.locations || []).map((l) => [l.path, l.line, l.character]), [['src/b.ts', 0, 16]],
    'definition: helper -> src/b.ts, строка 0, символ 16');
  ok(['ready', 'indexing'].includes(def.body.server && def.body.server.state), 'ответ несёт состояние сервера', JSON.stringify(def.body.server));
  const readyStatus = await waitFor(async () => {
    const s = await call(`/api/lsp/status?${lq}`);
    const t = s.body.servers.find((x) => x.id === 'typescript');
    return t.state === 'ready' ? s : null;
  }, 3000);
  ok(readyStatus, 'после $/progress end сервер «готов»');
  ok(readyStatus && readyStatus.body.running.some((r) => r.root === lspRepo && r.id === 'typescript'), 'статус: запущенный сервер в списке running');
  eq(methods().filter((m) => m === 'initialize').length, 1, 'сервер запущен один раз (ленивый старт)');
  ok(methods().includes('initialized') && methods().includes('textDocument/didOpen'), 'initialize -> initialized -> didOpen');

  const hover1 = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 22 });
  eq(hover1.body.hover, { kind: 'markdown', value: '```ts\n(word) helper\n```\nversion 1' }, 'hover: текст с диска, документ открыт один раз');
  const shown = "import { helper } from './b';\nexport const shown = 1;\n";
  const hover2 = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 15, text: shown });
  eq(hover2.body.hover && hover2.body.hover.value, '```ts\n(word) shown\n```\nversion 2',
    'hover: показанный текст (staged/коммиты) уходит в сервер через didChange');
  const hover3 = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 15, text: shown });
  eq(hover3.body.hover.value.endsWith('version 2'), true, 'hover: тот же текст повторно не отправляется');
  eq(methods().filter((m) => m === 'textDocument/didOpen').length, 1, 'didOpen — один раз на документ');
  const fromDisk = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 22 });
  eq(fromDisk.body.hover && fromDisk.body.hover.value, '```ts\n(word) helper\n```\nversion 3',
    'hover без text после показанной версии: документ возвращается к файлу на диске');
  const bHover = await lsp({ method: 'hover', path: 'src/b.ts', line: 0, character: 17 });
  eq(bHover.body.hover && bHover.body.hover.value, '```ts\n(word) helper\n```\nversion 1', 'hover в b.ts: открыт с диска');
  write(lspRepo, 'src/b.ts', 'export function helperX() {\n  return 1;\n}\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(lspRepo, 'src/b.ts'), later, later);
  await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 22 });
  const bAgain = await lsp({ method: 'hover', path: 'src/b.ts', line: 0, character: 17 });
  eq(bAgain.body.hover && bAgain.body.hover.value, '```ts\n(word) helperX\n```\nversion 2',
    'файл изменён на диске: открытый документ получает didChange');
  write(lspRepo, 'src/b.ts', 'export function helper() {\n  return 1;\n}\n');
  const virt = await lsp({ method: 'definition', path: 'src/gone.ts', line: 0, character: 10, text: "import { helper } from './b';\n" });
  eq((virt.body.locations || []).map((l) => l.path), ['src/b.ts'], 'файла нет на диске, но текст передан: виртуальный документ');
  const outside = await lsp({ method: 'definition', path: 'src/a.ts', line: 2, character: 16 });
  ok(outside.body.ok && outside.body.locations[0].path === null && /elsewhere\.ts$/.test(outside.body.locations[0].external),
    'definition вне репозитория: path null, external — где это', JSON.stringify(outside.body));
  const md = await lsp({ method: 'hover', path: 'README.md', line: 0, character: 2 });
  eq([md.body.ok, md.body.reason], [false, 'unsupported'], 'файл без language server -> unsupported');
  eq((await lsp({ method: 'rename', path: 'src/a.ts', line: 0, character: 0 })).status, 400, 'неизвестный метод -> 400');
  eq((await lsp({ method: 'hover', path: 'src/a.ts', line: -1, character: 0 })).status, 400, 'отрицательная строка -> 400');
  eq((await lsp({ method: 'hover', path: 'src/missing.ts', line: 0, character: 0 })).status, 404, 'файла нет и текста нет -> 404');

  console.log('\nLSP: пути только внутри репозитория');
  for (const bad of ['../outside.ts', `../${path.basename(outsideDir)}/secret.ts`, path.join(outsideDir, 'secret.ts'), '/etc/passwd', 'src/../../x.ts', '', 'C:\\Windows\\win.ini']) {
    const res = await lsp({ method: 'hover', path: bad, line: 0, character: 0 });
    eq(res.status, 400, `POST /api/lsp: ${JSON.stringify(bad)} -> 400`);
    const file = await call(`/api/file?${lq}&path=${encodeURIComponent(bad)}`);
    eq(file.status, 400, `GET /api/file: ${JSON.stringify(bad)} -> 400`);
  }
  if (symlinked) {
    eq((await lsp({ method: 'hover', path: 'src/link.ts', line: 0, character: 14 })).status, 400,
      'POST /api/lsp: симлинк наружу -> 400');
    eq((await call(`/api/file?${lq}&path=src/link.ts`)).status, 400, 'GET /api/file: симлинк наружу -> 400');
  }
  const subdir = `source=local&root=${encodeURIComponent(path.join(lspRepo, 'src'))}&mode=working`;
  eq((await lsp({ method: 'hover', path: 'a.ts', line: 0, character: 0 }, subdir)).status, 400, 'root — не корень репозитория -> 400');
  eq((await call(`/api/file?${subdir}&path=a.ts`)).status, 400, 'GET /api/file: root не корень -> 400');

  console.log('\nLSP: файл целиком вне диффа');
  const whole = await call(`/api/file?${lq}&path=src/b.ts`);
  eq([whole.status, whole.body.path, whole.body.text], [200, 'src/b.ts', 'export function helper() {\n  return 1;\n}\n'], 'GET /api/file: текст файла');
  eq((await call(`/api/file?${lq}&path=assets/blob.bin`)).body.binary, true, 'GET /api/file: бинарный файл помечен');
  eq((await call(`/api/file?${lq}&path=src/nope.ts`)).status, 404, 'GET /api/file: нет файла -> 404');
  eq((await call(`/api/file?${lq}&path=src`)).status, 404, 'GET /api/file: каталог -> 404');

  console.log('\nLSP: содержимое .git не отдаётся');
  for (const gitPath of ['.git/config', '.git/HEAD', '.GIT/config', 'src/../.git/config', 'src/.git']) {
    eq((await call(`/api/file?${lq}&path=${encodeURIComponent(gitPath)}`)).status, 403, `GET /api/file: ${gitPath} -> 403`);
  }
  eq((await lsp({ method: 'hover', path: '.git/config', line: 0, character: 0 })).status, 403, 'POST /api/lsp: .git/config -> 403');
  if (symlinked) {
    fs.symlinkSync(path.join(lspRepo, '.git', 'config'), path.join(lspRepo, 'src', 'gitlink.ts'));
    eq((await call(`/api/file?${lq}&path=src/gitlink.ts`)).status, 403, 'GET /api/file: симлинк внутрь .git -> 403');
    fs.unlinkSync(path.join(lspRepo, 'src', 'gitlink.ts'));
  }

  console.log('\nLSP: GitHub PR без клона');
  const prq = 'source=pr&host=github.com&owner=o&repo=r&number=7';
  const prLsp = await lsp({ method: 'definition', path: 'src/a.ts', line: 0, character: 0 }, prq);
  eq([prLsp.status, prLsp.body.ok, prLsp.body.reason], [200, false, 'no-clone'], 'POST /api/lsp для PR -> no-clone');
  const prStatus = await call(`/api/lsp/status?${prq}`);
  eq([prStatus.body.available, prStatus.body.reason], [false, 'no-clone'], 'статус для PR: LSP недоступен, нет клона');
  eq((await call(`/api/file?${prq}&path=src/a.ts`)).status, 409, 'GET /api/file для PR -> 409');
  const bare = await call('/api/lsp/status?source=local');
  eq(bare.status, 400, 'статус с битым дескриптором -> 400');

  console.log('\nLSP: падение сервера');
  lspRoutes.configure({ restartDelayMs: 60 * 1000 });
  const crashed = await lsp({ method: 'hover', path: 'src/a.ts', line: 2, character: 8 });
  ok(crashed.body.ok === false && crashed.body.reason === 'failed' && /fixture: crash requested/.test(crashed.body.message),
    'сервер упал во время запроса -> failed с хвостом stderr', JSON.stringify(crashed.body));
  const afterCrash = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 15 });
  ok(afterCrash.body.ok === false && /повторный запуск через/.test(afterCrash.body.message),
    'сразу после падения не перезапускается', JSON.stringify(afterCrash.body));
  const crashStatus = (await call(`/api/lsp/status?${lq}`)).body.servers.find((s) => s.id === 'typescript');
  eq(crashStatus.state, 'failed', 'статус после падения: failed');
  lspRoutes.configure({ restartDelayMs: 0 });
  const restarted = await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 15 });
  ok(restarted.body.ok && /version 1$/.test(restarted.body.hover.value), 'после паузы сервер стартует заново и открывает документ заново',
    JSON.stringify(restarted.body));
  eq(methods().filter((m) => m === 'initialize').length, 2, 'второй initialize — только после падения');

  console.log('\nLSP: остановка после простоя');
  lspRoutes.configure({ idleMs: 200 });
  await lsp({ method: 'hover', path: 'src/a.ts', line: 1, character: 15 });
  const stopped = await waitFor(async () => {
    const s = (await call(`/api/lsp/status?${lq}`)).body;
    return s.running.length === 0 && s.servers.find((x) => x.id === 'typescript').state === 'stopped' ? s : null;
  }, 3000);
  ok(stopped, 'после простоя сервер остановлен');
  ok(methods().includes('shutdown') && methods().includes('exit'), 'остановка: shutdown, затем exit');
  lspRoutes.configure({ idleMs: 10 * 60 * 1000 });
  const again = await lsp({ method: 'definition', path: 'src/a.ts', line: 1, character: 22 });
  eq((again.body.locations || []).map((l) => l.path), ['src/b.ts'], 'после остановки следующий запрос снова запускает сервер');

  console.log('\nLSP: сервер не установлен');
  const savedPath = process.env.PATH;
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-empty-'));
  write(lspRepo, 'main.go', 'package main\n');
  process.env.PATH = emptyDir;
  let noServer;
  try {
    noServer = await lsp({ method: 'hover', path: 'main.go', line: 0, character: 2 });
  } finally {
    process.env.PATH = savedPath;
  }
  ok(noServer.body.ok === false && noServer.body.reason === 'no-server' && /gopls/.test(noServer.body.hint),
    'нет gopls -> no-server и подсказка, что поставить', JSON.stringify(noServer.body));

  await lspNavigationChecks(lsp, lspRepo, lspRoutes, symlinked);

  await lspRoutes.getManager().stopAll();
  delete process.env.LOCAL_REVIEW_LSP_FIXTURE_LOG;

  const extraDirs = [];
  if (process.platform !== 'win32') {
    console.log('\nLSP: неудачный старт и группа процессов');
    const { LspManager, LspError } = require('./lib/lsp/manager');
    const badRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-lsp-bad-'));
    extraDirs.push(badRepo);
    const bin = path.join(badRepo, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = (name, body) => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    const pidFile = path.join(badRepo, 'child.pid');
    // Never answers initialize.
    script('mute-lsp', 'exec sleep 30');
    // A launcher that starts a «JVM» and dies.
    script('dying-lsp', `sleep 30 &\necho $! > "${pidFile}"\nexit 1`);
    const def = (bin2) => ({ id: bin2, name: bin2, label: bin2, commands: [{ bin: bin2, args: [] }], languageIds: {}, hint: '' });
    const mgr = new LspManager({ homeDir: home, startTimeoutMs: 300, restartDelayMs: 0, stopTimeoutMs: 200 });
    const both = await Promise.all([mgr.ensure(badRepo, def('mute-lsp')), mgr.ensure(badRepo, def('mute-lsp'))].map((p) => p.catch((e) => e)));
    ok(both.every((e) => e instanceof LspError && e.reason === 'failed'),
      'два параллельных первых запроса, initialize не дождались -> оба LspError failed', both.map((e) => e && e.constructor.name).join(','));
    const dying = await mgr.ensure(badRepo, def('dying-lsp')).catch((e) => e);
    ok(dying instanceof LspError && /код 1/.test(dying.message), 'лаунчер упал при старте -> failed', String(dying && dying.message));
    const orphan = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    ok(await waitFor(() => !alive(orphan), 2000), 'после падения лаунчера его дочерний процесс (группа) убит');
  }
  return [lspRepo, outsideDir, emptyDir, ...extraDirs];
}

// -------------------------------------------------------------------- suite

async function main() {
  // Never touch the real ~/.local-review: the whole home config goes to a
  // throwaway directory for the duration of the test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-home-'));
  process.env.LOCAL_REVIEW_HOME = home;

  // Never touch the real git config either: the "global ignore" target reads
  // core.excludesFile and may write it, so both the global config and the XDG
  // config home are throwaway directories for the duration of the test.
  const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-gitconfig-'));
  process.env.GIT_CONFIG_GLOBAL = path.join(gitHome, '.gitconfig');
  process.env.GIT_CONFIG_SYSTEM = path.join(gitHome, 'system.gitconfig');
  process.env.XDG_CONFIG_HOME = path.join(gitHome, 'xdg');

  // Points every `start()` call in this suite at a throwaway static dir
  // instead of the real dist/ (which may not be built in this checkout).
  // Also doubles as the assertion fixture for the "GET / serves the
  // configured static dir" check right after the first server starts.
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-static-'));
  const staticIndexHtml = '<!doctype html><title>smoke ui</title><body>smoke-static-marker</body>\n';
  fs.writeFileSync(path.join(staticDir, 'index.html'), staticIndexHtml, 'utf8');
  process.env.LOCAL_REVIEW_STATIC_DIR = staticDir;

  // A failing gh fixture of a transient kind is retried (lib/gh.js); the
  // suite must not sit out the real backoff between those attempts.
  require('./lib/gh').configure({ retryDelaysMs: [0, 0] });

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

  // Vite copies web/public/favicon.svg to the build root; index.html links it.
  const webDir = path.join(__dirname, 'web');
  ok(
    fs.readFileSync(path.join(webDir, 'index.html'), 'utf8').includes('href="/favicon.svg"'),
    'web/index.html ссылается на /favicon.svg'
  );
  fs.copyFileSync(path.join(webDir, 'public', 'favicon.svg'), path.join(staticDir, 'favicon.svg'));
  const faviconRes = await fetch(`http://127.0.0.1:${server.port}/favicon.svg`);
  await faviconRes.arrayBuffer();
  ok(faviconRes.status === 200, 'GET /favicon.svg -> 200', String(faviconRes.status));
  eq(faviconRes.headers.get('content-type'), 'image/svg+xml', 'GET /favicon.svg -> image/svg+xml');
  const icoRes = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
  await icoRes.arrayBuffer();
  ok(
    icoRes.status === 404 && !(icoRes.headers.get('content-type') || '').includes('text/html'),
    'GET /favicon.ico -> 404 без HTML',
    `${icoRes.status} ${icoRes.headers.get('content-type')}`
  );

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

  // Line counts of the file list: one `git diff --numstat` for the whole diff.
  // Keyed by path in code-point order, so a whole map compares regardless of
  // how the server sorts the list.
  const lineCounts = (body) =>
    Object.fromEntries(
      body.files.map((f) => [f.path, [f.additions, f.deletions]]).sort(([a], [b]) => (a < b ? -1 : 1))
    );
  const counts = lineCounts(state.body);
  eq(counts['src/app.js'], [2, 0], 'state: изменённый файл — +2 −0');
  eq(counts['crlf.txt'], [1, 1], 'state: заменённая строка — +1 −1');
  eq(counts['src/to-delete.js'], [0, 1], 'state: удалённый файл — +0 −1');
  eq(counts['src/renamed.js'], [1, 0], 'state: переименование считается по новому пути — +1 −0');
  eq(counts['документы/мой файл.txt'], [1, 0], 'state: кириллический путь с пробелом — +1 −0');
  eq(counts['assets/logo.bin'], [null, null], 'state: у бинарного файла счётчиков нет (null)');
  eq(counts['brand new.txt'], [null, null], 'state: у untracked-файла счётчиков нет (null)');
  ok(
    state.body.files.every((f) => 'additions' in f && 'deletions' in f),
    'state: additions / deletions есть у каждого файла'
  );

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
  eq(lineCounts(stagedAfterAdd.body)['src/app.js'], [2, 0], 'staged: счётчики строк считаются по индексу');
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
  eq(lineCounts(baseMode.body)['src/app.js'], [3, 0], 'base: счётчики строк считаются от merge-base');

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

  // A repository whose main branch is not called "main". Base mode must ask
  // origin/HEAD which revision that is; guessing the name is what made the
  // tool answer «Ревизия "origin/main" не найдена» in a real project.
  const prodRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-prod-'));
  git(['init', '-q', '-b', 'production'], prodRepo);
  git(['config', 'user.email', 'smoke@example.com'], prodRepo);
  git(['config', 'user.name', 'Smoke Test'], prodRepo);
  git(['config', 'commit.gpgsign', 'false'], prodRepo);
  write(prodRepo, 'a.txt', 'a\n');
  git(['add', '-A'], prodRepo);
  git(['commit', '-q', '-m', 'init'], prodRepo);
  git(['update-ref', 'refs/remotes/origin/production', git(['rev-parse', 'HEAD'], prodRepo).trim()], prodRepo);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/production'], prodRepo);
  write(prodRepo, 'a.txt', 'a\nb\n');
  const prodServer = await start({
    cwd: prodRepo, mode: 'base', base: '', port: 0, host: '127.0.0.1', open: false,
  });
  const prodCall = makeClient(prodServer.port);
  eq(prodServer.resolvedBase, 'origin/production', 'CLI без --base берёт ветку по умолчанию у origin');
  const prodState = await prodCall('/api/state?mode=base');
  eq(prodState.body.base, 'origin/production', 'режим base без base= берёт origin/HEAD, а не origin/main');
  // `.gitignore` is the tool's own doing (it adds .local-review/ on start).
  eq(
    prodState.body.files.map((f) => f.path),
    ['.gitignore', 'a.txt'],
    'дифф от этой базы действительно читается'
  );
  await new Promise((r) => prodServer.server.close(r));

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

  // ------------------------------------- системный диалог выбора папки
  console.log('\nсистемный диалог выбора папки (подставной бинарь)');
  process.env.LOCAL_REVIEW_FOLDER_DIALOG_BIN = FIXTURE_FOLDER_DIALOG;
  const pickedDir = path.join(os.tmpdir(), 'моя папка');
  folderDialogResult({ code: 0, stdout: pickedDir + '\r\n' });
  const pickOk = await call('/api/local/pick-folder', { method: 'POST' });
  ok(
    pickOk.status === 200 && pickOk.body.path === pickedDir && !pickOk.body.cancelled,
    'выбранная папка -> 200 с путём без хвостового перевода строки (кириллица и пробел целы)',
    JSON.stringify(pickOk.body)
  );
  folderDialogResult({ code: 0, stdout: '' });
  const pickEmpty = await call('/api/local/pick-folder', { method: 'POST' });
  ok(
    pickEmpty.status === 200 && pickEmpty.body.cancelled === true && !pickEmpty.body.path,
    'пустой вывод -> отмена',
    JSON.stringify(pickEmpty.body)
  );
  folderDialogResult({ code: 1, stderr: '0:42: execution error: User canceled. (-128)\n' });
  const pickCancel = await call('/api/local/pick-folder', { method: 'POST' });
  ok(
    pickCancel.status === 200 && pickCancel.body.cancelled === true,
    'код 1 без вывода (отмена в osascript/zenity) -> отмена',
    JSON.stringify(pickCancel.body)
  );
  folderDialogResult({ code: 2, stderr: 'dialog exploded\n' });
  const pickFail = await call('/api/local/pick-folder', { method: 'POST' });
  ok(
    pickFail.status === 500 && /dialog exploded/.test(pickFail.body.error),
    'сбой диалога -> 500 с текстом stderr',
    JSON.stringify(pickFail.body)
  );
  process.env.LOCAL_REVIEW_FOLDER_DIALOG_BIN = path.join(os.tmpdir(), 'definitely-no-dialog-here-12345');
  const pickMissing = await call('/api/local/pick-folder', { method: 'POST' });
  ok(
    pickMissing.status === 500 && /диалог/i.test(pickMissing.body.error),
    'нет программы диалога -> 500 с читаемым текстом',
    JSON.stringify(pickMissing.body)
  );
  process.env.LOCAL_REVIEW_FOLDER_DIALOG_BIN = FIXTURE_FOLDER_DIALOG;
  folderDialogResult({ code: 0, stdout: pickedDir, delayMs: 400 });
  const [pickA, pickB] = await Promise.all([
    call('/api/local/pick-folder', { method: 'POST' }),
    new Promise((r) => setTimeout(r, 100)).then(() => call('/api/local/pick-folder', { method: 'POST' })),
  ]);
  ok(
    pickA.status === 200 && pickB.status === 409,
    'второй диалог, пока открыт первый -> 409',
    `${pickA.status} / ${pickB.status}`
  );
  const pickAfter = await call('/api/local/pick-folder', { method: 'POST' });
  ok(pickAfter.status === 200, 'после закрытия диалога можно открыть новый', String(pickAfter.status));
  delete process.env.LOCAL_REVIEW_FOLDER_DIALOG_BIN;
  delete process.env.LOCAL_REVIEW_FOLDER_DIALOG_RESULT;

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

  // The line always lands in the repository's top-level .gitignore, even when
  // the chosen root is a subfolder (e.g. a hand-edited #hash or a stale recent).
  const nestedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-nested-'));
  git(['init', '-q', '-b', 'main'], nestedRepo);
  write(nestedRepo, 'packages/app/index.js', 'x\n');
  const nestedDir = path.join(nestedRepo, 'packages', 'app');
  const pickedNested = await call(
    '/api/session',
    json('POST', {
      descriptor: { source: 'local', root: nestedDir, mode: 'working', base: 'origin/main' },
    })
  );
  ok(
    pickedNested.status === 200 && pickedNested.body.gitignore.changed === true,
    'выбор подкаталога репозитория -> gitignore.changed',
    JSON.stringify(pickedNested.body)
  );
  ok(!fs.existsSync(path.join(nestedDir, '.gitignore')), 'вложенный .gitignore в подкаталоге НЕ создаётся');
  eq(
    fs.readFileSync(path.join(nestedRepo, '.gitignore'), 'utf8'),
    '.local-review/\n',
    'строка записана в корневой .gitignore репозитория'
  );

  const { ensureGitignore } = require('./review');
  const notRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-nogit-'));
  eq(
    (await ensureGitignore(notRepoDir)).changed,
    false,
    'вне git-репозитория ensureGitignore ничего не пишет'
  );
  ok(!fs.existsSync(path.join(notRepoDir, '.gitignore')), 'вне git-репозитория .gitignore не создаётся');

  const gitignoreCases = [
    ['node_modules', 'node_modules\n.local-review/\n', 'без перевода строки в конце -> дописывает с новой строки'],
    ['node_modules\r\n', 'node_modules\r\n.local-review/\r\n', 'CRLF сохраняется'],
    ['/.local-review\n', '/.local-review\n', '/.local-review уже игнорирует -> без дубля'],
    ['**/.local-review/\n', '**/.local-review/\n', '**/.local-review/ уже игнорирует -> без дубля'],
  ];
  for (const [before, after, label] of gitignoreCases) {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-gi-'));
    git(['init', '-q', '-b', 'main'], r);
    fs.writeFileSync(path.join(r, '.gitignore'), before);
    await ensureGitignore(r);
    await ensureGitignore(r); // a second run must not duplicate the line
    eq(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), after, `.gitignore: ${label}`);
  }

  // ------------------------------------------- куда писать игнор (#26)
  console.log('\nнастройка: проектный или глобальный игнор');
  const ignoreSettings0 = await call('/api/settings');
  eq(ignoreSettings0.body.gitignoreTarget, 'project', 'GET /api/settings: по умолчанию project');
  eq((await call('/api/settings', json('PUT', { gitignoreTarget: 'нет' }))).status, 400,
    'PUT /api/settings: чужое значение -> 400');
  eq((await call('/api/settings', json('PUT', {}))).status, 400,
    'PUT /api/settings без gitignoreTarget -> 400');

  const toGlobal = await call('/api/settings', json('PUT', { gitignoreTarget: 'global' }));
  eq(toGlobal.body.gitignoreTarget, 'global', 'PUT /api/settings: global сохранён');
  ok(fs.existsSync(path.join(home, 'settings.json')), 'настройка лежит в <home>/settings.json');

  // core.excludesFile не задан -> git-овский дефолт $XDG_CONFIG_HOME/git/ignore,
  // и тула прописывает его в глобальный конфиг.
  const xdgIgnore = path.join(process.env.XDG_CONFIG_HOME, 'git', 'ignore');
  const globalRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-global-'));
  git(['init', '-q', '-b', 'main'], globalRepo);
  const pickedGlobal = await call(
    '/api/session',
    json('POST', {
      descriptor: { source: 'local', root: globalRepo, mode: 'working', base: 'origin/main' },
    })
  );
  ok(
    pickedGlobal.status === 200 && pickedGlobal.body.gitignore.changed === true &&
      pickedGlobal.body.gitignore.target === 'global',
    'режим global: запись в глобальный игнор, а не в репозиторий',
    JSON.stringify(pickedGlobal.body)
  );
  eq(fs.readFileSync(xdgIgnore, 'utf8'), '.local-review/\n', 'строка в $XDG_CONFIG_HOME/git/ignore');
  ok(!fs.existsSync(path.join(globalRepo, '.gitignore')), 'режим global: .gitignore репозитория не создаётся');
  eq(
    path.resolve(git(['config', '--global', '--get', 'core.excludesFile'], globalRepo).trim()),
    path.resolve(xdgIgnore),
    'незаданный core.excludesFile прописывается в глобальный git config'
  );
  eq((await ensureGitignore(globalRepo)).changed, false, 'режим global: повторный запуск не дублирует строку');
  eq(fs.readFileSync(xdgIgnore, 'utf8'), '.local-review/\n', 'глобальный игнор остался в одну строку');

  // core.excludesFile задан -> пишем ровно туда, конфиг не трогаем.
  const customIgnore = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-excl-')), 'ignore');
  fs.writeFileSync(customIgnore, '*.log\r\n*.tmp', 'utf8');
  git(['config', '--global', 'core.excludesFile', customIgnore], globalRepo);
  eq((await ensureGitignore(globalRepo)).file, customIgnore, 'заданный core.excludesFile выигрывает');
  eq(
    fs.readFileSync(customIgnore, 'utf8'),
    '*.log\r\n*.tmp\r\n.local-review/\r\n',
    'глобальный игнор: CRLF и недостающий перевод строки'
  );

  // `~` в core.excludesFile — это домашний каталог по-гитовски.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-home-tilde-'));
  const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  git(['config', '--global', 'core.excludesFile', '~/ignore-me'], globalRepo);
  await ensureGitignore(globalRepo);
  ok(
    fs.existsSync(path.join(fakeHome, 'ignore-me')) &&
      fs.readFileSync(path.join(fakeHome, 'ignore-me'), 'utf8') === '.local-review/\n',
    '~ в core.excludesFile разворачивается в домашний каталог'
  );
  process.env.HOME = realHome.HOME;
  process.env.USERPROFILE = realHome.USERPROFILE;
  git(['config', '--global', '--unset', 'core.excludesFile'], globalRepo);

  // Обратно в project: следующая папка снова получает свой .gitignore.
  await call('/api/settings', json('PUT', { gitignoreTarget: 'project' }));
  eq(
    (await call('/api/settings')).body.gitignoreTarget,
    'project',
    'настройка переживает запись сессии (state.json её не затирает)'
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

  // `last` now points at a folder that was picked in the UI, while this server
  // was launched against `repo`. The launch repository must win on boot, or a
  // fresh tab silently opens someone else's diff (and calls it empty).
  const sessAfterPick = await call('/api/session');
  eq(sessAfterPick.body.last.root, noGitignoreRepo, 'last = последняя выбранная папка');
  eq(
    sessAfterPick.body.defaults && sessAfterPick.body.defaults.root,
    // findRepoRoot reports git's own forward-slash spelling of the path.
    repo.split('\\').join('/'),
    'defaults = репозиторий запуска, даже когда last указывает в другой'
  );

  // ------------------------------------------------- Host (DNS rebinding)
  console.log('\nпроверка Host');
  const withHost = (host, pathname = '/api/state') =>
    new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port: server.port, path: pathname, headers: { host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
  eq(await withHost('evil.example'), 403, 'Host: evil.example -> 403 (DNS rebinding)');
  eq(await withHost(`evil.example:${server.port}`), 403, 'Host: evil.example:<порт> -> 403');
  eq(await withHost('127.0.0.1.evil.example'), 403, 'Host: 127.0.0.1.evil.example -> 403');
  eq(await withHost(`localhost:${server.port}`), 200, 'Host: localhost -> 200');
  eq(await withHost(`LOCALHOST:${server.port}`), 200, 'Host: LOCALHOST -> 200');
  eq(await withHost(`127.0.0.1:${server.port}`), 200, 'Host: 127.0.0.1 -> 200');
  eq(await withHost(`[::1]:${server.port}`), 200, 'Host: [::1] -> 200');
  eq(await withHost('evil.example', '/'), 200, 'статика с чужим Host отдаётся (данных в ней нет)');
  {
    const { checkHost, allowedHosts } = require('./lib/http');
    const req = (host) => ({ headers: { host } });
    eq(checkHost(req('192.168.1.5:4321'), allowedHosts('192.168.1.5')), null, '--host 192.168.1.5: этот адрес в Host разрешён');
    ok(checkHost(req('192.168.1.6:4321'), allowedHosts('192.168.1.5')) !== null, '--host 192.168.1.5: другой адрес -> отказ');
    eq(checkHost(req('[fe80::1]:4321'), allowedHosts('fe80::1')), null, '--host с IPv6-адресом: он же в скобках в Host');
    eq(checkHost({ headers: {} }, allowedHosts('127.0.0.1')), null, 'без Host (HTTP/1.0, не браузер) — пропускается');
  }

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
  // A link on another site (GitHub, Slack, Notion) navigates here with
  // Sec-Fetch-Site: cross-site. The shell and its assets carry no data, so
  // they must load; only /api/* is the surface the check protects.
  const crossSiteHeaders = { 'sec-fetch-site': 'cross-site' };
  const crossSiteShell = await call('/', { headers: crossSiteHeaders });
  ok(crossSiteShell.status === 200, 'GET / с Sec-Fetch-Site: cross-site -> 200', String(crossSiteShell.status));
  eq(crossSiteShell.body, staticIndexHtml, 'GET / с Sec-Fetch-Site: cross-site отдаёт оболочку SPA');
  const crossSiteIndex = await call('/index.html', { headers: { ...crossSiteHeaders, origin: 'http://evil.example' } });
  ok(crossSiteIndex.status === 200, 'статика с чужим Origin -> 200', String(crossSiteIndex.status));
  const crossSitePost = await call('/api/comments', {
    ...json('POST', { file: 'src/app.js', line: 1, side: 'new', body: 'csrf' }),
    headers: { 'content-type': 'application/json', ...crossSiteHeaders },
  });
  ok(crossSitePost.status === 403, 'POST /api/comments с cross-site -> 403', JSON.stringify(crossSitePost.body));
  const crossSiteEncoded = await call('/%61pi/state', { headers: crossSiteHeaders });
  ok(crossSiteEncoded.status === 403, '/%61pi/state с cross-site -> 403', JSON.stringify(crossSiteEncoded.body));
  const crossSiteUnknown = await call('/api/nope', { headers: crossSiteHeaders });
  ok(crossSiteUnknown.status === 403, 'неизвестный /api/* с cross-site -> 403, а не 404', JSON.stringify(crossSiteUnknown.body));

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
    'search prs --involves=@me --limit 30 --json number,title,repository,author,state,updatedAt,url,isDraft --state=open';
  // Фильтр «мои» (#19): автор уходит в gh флагом @me, а не в текст запроса.
  // Без репозитория «все» — это --involves=@me (весь GitHub перечислить нельзя).
  const searchMineKey =
    'search prs --author=@me --limit 30 --json number,title,repository,author,state,updatedAt,url,isDraft --state=open';
  const listMineKey =
    'pr list --repo o/r --limit 30 --json number,title,author,headRefName,baseRefName,updatedAt,url,state,isDraft --search fix --author @me --state open';
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
      [searchMineKey]: {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 27,
            title: 'Мой PR в другом репозитории',
            repository: { nameWithOwner: 'o/other' },
            author: { login: 'octocat' },
            state: 'OPEN',
            isDraft: true,
            updatedAt: '2026-09-03T10:00:00Z',
            url: 'https://github.com/o/other/pull/27',
          },
        ]),
      },
      [listMineKey]: {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 26,
            title: 'Мой PR',
            author: { login: 'octocat' },
            headRefName: 'fix/mine',
            baseRefName: 'main',
            state: 'OPEN',
            isDraft: false,
            updatedAt: '2026-09-02T10:00:00Z',
            url: 'https://github.com/o/r/pull/26',
          },
        ]),
      },
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

  const explicitAll = await call('/api/pr/search?repo=o/r&state=open&author=all');
  eq(
    explicitAll.body.items && explicitAll.body.items.map((i) => i.number).join(','),
    '25',
    'author=all в репозитории — тот же список, что и без фильтра'
  );

  const repoMine = await call('/api/pr/search?repo=o/r&q=fix&state=open&author=mine');
  ok(
    repoMine.status === 200 && repoMine.body.items.length === 1 && repoMine.body.items[0].number === 26,
    'author=mine в репозитории -> gh pr list --author @me',
    JSON.stringify(repoMine.body)
  );

  // Без репозитория фильтр меняет саму команду gh, а у подставного gh нет
  // ключа «*»: промах по команде уронил бы проверку кодом 98.
  const globalAll = await call('/api/pr/search?state=open&author=all');
  ok(
    globalAll.status === 200 && globalAll.body.items.length === 0,
    'author=all без репозитория -> gh search prs --involves=@me',
    JSON.stringify(globalAll.body)
  );

  const globalMine = await call('/api/pr/search?state=open&author=mine');
  ok(
    globalMine.status === 200 &&
      globalMine.body.items.length === 1 &&
      globalMine.body.items[0].number === 27 &&
      globalMine.body.items[0].repo === 'other',
    'author=mine без репозитория -> gh search prs --author=@me, другой список',
    JSON.stringify(globalMine.body)
  );

  const badAuthor = await call('/api/pr/search?repo=o/r&author=someone');
  ok(
    badAuthor.status === 400 && /all \| mine/.test(badAuthor.body.error),
    'неизвестный фильтр автора -> 400 с подсказкой',
    JSON.stringify(badAuthor.body)
  );

  const badRepo = await call('/api/pr/search?repo=просто-строка');
  ok(
    badRepo.status === 400 && /owner\/repo/.test(badRepo.body.error),
    'некорректный репозиторий -> 400 с подсказкой',
    JSON.stringify(badRepo.body)
  );

  // ------------------------------------------- список репозиториев (#40)
  console.log('\nсписок репозиториев (#40)');
  // Ключ фикстуры — argv через пробел, ровно как его собирает lib/repos.js.
  // Разойдётся с реальной командой — фикстура промахнётся кодом 98, и эти
  // проверки упадут, а не тихо пройдут мимо.
  const reposKey =
    'api /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100 ' +
    '--jq [.[] | {nameWithOwner: .full_name, pushedAt: .pushed_at, isPrivate: .private}]';
  ghFixtures(
    {
      [reposKey]: {
        code: 0,
        stdout: JSON.stringify([
          { nameWithOwner: 'o/старый', pushedAt: '2020-01-01T00:00:00Z', isPrivate: false },
          { nameWithOwner: 'o/свежий', pushedAt: '2026-09-20T12:00:00Z', isPrivate: true },
          { nameWithOwner: 'o/свежий', pushedAt: '2026-09-20T12:00:00Z', isPrivate: true },
          { nameWithOwner: 'o/без-пуша', pushedAt: null, isPrivate: false },
          { pushedAt: '2026-09-20T12:00:00Z' },
        ]),
      },
    },
    home
  );

  const repoList = await call('/api/gh/repos');
  eq(
    repoList.status === 200 && repoList.body.items.map((r) => r.nameWithOwner).join(','),
    'o/свежий,o/старый,o/без-пуша',
    'список репозиториев: свежий пуш первым, дубликат схлопнут, строка без имени выброшена'
  );
  eq(repoList.body.items[0].isPrivate, true, 'приватность репозитория доезжает до экрана');
  eq(repoList.body.items[2].pushedAt, null, 'репозиторий без даты пуша остаётся в списке');

  ghFixtures(
    {
      [reposKey]: { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
    },
    home
  );
  const reposFail = await call('/api/gh/repos');
  ok(
    reposFail.status === 404 && /не найден/i.test(reposFail.body.error),
    'ошибка gh при списке репозиториев -> читаемое сообщение, а не 500',
    JSON.stringify(reposFail.body)
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
  eq(
    lineCounts(prState.body),
    {
      'assets/logo.bin': [null, null],
      'created.txt': [2, 0],
      'gone.txt': [0, 1],
      'src/app.js': [1, 0],
      'новое имя.txt': [0, 0],
    },
    'PR: счётчики строк доезжают до /api/state, у бинарного файла — null'
  );
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

  // --------------------------------------- gh: надёжность запросов (#55)
  console.log('\ngh: надёжность запросов');
  const ghLib = require('./lib/gh');
  const relLog = path.join(home, 'gh-reliability-calls.log');
  const relCalls = (needle) =>
    fs.existsSync(relLog)
      ? fs.readFileSync(relLog, 'utf8').split('\n').filter((l) => l && l.includes(needle)).length
      : 0;
  const rejection = (promise) => promise.then(() => null, (e) => e);
  process.env.LOCAL_REVIEW_GH_CALL_LOG = relLog;

  // -- классификация: у каждого класса ошибок своя причина и своё сообщение
  const classOf = (stderr) => ghLib.classifyGhError({ code: 1, stderr: Buffer.from(stderr) }, ['api', 'x']);
  const CLASSES = [
    [
      'timeout',
      'Get "https://api.github.com/x": dial tcp 140.82.121.6:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time',
    ],
    ['timeout', 'Get "https://api.github.com/x": net/http: TLS handshake timeout'],
    ['network', 'dial tcp: lookup api.github.com: no such host'],
    ['network', 'Get "https://api.github.com/x": dial tcp 140.82.121.6:443: connect: connection refused'],
    ['server', 'gh: Bad Gateway (HTTP 502)'],
    ['server', 'gh: Gateway Timeout (HTTP 504)'],
    ['rate-limit', 'gh: API rate limit exceeded for user ID 1. (HTTP 403)'],
    ['rate-limit', 'gh: You have exceeded a secondary rate limit. Please wait a few minutes (HTTP 403)'],
    ['not-authenticated', 'gh: Bad credentials (HTTP 401)'],
    ['not-found', 'gh: Not Found (HTTP 404)'],
    ['unknown', 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)'],
    ['unknown', 'gh: Validation Failed (HTTP 422)'],
  ];
  for (const [reason, stderr] of CLASSES) {
    eq(classOf(stderr).ghReason, reason, `классификация: ${reason} <- ${stderr.slice(-48)}`);
  }
  const timedOut = ghLib.classifyGhError(
    { code: null, stderr: Buffer.alloc(0), timedOut: true, timeoutMs: 12000 },
    ['api', 'x']
  );
  eq(timedOut.ghReason, 'timeout', 'классификация: gh, убитый по таймауту, — timeout');
  eq(timedOut.status, 504, 'таймаут -> HTTP 504');
  const messages = ['timeout', 'network', 'server', 'rate-limit', 'not-authenticated', 'not-found'].map(
    (reason) => classOf(CLASSES.find((c) => c[0] === reason)[1]).message
  );
  eq(new Set(messages).size, messages.length, 'у каждого класса ошибок своё сообщение');
  ok(
    !/нет связи/i.test(classOf(CLASSES[0][1]).message) && /нет связи/i.test(classOf(CLASSES[2][1]).message),
    '«нет связи» говорится только про отсутствие сети, а не про таймаут соединения'
  );
  eq(
    ['timeout', 'network', 'server', 'rate-limit', 'not-authenticated', 'not-found', 'not-installed', 'unknown'].filter(
      (reason) => ghLib.isTransient({ ghReason: reason })
    ),
    ['timeout', 'network', 'server'],
    'временными считаются только таймаут, сеть и 5xx'
  );

  // -- повтор: задержки подставные, тест реально не ждёт
  const slept = [];
  const restoreGh = ghLib.configure({
    retryDelaysMs: [300, 1200],
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  const DIAL = { code: 1, stderr: 'Get "https://api.github.com/x": dial tcp 1.2.3.4:443: i/o timeout\n' };
  ghFixtures(
    {
      'api flaky': [DIAL, { code: 0, stdout: 'recovered\n' }],
      'api always-down': DIAL,
      'api bad-gateway-once': [{ code: 1, stderr: 'gh: Bad Gateway (HTTP 502)\n' }, { code: 0, stdout: 'ok\n' }],
      'api gone': { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
      'api too-big': {
        code: 1,
        stderr: 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)\n',
      },
      'api invalid': { code: 1, stderr: 'gh: Validation Failed (HTTP 422)\n' },
      'api limited': { code: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n' },
      'api no-auth': { code: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' },
    },
    home
  );
  eq(await ghLib.gh(['api', 'flaky']), 'recovered\n', 'временный сбой, затем успех -> запрос удаётся');
  eq(relCalls('api flaky'), 2, 'временный сбой: gh запущен дважды');
  eq(slept, [300], 'перед повтором выдержана первая задержка (подставная)');
  eq(await ghLib.gh(['api', 'bad-gateway-once']), 'ok\n', 'HTTP 502, затем успех -> запрос удаётся');

  slept.length = 0;
  const down = await rejection(ghLib.gh(['api', 'always-down']));
  ok(down && down.ghReason === 'timeout' && down.userFacing === true, 'постоянный сбой -> ошибка своего класса', String(down));
  eq(relCalls('api always-down'), 3, 'постоянный сбой: три попытки и не больше');
  eq(slept, [300, 1200], 'задержки между попытками растут');

  for (const [name, reason] of [
    ['gone', 'not-found'],
    ['too-big', 'unknown'],
    ['invalid', 'unknown'],
    ['limited', 'rate-limit'],
    ['no-auth', 'not-authenticated'],
  ]) {
    const err = await rejection(ghLib.gh(['api', name]));
    ok(err && err.ghReason === reason, `невременная ошибка (${name}) -> ${reason}`, String(err));
    eq(relCalls(`api ${name}`), 1, `невременная ошибка (${name}) не повторяется`);
  }

  // -- таймаут: зависший gh убивается, а не держит запрос вечно
  ghFixtures({ 'api hang': { code: 0, stdout: 'late\n', delayMs: 5000 } }, home);
  ghLib.configure({ attemptTimeoutsMs: [150], retryDelaysMs: [] });
  const hangStarted = Date.now();
  const hung = await rejection(ghLib.gh(['api', 'hang']));
  ok(hung && hung.ghReason === 'timeout' && hung.status === 504, 'зависший gh -> timeout / 504', String(hung));
  ok(Date.now() - hangStarted < 3000, 'зависший gh прерван по таймауту, а не дождался ответа');
  ghLib.configure({ attemptTimeoutsMs: [10000], retryDelaysMs: [0, 0] });

  // -- одинаковые одновременные запросы -> один gh
  ghFixtures({ 'api same': { code: 0, stdout: 'shared\n', delayMs: 200 } }, home);
  const shared = await Promise.all(Array.from({ length: 5 }, () => ghLib.gh(['api', 'same'])));
  eq(shared, Array(5).fill('shared\n'), 'пять одновременных одинаковых запросов получают один ответ');
  eq(relCalls('api same'), 1, 'пять одновременных одинаковых запросов -> один запуск gh');
  await ghLib.gh(['api', 'same']);
  eq(relCalls('api same'), 2, 'следующий запрос после завершения снова идёт в gh (это не кэш)');

  // -- неизменяемый ресурс (адресован sha) запоминается
  ghFixtures({ 'api by-sha': { code: 0, stdout: 'frozen\n' } }, home);
  await ghLib.gh(['api', 'by-sha'], { immutable: true });
  eq(await ghLib.gh(['api', 'by-sha'], { immutable: true }), 'frozen\n', 'immutable: повторный ответ тот же');
  eq(relCalls('api by-sha'), 1, 'immutable: повторный запрос не запускает gh');

  // -- ограничение числа одновременных gh
  const limiter = ghLib.createLimiter(() => 3);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      })
    )
  );
  eq(peak, 3, 'ограничитель: одновременно идёт ровно столько задач, сколько разрешено');
  const afterThrow = await rejection(limiter.run(() => Promise.reject(new Error('boom'))));
  ok(
    afterThrow && (await limiter.run(async () => 'next')) === 'next',
    'ограничитель: упавшая задача освобождает место'
  );

  const spanLog = path.join(home, 'gh-spans.log');
  process.env.LOCAL_REVIEW_GH_SPAN_LOG = spanLog;
  ghFixtures({ '*': { code: 0, stdout: 'x\n', delayMs: 250 } }, home);
  ghLib.configure({ maxConcurrent: 3 });
  await Promise.all(Array.from({ length: 9 }, (_, i) => ghLib.gh(['api', `burst-${i}`])));
  delete process.env.LOCAL_REVIEW_GH_SPAN_LOG;
  let running = 0;
  let maxRunning = 0;
  fs.readFileSync(spanLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '))
    .sort((a, b) => Number(a[1]) - Number(b[1]) || (a[0] === 'end' ? -1 : 1))
    .forEach(([edge]) => {
      running += edge === 'start' ? 1 : -1;
      maxRunning = Math.max(maxRunning, running);
    });
  eq(relCalls('api burst-'), 9, 'все девять запросов дошли до gh');
  ok(maxRunning <= 3, 'одновременных gh не больше лимита (3)', `пик ${maxRunning}`);
  ok(maxRunning >= 2, 'при этом запросы действительно идут параллельно', `пик ${maxRunning}`);
  ghLib.configure({ maxConcurrent: restoreGh.maxConcurrent });

  // -- насквозь: лента открывает несколько файлов PR-а сразу
  const REL_BASE = 'relBaseSha';
  const REL_HEAD = 'relHeadSha';
  const REL_MB = 'relMergeBaseSha';
  const relMeta =
    'pr view 77 --repo o/r --json number,title,author,state,isDraft,headRefName,baseRefName,headRefOid,url';
  ghFixtures(
    {
      'pr diff 77 --repo o/r': { code: 0, stdout: PR_DIFF, delayMs: 150 },
      [relMeta]: {
        code: 0,
        stdout: JSON.stringify({
          number: 77,
          title: 'rel',
          author: { login: 'a' },
          state: 'OPEN',
          headRefName: 'h',
          baseRefName: 'b',
          headRefOid: REL_HEAD,
          url: 'u',
        }),
      },
      'pr view 77 --repo o/r --json baseRefOid,headRefOid': {
        code: 0,
        stdout: JSON.stringify({ baseRefOid: REL_BASE, headRefOid: REL_HEAD }),
        delayMs: 150,
      },
      [`api repos/o/r/compare/${REL_BASE}...${REL_HEAD}`]: {
        code: 0,
        stdout: JSON.stringify({ merge_base_commit: { sha: REL_MB } }),
        delayMs: 150,
      },
      [ghContentsKey('src/app.js', REL_MB)]: [DIAL, { code: 0, stdout: 'old app\n' }],
      [ghContentsKey('src/app.js', REL_HEAD)]: { code: 0, stdout: 'new app\n' },
      [ghContentsKey('created.txt', REL_MB)]: { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
      [ghContentsKey('created.txt', REL_HEAD)]: { code: 0, stdout: 'created\n' },
      [ghContentsKey('gone.txt', REL_MB)]: { code: 0, stdout: 'gone\n' },
      [ghContentsKey('gone.txt', REL_HEAD)]: { code: 1, stderr: 'gh: Not Found (HTTP 404)\n' },
    },
    home
  );
  const relQ = 'source=pr&host=github.com&owner=o&repo=r&number=77';
  const relDiffs = await Promise.all(
    ['src/app.js', 'created.txt', 'gone.txt', 'src/app.js'].map((f) =>
      call(`/api/diff?file=${encodeURIComponent(f)}&${relQ}`)
    )
  );
  ok(
    relDiffs.every((r) => r.status === 200),
    'четыре одновременных /api/diff по PR-у -> все 200',
    JSON.stringify(relDiffs.map((r) => [r.status, r.body.error]))
  );
  eq(relDiffs[0].body.oldText, 'old app\n', 'временный сбой на содержимом файла пережит повтором');
  eq(relCalls('pr diff 77'), 1, 'одновременные /api/diff -> один gh pr diff');
  eq(relCalls('pr view 77 --repo o/r --json baseRefOid'), 1, 'одновременные /api/diff -> один gh pr view за sha');
  eq(relCalls(`compare/${REL_BASE}...${REL_HEAD}`), 1, 'одновременные /api/diff -> один compare за merge-base');
  eq(
    relCalls(`contents/created.txt?ref=${REL_MB}`),
    1,
    '404 на содержимом (файла нет на этой стороне) не повторяется'
  );

  await call(`/api/state?${relQ}`);
  await call(`/api/state?${relQ}`);
  eq(relCalls(relMeta), 1, 'шапка PR-а кэшируется: второй /api/state не запускает gh pr view');
  await call(`/api/state?${relQ}&fresh=1`);
  eq(relCalls(relMeta), 2, 'fresh=1 перечитывает шапку PR-а');
  await call(`/api/diff?file=${encodeURIComponent('created.txt')}&${relQ}&fresh=1`);
  eq(relCalls('pr view 77 --repo o/r --json baseRefOid'), 2, 'fresh=1 заново спрашивает sha концов PR-а');
  eq(
    relCalls(`compare/${REL_BASE}...${REL_HEAD}`),
    1,
    'merge-base тех же двух sha не перезапрашивается: он неизменяем'
  );

  ghFixtures({ '*': { code: 1, stderr: 'dial tcp: lookup api.github.com: no such host\n' } }, home);
  const offline = await call('/api/state?source=pr&host=github.com&owner=o&repo=r&number=78');
  ok(
    offline.status === 502 && /нет связи/i.test(offline.body.error),
    'нет сети -> 502 и «нет связи»',
    JSON.stringify(offline.body)
  );
  ghFixtures({ '*': { code: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)\n' } }, home);
  const limited = await call('/api/state?source=pr&host=github.com&owner=o&repo=r&number=79');
  ok(
    limited.status === 429 && /лимит/i.test(limited.body.error),
    'лимит API -> 429 и сообщение про лимит',
    JSON.stringify(limited.body)
  );

  delete process.env.LOCAL_REVIEW_GH_CALL_LOG;
  ghLib.configure(restoreGh);
  ghLib.configure({ retryDelaysMs: [0, 0] });

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

  // ------------------------------------------------- общие комментарии
  console.log('\nобщие комментарии (не к строке, а ко всему ревью)');
  const cleanQ = `source=local&root=${encodeURIComponent(clean)}&mode=working`;
  const cleanStoreFile = path.join(clean, '.local-review', 'comments.json');

  // A store written before general comments existed must load untouched and
  // export byte-for-byte the way it always has.
  const legacyStore = {
    version: 1,
    comments: [
      {
        id: 'legacy-2',
        file: 'a.txt',
        startLine: null,
        endLine: null,
        text: 'к файлу целиком',
        createdAt: '2026-09-01T10:00:01.000Z',
        updatedAt: '2026-09-01T10:00:01.000Z',
      },
      {
        id: 'legacy-1',
        file: 'a.txt',
        startLine: 1,
        endLine: 1,
        text: 'к строке',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
      },
    ],
  };
  const legacyRaw = JSON.stringify(legacyStore, null, 2);
  fs.mkdirSync(path.dirname(cleanStoreFile), { recursive: true });
  fs.writeFileSync(cleanStoreFile, legacyRaw, 'utf8');
  const LEGACY_EXPORT = 'a.txt\nк файлу целиком\n\na.txt:L1\nк строке\n';

  eq(
    (await call(`/api/comments?${cleanQ}`)).body.comments,
    legacyStore.comments,
    'старый файл хранилища без общих комментариев читается как есть'
  );
  eq((await call(`/api/export/text?${cleanQ}`)).body, LEGACY_EXPORT, 'экспорт старого хранилища байт в байт прежний');
  eq(fs.readFileSync(cleanStoreFile, 'utf8'), legacyRaw, 'чтение и экспорт не переписали старый файл');

  const g1 = await call(`/api/comments?${cleanQ}`, json('POST', { general: true, text: '  Первый общий  ' }));
  ok(g1.status === 201, 'POST общего комментария -> 201', JSON.stringify(g1.body));
  eq(
    g1.body.comment && [g1.body.comment.file, g1.body.comment.startLine, g1.body.comment.endLine, g1.body.comment.text],
    [null, null, null, 'Первый общий'],
    'у общего комментария нет файла и строк, текст обрезан'
  );
  const g2 = await call(`/api/comments?${cleanQ}`, json('POST', { general: true, text: 'Второй общий\n\nв два абзаца' }));
  const g3 = await call(`/api/comments?${cleanQ}`, json('POST', { general: true, text: 'Третий, будет удалён' }));
  ok(g2.status === 201 && g3.status === 201, 'можно оставить несколько общих комментариев');

  const gEmpty = await call(`/api/comments?${cleanQ}`, json('POST', { general: true, text: '  ' }));
  ok(gEmpty.status === 400, 'пустой общий комментарий отклоняется', JSON.stringify(gEmpty.body));
  const gWithFile = await call(`/api/comments?${cleanQ}`, json('POST', { general: true, file: 'a.txt', text: 'x' }));
  ok(gWithFile.status === 400, 'общий комментарий с file -> 400 (или файл, или общий)', JSON.stringify(gWithFile.body));
  const gTruthy = await call(`/api/comments?${cleanQ}`, json('POST', { general: 'true', text: 'x' }));
  ok(gTruthy.status === 400, 'general:"true" (строка) не делает комментарий общим -> 400 без file');

  const gEdit = await call(`/api/comments/${g1.body.comment.id}?${cleanQ}`, json('PUT', { text: 'Первый общий, исправлен' }));
  ok(gEdit.status === 200 && gEdit.body.comment.file === null, 'PUT общего комментария -> 200, остаётся общим');
  const gDel = await call(`/api/comments/${g3.body.comment.id}?${cleanQ}`, { method: 'DELETE' });
  ok(gDel.status === 200, 'DELETE общего комментария -> 200');

  const gList = (await call(`/api/comments?${cleanQ}`)).body.comments;
  eq(gList.length, 4, 'после правок: 2 старых + 2 общих');
  const gState = await call(`/api/state?${cleanQ}`);
  eq(gState.body.totalComments, 4, 'общие комментарии входят в общий счётчик');
  eq(gState.body.orphanFiles, [{ path: 'a.txt', comments: 2, orphan: true }], 'общий комментарий не становится «файлом вне диффа»');

  const onDiskGeneral = JSON.parse(fs.readFileSync(cleanStoreFile, 'utf8'));
  eq(onDiskGeneral.version, 1, 'версия формата хранилища не менялась');
  eq(
    onDiskGeneral.comments.filter((c) => c.file === null).map((c) => c.text),
    ['Первый общий, исправлен', 'Второй общий\n\nв два абзаца'],
    'общие комментарии лежат в том же файле хранилища'
  );

  const gIdsBefore = gList.map((c) => c.id).sort();
  const gText1 = await call(`/api/export/text?${cleanQ}`);
  const gFile = await call(`/api/export/file?${cleanQ}`, { method: 'POST' });
  const gText2 = await call(`/api/export/text?${cleanQ}`);
  eq(
    (await call(`/api/comments?${cleanQ}`)).body.comments.map((c) => c.id).sort(),
    gIdsBefore,
    'инвариант 1: экспорт с общими комментариями их не меняет'
  );
  eq(gFile.body.count, 4, 'экспорт в файл считает и общие комментарии');
  const GENERAL_EXPORT =
    '## Общие комментарии\n\n' +
    'Первый общий, исправлен\n\n' +
    'Второй общий\n\nв два абзаца\n\n' +
    '## Комментарии к коду\n\n' +
    LEGACY_EXPORT;
  eq(gText1.body, GENERAL_EXPORT, 'экспорт: общие комментарии первыми, под своим заголовком');
  eq(gText2.body, gText1.body, 'повторный экспорт даёт тот же текст');
  eq(fs.readFileSync(gFile.body.path, 'utf8'), gText1.body, '.md и буфер совпадают и с общими комментариями');
  fs.rmSync(gFile.body.path, { force: true });

  const { renderMarkdown } = require('./lib/export');
  eq(
    renderMarkdown([{ id: 'g', file: null, startLine: null, endLine: null, text: 'Только общий', createdAt: 'x' }]),
    '## Общие комментарии\n\nТолько общий\n',
    'экспорт только с общими комментариями — без пустого раздела кода'
  );
  eq(renderMarkdown([]), '', 'пустое хранилище по-прежнему экспортируется в пустую строку');

  // PR mode: same store, same endpoints, only the descriptor differs.
  const prGeneralQ = 'source=pr&host=github.com&owner=o&repo=r&number=26';
  const prGeneral = await call(`/api/comments?${prGeneralQ}`, json('POST', { general: true, text: 'Общий к PR-у' }));
  ok(prGeneral.status === 201, 'PR: общий комментарий создаётся', JSON.stringify(prGeneral.body));
  eq(
    (await call(`/api/export/text?${prGeneralQ}`)).body,
    '## Общие комментарии\n\nОбщий к PR-у\n',
    'PR: общий комментарий попадает в экспорт'
  );
  ok(
    JSON.parse(fs.readFileSync(path.join(home, 'pr', 'github.com__o__r__26.json'), 'utf8')).comments[0].file === null,
    'PR: общий комментарий лежит в PR-хранилище'
  );

  // ------------------------------------------------------ copy prompt (#28)
  console.log('\nпромпт при копировании');
  const settings0 = await call('/api/settings');
  ok(settings0.status === 200 && settings0.body.copyPrompt === '', 'GET /api/settings: по умолчанию промпт пустой', JSON.stringify(settings0.body));
  const badSettings = await call('/api/settings', json('PUT', { copyPrompt: 42 }));
  eq(badSettings.status, 400, 'PUT /api/settings: не строка -> 400');
  const emptyPatch = await call('/api/settings', json('PUT', {}));
  eq(emptyPatch.status, 400, 'PUT /api/settings без copyPrompt -> 400');

  // ------------------------------------------------------ горячие клавиши (#22)
  eq(JSON.stringify(settings0.body.keybindings), '{"zen":"","commentsPanel":"","viewedFile":"Alt+V","viewMode":"Alt+A","definition":"F12","references":"Shift+F12","implementation":"Ctrl+F12","callHierarchy":"Alt+Shift+H","navBack":"Alt+Left","navForward":"Alt+Right"}',
    'GET /api/settings: по умолчанию заданы клавиши «просмотрено», режима просмотра и навигации по коду');
  eq((await call('/api/settings', json('PUT', { keybindings: { нет: 'Ctrl+K' } }))).status, 400,
    'PUT /api/settings: неизвестное действие -> 400');
  eq((await call('/api/settings', json('PUT', { keybindings: { zen: 42 } }))).status, 400,
    'PUT /api/settings: сочетание не строка -> 400');
  eq((await call('/api/settings', json('PUT', { keybindings: 'Ctrl+K' }))).status, 400,
    'PUT /api/settings: keybindings не объект -> 400');
  const boundZen = await call('/api/settings', json('PUT', { keybindings: { zen: 'Ctrl+Shift+F' } }));
  eq(boundZen.body.keybindings.zen, 'Ctrl+Shift+F', 'PUT /api/settings: сочетание сохранено');
  eq((await call('/api/settings')).body.keybindings.zen, 'Ctrl+Shift+F', 'сочетание читается обратно');
  const boundPanel = await call('/api/settings', json('PUT', { keybindings: { commentsPanel: 'Alt+C' } }));
  eq(boundPanel.body.keybindings, { zen: 'Ctrl+Shift+F', commentsPanel: 'Alt+C', viewedFile: 'Alt+V', viewMode: 'Alt+A', definition: 'F12', references: 'Shift+F12', implementation: 'Ctrl+F12', callHierarchy: 'Alt+Shift+H', navBack: 'Alt+Left', navForward: 'Alt+Right' },
    'клавиша панели комментариев сохраняется рядом с Zen');
  const clearedViewed = await call('/api/settings', json('PUT', { keybindings: { viewedFile: '' } }));
  eq(clearedViewed.body.keybindings.viewedFile, '', 'клавишу по умолчанию можно снять');
  eq((await call('/api/settings')).body.keybindings.viewedFile, '', 'снятая клавиша по умолчанию не возвращается');
  await call('/api/settings', json('PUT', { keybindings: { zen: '', commentsPanel: '', viewedFile: 'Alt+V' } }));

  // ------------------------------------------------ режим просмотра по умолчанию
  eq(settings0.body.defaultViewMode, 'all', 'GET /api/settings: по умолчанию режим просмотра — все файлы');
  for (const bad of ['grid', '', 42, null]) {
    const res = await call('/api/settings', json('PUT', { defaultViewMode: bad }));
    ok(
      res.status === 400 && /defaultViewMode/.test(res.body.error),
      `PUT /api/settings: defaultViewMode ${JSON.stringify(bad)} -> 400`,
      JSON.stringify(res.body)
    );
  }
  eq((await call('/api/settings')).body.defaultViewMode, 'all', 'отклонённое значение ничего не поменяло');
  const toSingle = await call('/api/settings', json('PUT', { defaultViewMode: 'single' }));
  ok(toSingle.status === 200 && toSingle.body.defaultViewMode === 'single', 'PUT /api/settings: single сохранён',
    JSON.stringify(toSingle.body));
  eq(
    (await call('/api/settings')).body,
    {
      copyPrompt: '',
      gitignoreTarget: 'project',
      keybindings: { zen: '', commentsPanel: '', viewedFile: 'Alt+V', viewMode: 'Alt+A', definition: 'F12', references: 'Shift+F12', implementation: 'Ctrl+F12', callHierarchy: 'Alt+Shift+H', navBack: 'Alt+Left', navForward: 'Alt+Right' },
      defaultViewMode: 'single',
      renderModeForAllFiles: true,
    },
    'режим просмотра читается обратно и не трогает остальные настройки'
  );
  await call('/api/settings', json('PUT', { keybindings: { viewMode: 'Alt+M' } }));
  eq((await call('/api/settings')).body.defaultViewMode, 'single', 'патч другой настройки режим просмотра не сбрасывает');
  // A hand-edited file with a value the tool does not know reads as the default.
  const settingsFile = path.join(home, 'settings.json');
  const settingsOnDisk = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(settingsOnDisk), defaultViewMode: 'grid' }), 'utf8');
  eq((await call('/api/settings')).body.defaultViewMode, 'all', 'чужое значение в settings.json читается как умолчание');
  fs.writeFileSync(settingsFile, settingsOnDisk, 'utf8');
  await call('/api/settings', json('PUT', { defaultViewMode: 'all', keybindings: { viewMode: 'Alt+A' } }));

  // ------------------------------------------------ вид файла: для всех файлов
  eq(settings0.body.renderModeForAllFiles, true, 'GET /api/settings: по умолчанию вид файла общий для всех файлов');
  for (const bad of ['false', 0, null, {}]) {
    const res = await call('/api/settings', json('PUT', { renderModeForAllFiles: bad }));
    ok(
      res.status === 400 && /renderModeForAllFiles/.test(res.body.error),
      `PUT /api/settings: renderModeForAllFiles ${JSON.stringify(bad)} -> 400`,
      JSON.stringify(res.body)
    );
  }
  eq((await call('/api/settings')).body.renderModeForAllFiles, true, 'отклонённое значение вид файла не поменяло');
  const perFile = await call('/api/settings', json('PUT', { renderModeForAllFiles: false }));
  ok(perFile.status === 200 && perFile.body.renderModeForAllFiles === false, 'PUT /api/settings: вид файла по отдельности сохранён',
    JSON.stringify(perFile.body));
  eq((await call('/api/settings')).body.renderModeForAllFiles, false, 'вид файла по отдельности читается обратно');
  await call('/api/settings', json('PUT', { defaultViewMode: 'single' }));
  eq((await call('/api/settings')).body.renderModeForAllFiles, false, 'патч другой настройки вид файла не сбрасывает');
  // A hand-edited file with something that is not a boolean reads as the default.
  const renderOnDisk = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(renderOnDisk), renderModeForAllFiles: 'no' }), 'utf8');
  eq((await call('/api/settings')).body.renderModeForAllFiles, true, 'не булево значение в settings.json читается как умолчание');
  fs.writeFileSync(settingsFile, renderOnDisk, 'utf8');
  await call('/api/settings', json('PUT', { defaultViewMode: 'all', renderModeForAllFiles: true }));

  const saved = await call('/api/settings', json('PUT', { copyPrompt: '  Исправь замечания ниже.\r\nПо одному коммиту.\n\n' }));
  ok(saved.status === 200, 'PUT /api/settings -> 200', JSON.stringify(saved.body));
  ok(fs.existsSync(path.join(home, 'settings.json')), 'промпт лежит в <home>/settings.json');
  // Choosing a screen rewrites state.json; the prompt must survive that.
  await call('/api/session', json('POST', { descriptor: { source: 'pr', host: 'github.com', owner: 'o', repo: 'r', number: 26 } }));
  eq((await call('/api/settings')).body.copyPrompt, '  Исправь замечания ниже.\r\nПо одному коммиту.\n\n', 'промпт переживает запись сессии');

  const WITH_PROMPT = GENERAL_EXPORT + '\nИсправь замечания ниже.\nПо одному коммиту.\n';
  const pText = await call(`/api/export/text?${cleanQ}`);
  eq(pText.body, WITH_PROMPT, 'буфер: комментарии, пустая строка, промпт в конце');
  const pFile = await call(`/api/export/file?${cleanQ}`, { method: 'POST' });
  eq(fs.readFileSync(pFile.body.path, 'utf8'), WITH_PROMPT, '.md-файл содержит тот же промпт, что и буфер');
  fs.rmSync(pFile.body.path, { force: true });
  eq(
    (await call(`/api/comments?${cleanQ}`)).body.comments.map((c) => c.id).sort(),
    gIdsBefore,
    'инвариант 1: экспорт с промптом комментарии не меняет'
  );

  const { exportMarkdown } = require('./lib/export');
  eq(exportMarkdown([], 'Промпт'), 'Промпт\n', 'промпт без комментариев — только промпт');
  eq(
    exportMarkdown([{ id: 'g', file: null, startLine: null, endLine: null, text: 'Только общий', createdAt: 'x' }], ' \n '),
    '## Общие комментарии\n\nТолько общий\n',
    'пробельный промпт текст не меняет'
  );

  await call('/api/settings', json('PUT', { copyPrompt: '' }));
  eq((await call(`/api/export/text?${cleanQ}`)).body, GENERAL_EXPORT, 'очищенный промпт: экспорт снова байт в байт прежний');

  const gCleared = await call(`/api/comments/clear-all?${cleanQ}`, json('POST', { confirm: true }));
  eq(gCleared.body.removed, 4, '«Очистить всё» удаляет и общие комментарии');

  // ------------------------------------------------ просмотренные файлы
  console.log('\nпросмотренные файлы: отметка живёт, пока не изменился дифф файла');
  const viewedRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-viewed-'));
  git(['init', '-q', '-b', 'main'], viewedRepo);
  git(['config', 'user.email', 'smoke@example.com'], viewedRepo);
  git(['config', 'user.name', 'Smoke Test'], viewedRepo);
  git(['config', 'commit.gpgsign', 'false'], viewedRepo);
  git(['config', 'core.autocrlf', 'false'], viewedRepo);
  write(viewedRepo, '.gitignore', '.local-review/\n');
  write(viewedRepo, 'one.txt', 'one\n');
  write(viewedRepo, 'two.txt', 'two\n');
  write(viewedRepo, 'gone.txt', 'gone\n');
  git(['add', '-A'], viewedRepo);
  git(['commit', '-q', '-m', 'init'], viewedRepo);
  write(viewedRepo, 'one.txt', 'one\nedited\n');
  write(viewedRepo, 'two.txt', 'two\nedited\n');
  write(viewedRepo, 'new file.txt', 'новый\n');
  fs.unlinkSync(path.join(viewedRepo, 'gone.txt'));

  const vQ = (mode, base) =>
    `source=local&root=${encodeURIComponent(viewedRepo)}&mode=${mode || 'working'}` + (base ? `&base=${base}` : '');
  const vStoreFile = path.join(viewedRepo, '.local-review', 'comments.json');
  const vState = async (mode, base) => {
    const res = await call(`/api/state?${vQ(mode, base)}`);
    return new Map(res.body.files.map((f) => [f.path, f]));
  };
  const mark = (file, fingerprint, viewed, mode, base) =>
    call(`/api/viewed?${vQ(mode, base)}`, json('POST', { file, fingerprint, viewed }));

  const v0 = await vState();
  ok(
    [...v0.values()].every((f) => typeof f.fingerprint === 'string' && f.fingerprint.length > 0 && f.viewed === false),
    'у каждого файла есть fingerprint, и сначала ни один не просмотрен',
    JSON.stringify([...v0.values()])
  );
  ok(new Set([...v0.values()].map((f) => f.fingerprint)).size === v0.size, 'у разных файлов разные fingerprint');
  const v0again = await vState();
  ok(
    [...v0.keys()].every((p) => v0again.get(p).fingerprint === v0.get(p).fingerprint),
    'fingerprint стабилен, пока ничего не менялось'
  );

  for (const p of ['one.txt', 'two.txt', 'new file.txt', 'gone.txt']) {
    const res = await mark(p, v0.get(p).fingerprint, true);
    ok(res.status === 200 && res.body.viewed === true, `отметка «просмотрено»: ${p}`, JSON.stringify(res.body));
  }
  const v1 = await vState();
  ok([...v1.values()].every((f) => f.viewed === true), 'после отметки все четыре файла просмотрены');
  ok(!fs.existsSync(path.join(viewedRepo, 'pr')), 'отметки не создают ничего, кроме файла хранилища');
  const vOnDisk = JSON.parse(fs.readFileSync(vStoreFile, 'utf8'));
  eq(vOnDisk.version, 1, 'просмотренные файлы не меняют версию формата хранилища');
  eq(
    ((vOnDisk.viewed['one.txt'] || {})['mode:working'] || {}).fingerprint,
    v0.get('one.txt').fingerprint,
    'в хранилище лежит fingerprint отмеченного диффа, в корзине своего режима'
  );

  // Invalidation: new content in one file resets only that file.
  write(viewedRepo, 'one.txt', 'one\nedited again\n');
  write(viewedRepo, 'new file.txt', 'новый\nи ещё строка\n');
  const v2 = await vState();
  ok(v2.get('one.txt').viewed === false, 'изменённый файл снова не просмотрен');
  ok(v2.get('one.txt').fingerprint !== v0.get('one.txt').fingerprint, 'у изменённого файла новый fingerprint');
  ok(v2.get('new file.txt').viewed === false, 'изменённый untracked-файл снова не просмотрен');
  ok(v2.get('two.txt').viewed === true && v2.get('gone.txt').viewed === true, 'соседние неизменённые файлы остаются просмотренными');

  // A new commit under an unchanged worktree file: the new side is the same
  // blob, but HEAD (the old side) moved, so the diff is a different one.
  write(viewedRepo, 'two.txt', 'two\ncommitted in between\n');
  git(['add', 'two.txt'], viewedRepo);
  git(['commit', '-q', '-m', 'commit two'], viewedRepo);
  write(viewedRepo, 'two.txt', 'two\nedited\n');
  const v3 = await vState();
  ok(v3.get('two.txt').viewed === false, 'новый коммит под тем же содержимым файла сбрасывает отметку (сменилась старая сторона)');

  // Staging alone does not change the file's content: working and staged agree.
  const oneWorking = (await vState()).get('one.txt');
  await mark('one.txt', oneWorking.fingerprint, true);
  git(['add', 'one.txt'], viewedRepo);
  ok((await vState()).get('one.txt').viewed === true, 'git add без правок не сбрасывает отметку в working');
  ok(
    (await vState('staged')).get('one.txt').viewed === false,
    'staged — отдельный режим: отметка из working туда не переносится'
  );

  const unmark = await mark('one.txt', undefined, false);
  ok(unmark.status === 200 && unmark.body.viewed === false, 'снятие отметки -> 200');
  ok((await vState()).get('one.txt').viewed === false, 'после снятия отметки файл не просмотрен');
  ok((await mark('one.txt', undefined, false)).status === 200, 'повторное снятие отметки — не ошибка');

  for (const [body, label] of [
    [{ viewed: true, fingerprint: 'x' }, 'без file'],
    [{ file: 'one.txt', viewed: true }, 'viewed:true без fingerprint'],
    [{ file: 'one.txt', viewed: 'true', fingerprint: 'x' }, 'viewed:"true" (строка)'],
    [{ file: '__proto__', viewed: true, fingerprint: 'x' }, 'file = __proto__'],
  ]) {
    const res = await call(`/api/viewed?${vQ()}`, json('POST', body));
    ok(res.status === 400, `POST /api/viewed ${label} -> 400`, JSON.stringify(res.body));
  }

  // Comments and viewed marks share the store but not a lifecycle.
  await call(`/api/comments?${vQ()}`, json('POST', { file: 'two.txt', startLine: 1, endLine: 1, text: 'к two' }));
  const twoNow = (await vState()).get('two.txt');
  await mark('two.txt', twoNow.fingerprint, true);
  await call(`/api/comments/clear-all?${vQ()}`, json('POST', { confirm: true }));
  ok((await vState()).get('two.txt').viewed === true, '«Очистить всё» удаляет комментарии, но не отметки');
  eq(JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).comments, [], 'комментарии из хранилища удалены');

  // --- отметки живут отдельно в каждом режиме -----------------------------
  console.log('\nпросмотренные файлы: у каждого режима свои отметки');
  const twoWorking = (await vState()).get('two.txt');
  await mark('two.txt', twoWorking.fingerprint, true);
  ok((await vState()).get('two.txt').viewed === true, 'two.txt отмечен в working');
  const twoBase = (await vState('base', 'HEAD~1')).get('two.txt');
  ok(twoBase.viewed === false, 'в режиме base тот же файл ещё не просмотрен');
  ok(twoBase.fingerprint !== twoWorking.fingerprint, 'у base свой дифф — свой fingerprint');

  await mark('two.txt', twoBase.fingerprint, true, 'base', 'HEAD~1');
  ok((await vState('base', 'HEAD~1')).get('two.txt').viewed === true, 'отметка в base поставлена');
  ok((await vState()).get('two.txt').viewed === true, 'отметка в base не стёрла отметку в working');
  eq(
    Object.keys(JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).viewed['two.txt']).sort(),
    ['mode:base:HEAD~1', 'mode:working'],
    'в хранилище у файла по корзине на режим'
  );

  await mark('two.txt', undefined, false, 'base', 'HEAD~1');
  ok((await vState('base', 'HEAD~1')).get('two.txt').viewed === false, 'снятие отметки в base сработало');
  ok((await vState()).get('two.txt').viewed === true, 'снятие отметки в base не трогает working');
  await mark('two.txt', undefined, false);

  // --- base: у каждой базы свой вид, но пустая база = ветка по умолчанию ---
  console.log('\nпросмотренные файлы: у режима base ключ по разрешённой базе');
  // Без base сервер берёт ветку по умолчанию этого репозитория; он же
  // возвращает её в ответе, так что явное имя должно давать тот же ключ.
  const defaultBaseState = await call(`/api/state?${vQ('base')}`);
  const defaultBaseRev = defaultBaseState.body.base;
  ok(Boolean(defaultBaseRev), 'сервер сообщает, какую базу выбрал сам', JSON.stringify(defaultBaseRev));
  const twoDefaultBase = new Map(defaultBaseState.body.files.map((f) => [f.path, f])).get('two.txt');

  await mark('two.txt', twoDefaultBase.fingerprint, true, 'base');
  ok((await vState('base')).get('two.txt').viewed === true, 'отметка при пустой базе поставлена');
  ok(
    (await vState('base', defaultBaseRev)).get('two.txt').viewed === true,
    'та же отметка видна, если ту же базу назвать явно'
  );
  eq(
    Object.keys(JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).viewed['two.txt']),
    [`mode:base:${defaultBaseRev}`],
    'ключ вида содержит разрешённую базу, а не пустую строку'
  );

  const twoOtherBase = (await vState('base', 'HEAD~1')).get('two.txt');
  ok(twoOtherBase.viewed === false, 'под другой базой файл ещё не просмотрен');
  await mark('two.txt', twoOtherBase.fingerprint, true, 'base', 'HEAD~1');
  ok((await vState('base', 'HEAD~1')).get('two.txt').viewed === true, 'отметка под другой базой поставлена');
  ok((await vState('base')).get('two.txt').viewed === true, 'отметка под другой базой не стёрла отметку базы по умолчанию');
  ok(
    (await vState('base', defaultBaseRev)).get('two.txt').viewed === true &&
      (await vState('base', 'HEAD~1')).get('two.txt').viewed === true,
    'обе отметки живы при переключении баз туда-обратно'
  );
  eq(
    Object.keys(JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).viewed['two.txt']).sort(),
    [`mode:base:${defaultBaseRev}`, 'mode:base:HEAD~1'].sort(),
    'в хранилище по корзине на базу'
  );

  await mark('two.txt', undefined, false, 'base');
  ok((await vState('base', defaultBaseRev)).get('two.txt').viewed === false, 'снятие при пустой базе сняло и явную');
  await mark('two.txt', undefined, false, 'base', 'HEAD~1');

  // --- отметки из старого, «плоского» формата хранилища --------------------
  console.log('\nпросмотренные файлы: миграция старого формата');
  const legacyTwo = (await vState()).get('two.txt');
  const legacyStoreData = JSON.parse(fs.readFileSync(vStoreFile, 'utf8'));
  legacyStoreData.viewed = { 'two.txt': { fingerprint: legacyTwo.fingerprint, viewedAt: '2026-09-01T00:00:00.000Z' } };
  fs.writeFileSync(vStoreFile, JSON.stringify(legacyStoreData, null, 2), 'utf8');
  ok((await vState()).get('two.txt').viewed === true, 'старая отметка действует в режиме, где её ставили');
  ok(
    (await vState('base', 'HEAD~1')).get('two.txt').viewed === false,
    'старая отметка не действует в режиме с другим диффом'
  );
  const legacyBase = (await vState('base', 'HEAD~1')).get('two.txt');
  await mark('two.txt', legacyBase.fingerprint, true, 'base', 'HEAD~1');
  const afterLegacyMark = JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).viewed['two.txt'];
  eq(
    Object.keys(afterLegacyMark).sort(),
    ['*', 'mode:base:HEAD~1'],
    'старая отметка переехала в корзину «любой режим» и не потерялась'
  );
  ok((await vState()).get('two.txt').viewed === true, 'после отметки в base старая отметка в working жива');
  eq(JSON.parse(fs.readFileSync(vStoreFile, 'utf8')).version, 1, 'миграция не меняет версию формата хранилища');
  await mark('two.txt', undefined, false);
  ok(
    (await vState()).get('two.txt').viewed === false && (await vState('base', 'HEAD~1')).get('two.txt').viewed === true,
    'снятие отметки в working убирает и старую отметку, но не отметку другого режима'
  );
  await mark('two.txt', undefined, false, 'base', 'HEAD~1');

  const { fingerprintOf, isViewed, modeKeyOf } = require('./lib/viewed');
  eq(modeKeyOf({ source: 'local', mode: 'working', base: '' }), 'mode:working', 'ключ режима working');
  eq(modeKeyOf({ source: 'local', mode: 'base', base: '' }, 'main'), 'mode:base:main', 'ключ режима base — по разрешённой базе');
  eq(
    modeKeyOf({ source: 'local', mode: 'base', base: 'main' }, 'main'),
    modeKeyOf({ source: 'local', mode: 'base', base: '' }, 'main'),
    'пустая и явно названная база дают один ключ'
  );
  ok(
    modeKeyOf({ source: 'local', mode: 'base', base: '' }, 'main') !==
      modeKeyOf({ source: 'local', mode: 'base', base: '' }, 'origin/production'),
    'разные базы — разные ключи'
  );
  eq(modeKeyOf({ source: 'pr', number: 25 }), 'pr:all', 'ключ PR-а без диапазона');
  eq(modeKeyOf({ source: 'local', mode: 'commits', from: 'a1', to: 'b2' }), 'commits:a1..b2', 'ключ диапазона коммитов');
  ok(
    modeKeyOf({ source: 'pr', number: 25, from: 'a1', to: 'b2' }) !== modeKeyOf({ source: 'pr', number: 25, from: 'a1', to: 'c3' }),
    'разные диапазоны коммитов — разные ключи'
  );
  ok(isViewed({ 'mode:working': { fingerprint: 'a' } }, 'mode:working', 'a') === true, 'isViewed: отметка своего режима');
  ok(isViewed({ 'mode:working': { fingerprint: 'a' } }, 'mode:base', 'a') === false, 'isViewed: отметка чужого режима не считается');
  ok(isViewed({ '*': { fingerprint: 'a' } }, 'mode:base', 'a') === true, 'isViewed: отметка из старого формата подходит любому режиму');

  ok(isViewed({ 'mode:working': { fingerprint: 'a' } }, 'mode:working', 'b') === false, 'isViewed: другой fingerprint -> не просмотрен');
  ok(
    isViewed(undefined, 'mode:working', 'a') === false && isViewed({ 'mode:working': { fingerprint: '' } }, 'mode:working', '') === false,
    'isViewed: нет отметки или пустой fingerprint -> не просмотрен'
  );
  ok(fingerprintOf(['M', null, 'a']) === fingerprintOf(['M', null, 'a']), 'fingerprintOf детерминирован');
  ok(fingerprintOf(['M', 'a', null]) !== fingerprintOf(['M', null, 'a']), 'fingerprintOf различает поля по позиции');

  console.log('\nпросмотренные файлы в PR-режиме');
  const PR_VIEWED_DIFF = (appIndex, appLine) =>
    [
      'diff --git a/src/app.js b/src/app.js',
      `index ${appIndex} 100644`,
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,1 +1,1 @@',
      '-old',
      `+${appLine}`,
      'diff --git a/assets/logo.bin b/assets/logo.bin',
      'index 3333333..4444444 100644',
      'Binary files a/assets/logo.bin and b/assets/logo.bin differ',
      '',
    ].join('\n');
  const prViewedQ = 'source=pr&host=github.com&owner=o&repo=r&number=40';
  const prViewedFixture = (diffText) =>
    ghFixtures({ [viewKeyFor(40)]: prView(40), 'pr diff 40 --repo o/r': { code: 0, stdout: diffText } }, home);
  const prFiles = async () =>
    new Map((await call(`/api/state?${prViewedQ}&fresh=1`)).body.files.map((f) => [f.path, f]));

  prViewedFixture(PR_VIEWED_DIFF('1111111..2222222', 'new'));
  const p0 = await prFiles();
  for (const p of ['src/app.js', 'assets/logo.bin']) {
    await call(`/api/viewed?${prViewedQ}`, json('POST', { file: p, fingerprint: p0.get(p).fingerprint, viewed: true }));
  }
  const p1 = await prFiles();
  ok(p1.get('src/app.js').viewed && p1.get('assets/logo.bin').viewed, 'PR: отмеченные файлы просмотрены');
  ok(
    JSON.parse(fs.readFileSync(path.join(home, 'pr', 'github.com__o__r__40.json'), 'utf8')).viewed['src/app.js'],
    'PR: отметка лежит в PR-хранилище'
  );

  // The author pushes: app.js gets a new line, the binary is untouched.
  prViewedFixture(PR_VIEWED_DIFF('1111111..5555555', 'newer'));
  const p2 = await prFiles();
  ok(p2.get('src/app.js').viewed === false, 'PR: после нового пуша изменённый файл снова не просмотрен');
  ok(p2.get('assets/logo.bin').viewed === true, 'PR: неизменённый в пуше файл остаётся просмотренным');
  // Same patch text, different blob (e.g. a binary replaced): header decides.
  prViewedFixture(PR_VIEWED_DIFF('1111111..5555555', 'newer').replace('3333333..4444444', '3333333..6666666'));
  ok((await prFiles()).get('assets/logo.bin').viewed === false, 'PR: бинарный файл с новым blob снова не просмотрен');

  // ------------------------------------- чистка устаревших отметок при старте
  console.log('\nпросмотренные файлы: устаревшие отметки удаляются при старте сервера');
  const pruneRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-prune-'));
  git(['init', '-q', '-b', 'main'], pruneRepo);
  git(['config', 'user.email', 'smoke@example.com'], pruneRepo);
  git(['config', 'user.name', 'Smoke Test'], pruneRepo);
  git(['config', 'commit.gpgsign', 'false'], pruneRepo);
  git(['config', 'core.autocrlf', 'false'], pruneRepo);
  write(pruneRepo, '.gitignore', '.local-review/\n');
  write(pruneRepo, 'a.txt', 'a\n');
  write(pruneRepo, 'b.txt', 'b\n');
  write(pruneRepo, 'c.txt', 'c\n');
  git(['add', '-A'], pruneRepo);
  git(['commit', '-q', '-m', 'init'], pruneRepo);
  write(pruneRepo, 'a.txt', 'a\nsecond\n');
  write(pruneRepo, 'b.txt', 'b\nsecond\n');
  git(['add', '-A'], pruneRepo);
  git(['commit', '-q', '-m', 'second'], pruneRepo);
  const pruneSha = git(['rev-parse', 'HEAD'], pruneRepo).trim();
  write(pruneRepo, 'a.txt', 'a\nsecond\nworking\n');
  write(pruneRepo, 'b.txt', 'b\nsecond\nworking\n');
  write(pruneRepo, 'c.txt', 'c\nstaged\n');
  git(['add', 'c.txt'], pruneRepo);
  write(pruneRepo, 'untracked.txt', 'never added\n');

  const pruneStoreFile = path.join(pruneRepo, '.local-review', 'comments.json');
  const readPruneStore = () => JSON.parse(fs.readFileSync(pruneStoreFile, 'utf8'));
  const startPrune = () => start({ cwd: pruneRepo, mode: 'working', base: '', port: 0, host: '127.0.0.1', open: false });
  const stopServer = (s) => new Promise((resolve) => s.server.close(resolve));
  // No `source` in the query: the descriptor is the repository the server was started in.
  const pruneViews = {
    working: 'mode=working',
    staged: 'mode=staged',
    base: 'mode=base&base=HEAD~1',
    commits: `mode=commits&from=${pruneSha}&to=${pruneSha}`,
  };
  const pruneFiles = async (client, view) =>
    new Map((await client(`/api/state?${pruneViews[view]}`)).body.files.map((f) => [f.path, f]));
  const pruneMark = async (client, view, file) =>
    client(
      `/api/viewed?${pruneViews[view]}`,
      json('POST', { file, fingerprint: (await pruneFiles(client, view)).get(file).fingerprint, viewed: true })
    );

  let pruneServer = await startPrune();
  let pruneCall = makeClient(pruneServer.port);
  eq(await pruneServer.viewedPruning, 0, 'без отметок чистке нечего удалять');
  ok(!fs.existsSync(pruneStoreFile), 'чистка не создаёт файл хранилища');
  for (const [view, file] of [
    ['working', 'a.txt'],
    ['working', 'b.txt'],
    ['working', 'untracked.txt'],
    ['staged', 'c.txt'],
    ['base', 'a.txt'],
    ['base', 'b.txt'],
    ['commits', 'a.txt'],
    ['commits', 'b.txt'],
  ]) {
    const res = await pruneMark(pruneCall, view, file);
    ok(res.status === 200 && res.body.viewed === true, `отметка ${view}: ${file}`, JSON.stringify(res.body));
  }
  await pruneCall('/api/comments?mode=working', json('POST', { file: 'a.txt', startLine: 1, endLine: 1, text: 'остаётся' }));
  await stopServer(pruneServer);

  // Marks no view can ever show again, written the way an old review file has them.
  const DEAD_SHA = 'dead'.repeat(10);
  const staleMark = (fingerprint) => ({ fingerprint, viewedAt: '2026-09-01T00:00:00.000Z' });
  const pruneRangeKey = `commits:${pruneSha}..${pruneSha}`;
  const seeded = readPruneStore();
  seeded.viewed['a.txt'][`commits:${DEAD_SHA}..${DEAD_SHA}`] = staleMark('x1');
  seeded.viewed['b.txt']['mode:base:no-such-branch'] = staleMark('x2');
  seeded.viewed['only-gone-range.txt'] = { [`commits:${DEAD_SHA}..${pruneSha}`]: staleMark('x3') };
  seeded.viewed['left-the-diff.txt'] = { 'mode:working': staleMark('x4'), 'mode:staged': staleMark('x8') };
  // A revision may contain dots of its own; such a range is not taken apart.
  seeded.viewed['symbolic.txt'] = { 'commits:HEAD^{/fix..bug}..HEAD': staleMark('x9') };
  seeded.viewed['legacy.txt'] = staleMark('x5');
  seeded.viewed['foreign.txt'] = { 'pr:all': staleMark('x6'), 'not a view key': staleMark('x7') };
  fs.writeFileSync(pruneStoreFile, JSON.stringify(seeded, null, 2), 'utf8');
  // a.txt changes while the server is down: its working and base diffs are new ones.
  write(pruneRepo, 'a.txt', 'a\nsecond\nworking, edited\n');

  pruneServer = await startPrune();
  pruneCall = makeClient(pruneServer.port);
  eq(await pruneServer.viewedPruning, 7, 'старт сервера удалил семь мёртвых отметок');
  const pruned = readPruneStore();
  eq(
    Object.keys(pruned.viewed['a.txt']),
    [pruneRangeKey],
    'a.txt: отметки изменившихся диффов (working, base) и исчезнувшего диапазона удалены, живая осталась'
  );
  eq(
    Object.keys(pruned.viewed['b.txt']).sort(),
    [pruneRangeKey, 'mode:base:HEAD~1', 'mode:working'].sort(),
    'b.txt: живые отметки на месте, отметка под исчезнувшей базой удалена'
  );
  eq(Object.keys(pruned.viewed['c.txt']), ['mode:staged'], 'c.txt: живая отметка staged на месте');
  eq(Object.keys(pruned.viewed['untracked.txt']), ['mode:working'], 'живая отметка untracked-файла на месте');
  eq(
    Object.keys(pruned.viewed['symbolic.txt']),
    ['commits:HEAD^{/fix..bug}..HEAD'],
    'диапазон, который не разобрать однозначно, не трогается'
  );
  ok(
    !('only-gone-range.txt' in pruned.viewed) && !('left-the-diff.txt' in pruned.viewed),
    'файл без единой оставшейся отметки теряет и свой ключ',
    JSON.stringify(Object.keys(pruned.viewed))
  );
  eq(pruned.viewed['legacy.txt'], { '*': staleMark('x5') }, 'отметка старого формата («любой режим») не трогается');
  eq(
    pruned.viewed['foreign.txt'],
    { 'pr:all': staleMark('x6'), 'not a view key': staleMark('x7') },
    'отметки под ключами, которые git не умеет построить, не трогаются'
  );
  eq(pruned.comments.map((c) => c.text), ['остаётся'], 'чистка не трогает комментарии');
  eq(pruned.version, 1, 'чистка не меняет версию формата хранилища');

  const prunedWorking = await pruneFiles(pruneCall, 'working');
  ok(prunedWorking.get('a.txt').viewed === false, 'изменённый файл не просмотрен');
  ok(prunedWorking.get('b.txt').viewed === true, 'неизменённый файл остаётся просмотренным в working');
  ok((await pruneFiles(pruneCall, 'staged')).get('c.txt').viewed === true, 'неизменённый файл остаётся просмотренным в staged');
  const prunedBase = await pruneFiles(pruneCall, 'base');
  ok(
    prunedBase.get('b.txt').viewed === true && prunedBase.get('a.txt').viewed === false,
    'base: живая отметка действует, удалённая нет'
  );
  const prunedCommits = await pruneFiles(pruneCall, 'commits');
  ok(
    prunedCommits.get('a.txt').viewed === true && prunedCommits.get('b.txt').viewed === true,
    'отметки в диапазоне коммитов остались'
  );

  // The documented trade-off: a deleted mark does not come back with the old content.
  write(pruneRepo, 'a.txt', 'a\nsecond\nworking\n');
  ok(
    (await pruneFiles(pruneCall, 'working')).get('a.txt').viewed === false,
    'файл вернули ровно в прежнее состояние — удалённая отметка не оживает'
  );
  await stopServer(pruneServer);

  // Nothing stale -> nothing written.
  const pruneBytes = fs.readFileSync(pruneStoreFile, 'utf8');
  pruneServer = await startPrune();
  pruneCall = makeClient(pruneServer.port);
  eq(await pruneServer.viewedPruning, 0, 'повторный старт: удалять больше нечего');
  eq(fs.readFileSync(pruneStoreFile, 'utf8'), pruneBytes, 'хранилище без мёртвых отметок не переписывается');

  // A view git cannot build right now is not a view that is gone: keep its marks.
  const { pruneLocalViewed } = require('./lib/viewed-prune');
  const pruneNotRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-prune-norepo-'));
  const notRepoStore = write(
    pruneNotRepo,
    '.local-review/comments.json',
    JSON.stringify(
      {
        version: 1,
        comments: [],
        viewed: {
          'a.txt': { 'mode:working': staleMark('y1'), [pruneRangeKey]: staleMark('y2'), 'mode:base:main': staleMark('y3') },
          'b.txt': { 'mode:working': 'не запись' },
        },
      },
      null,
      2
    )
  );
  const notRepoBytes = fs.readFileSync(notRepoStore, 'utf8');
  eq(await pruneLocalViewed(pruneNotRepo), 0, 'git не отвечает — чистка ничего не удаляет и не падает');
  eq(fs.readFileSync(notRepoStore, 'utf8'), notRepoBytes, 'git не отвечает — файл хранилища не тронут');

  // The sweep must stay off the network even in a partial clone, where git
  // would fetch a missing object on demand: its git calls carry GIT_NO_LAZY_FETCH.
  const { gitTry: gitProbe, localOnly } = require('./lib/git');
  const lazyFetchEnv = () => gitProbe(['-c', 'alias.probe=!echo "lazy=$GIT_NO_LAZY_FETCH"', 'probe'], pruneRepo);
  eq((await localOnly(lazyFetchEnv)).trim(), 'lazy=1', 'git-вызовы чистки запрещают догрузку объектов из сети');
  eq((await lazyFetchEnv()).trim(), 'lazy=', 'остальные git-вызовы запрет не получают');

  console.log('\nпросмотренные файлы: PR-виды чистятся при открытии PR, а не при старте');
  const prStoreFile = path.join(home, 'pr', 'github.com__o__r__40.json');
  // app.js gets a live mark; logo.bin keeps the one its new blob made stale.
  await call(
    `/api/viewed?${prViewedQ}`,
    json('POST', { file: 'src/app.js', fingerprint: (await prFiles()).get('src/app.js').fingerprint, viewed: true })
  );
  const prSeeded = JSON.parse(fs.readFileSync(prStoreFile, 'utf8'));
  ok(Boolean(prSeeded.viewed['assets/logo.bin']['pr:all']), 'PR: мёртвая отметка лежит в хранилище до чистки');
  // Another view of the same PR, not opened below: nobody has its diff, so it stays.
  prSeeded.viewed['src/app.js']['commits:aaa..bbb'] = staleMark('z1');
  fs.writeFileSync(prStoreFile, JSON.stringify(prSeeded, null, 2), 'utf8');
  const prStoreBytes = fs.readFileSync(prStoreFile, 'utf8');

  await stopServer(pruneServer);
  const ghCallLog = path.join(home, 'gh-calls-prune.log');
  process.env.LOCAL_REVIEW_GH_CALL_LOG = ghCallLog;
  pruneServer = await startPrune();
  pruneCall = makeClient(pruneServer.port);
  await pruneServer.viewedPruning;
  ok(!fs.existsSync(ghCallLog), 'старт сервера не вызывает gh', fs.existsSync(ghCallLog) ? fs.readFileSync(ghCallLog, 'utf8') : '');
  eq(fs.readFileSync(prStoreFile, 'utf8'), prStoreBytes, 'старт сервера не трогает PR-хранилище');

  const prOpened = new Map((await pruneCall(`/api/state?${prViewedQ}`)).body.files.map((f) => [f.path, f]));
  delete process.env.LOCAL_REVIEW_GH_CALL_LOG;
  const prPruned = JSON.parse(fs.readFileSync(prStoreFile, 'utf8'));
  ok(
    !('assets/logo.bin' in prPruned.viewed),
    'PR: открытие PR удалило мёртвую отметку вместе с ключом файла',
    JSON.stringify(prPruned.viewed)
  );
  eq(
    Object.keys(prPruned.viewed['src/app.js']).sort(),
    ['commits:aaa..bbb', 'pr:all'],
    'PR: живая отметка и отметка неоткрытого вида остались'
  );
  ok(
    prOpened.get('src/app.js').viewed === true && prOpened.get('assets/logo.bin').viewed === false,
    'PR: живая отметка действует, удалённая нет'
  );
  await stopServer(pruneServer);

  // A PR diff that came back empty says nothing about the marks: they stay.
  const prBeforeEmpty = fs.readFileSync(prStoreFile, 'utf8');
  prViewedFixture('');
  pruneServer = await startPrune();
  const emptyPr = await makeClient(pruneServer.port)(`/api/state?${prViewedQ}&fresh=1`);
  eq(emptyPr.body.files, [], 'PR: дифф пришёл пустым');
  eq(fs.readFileSync(prStoreFile, 'utf8'), prBeforeEmpty, 'PR: пустой дифф отметок не удаляет');
  await stopServer(pruneServer);

  const { localViewOf } = require('./lib/viewed');
  eq(localViewOf('mode:staged'), { mode: 'staged', base: '' }, 'localViewOf: staged');
  eq(localViewOf('mode:base:origin/main'), { mode: 'base', base: 'origin/main' }, 'localViewOf: base с базой');
  eq(localViewOf('commits:a1..b2'), { mode: 'commits', from: 'a1', to: 'b2' }, 'localViewOf: диапазон коммитов');
  ok(
    ['*', 'pr:all', 'mode:base:', 'commits:a1', 'commits:a..b..c', 'commits:a...b', 'commits:..b', 'mode:commits'].every(
      (k) => localViewOf(k) === null
    ),
    'localViewOf: всё, что не ключ локального вида, — null'
  );

  // A mark made again while the sweep was looking is not the mark it judged.
  const { CommentStore } = require('./lib/store');
  const guardFile = write(
    pruneNotRepo,
    'guard.json',
    JSON.stringify({ version: 1, comments: [], viewed: { 'a.txt': { 'mode:working': staleMark('new') } } })
  );
  eq(
    new CommentStore(guardFile).dropViewed([{ file: 'a.txt', modeKey: 'mode:working', fingerprint: 'old' }]),
    0,
    'dropViewed: отметка с другим fingerprint не удаляется'
  );
  eq(
    new CommentStore(guardFile).dropViewed([{ file: 'a.txt', modeKey: 'mode:working', fingerprint: 'new' }]),
    1,
    'dropViewed: отметка с тем же fingerprint удаляется'
  );
  eq(JSON.parse(fs.readFileSync(guardFile, 'utf8')).viewed, {}, 'dropViewed: ключ файла без отметок удалён');

  // ------------------------------------ PR больше 300 файлов (issue #48)
  console.log('\nPR больше 300 файлов: `gh pr diff` -> HTTP 406 -> постраничный список файлов');
  // The exact stderr of gh 2.96.0 for microsoft/TypeScript#51387 (656 files).
  const TOO_LARGE = {
    code: 1,
    stderr:
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/o/r/pulls/48)\nPullRequest.diff too_large\n",
  };
  const bigName = (i) => `src/f${String(i).padStart(4, '0')}.txt`;
  const bigFile = (i) => ({
    sha: `blob${i}`,
    filename: bigName(i),
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: `@@ -1 +1 @@\n-old ${i}\n+new ${i}`,
  });
  const filesPage = (n, page, entries) => ({
    [`api repos/o/r/pulls/${n}/files?per_page=100&page=${page}`]: { code: 0, stdout: JSON.stringify(entries) },
  });
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
  const bigQ = (n) => `source=pr&host=github.com&owner=o&repo=r&number=${n}`;

  // 301 files: three full pages and a fourth with the tail. The tail page also
  // carries what a real over-300 PR has: a text file whose patch GitHub left
  // out because it is too large, and a binary file.
  const page4 = [
    { sha: 'blobHuge', filename: 'src/huge.txt', status: 'modified', additions: 7000, deletions: 5000, changes: 12000 },
  ];
  // Past some size GitHub stops computing patches altogether: a text file
  // then looks exactly like a binary one (no patch, 0/0).
  const page3 = range(201, 298)
    .map(bigFile)
    .concat([
      { sha: 'blobBin', filename: 'assets/pic.bin', status: 'modified', additions: 0, deletions: 0, changes: 0 },
      { sha: 'blobQuiet', filename: 'src/quiet.txt', status: 'modified', additions: 0, deletions: 0, changes: 0 },
    ]);
  ghFixtures(
    Object.assign(
      {
        [viewKeyFor(48)]: prView(48),
        'pr diff 48 --repo o/r': TOO_LARGE,
        'api repos/o/r/pulls/48': { code: 0, stdout: JSON.stringify({ changed_files: 301 }) },
        'pr view 48 --repo o/r --json baseRefOid,headRefOid': {
          code: 0,
          stdout: JSON.stringify({ baseRefOid: 'bigBase', headRefOid: 'bigHead' }),
        },
        'api repos/o/r/compare/bigBase...bigHead': {
          code: 0,
          stdout: JSON.stringify({ merge_base_commit: { sha: 'bigMergeBase' } }),
        },
        [ghContentsKey(bigName(7), 'bigMergeBase')]: { code: 0, stdout: 'old 7\n' },
        [ghContentsKey(bigName(7), 'bigHead')]: { code: 0, stdout: 'new 7\n' },
        [ghContentsKey('src/huge.txt', 'bigMergeBase')]: { code: 0, stdout: 'huge old\n' },
        [ghContentsKey('src/huge.txt', 'bigHead')]: { code: 0, stdout: 'huge new\n' },
        [ghContentsKey('src/quiet.txt', 'bigMergeBase')]: { code: 0, stdout: 'quiet old\n' },
        [ghContentsKey('src/quiet.txt', 'bigHead')]: { code: 0, stdout: 'quiet new\n' },
        // What gh 2.96.0 really does for a binary file with the raw Accept header.
        [ghContentsKey('assets/pic.bin', 'bigMergeBase')]: { code: 1, stderr: 'transform: short source buffer\n' },
        [viewKeyFor(25)]: prView(25),
        'pr diff 25 --repo o/r': { code: 0, stdout: PR_DIFF },
      },
      filesPage(48, 1, range(1, 100).map(bigFile)),
      filesPage(48, 2, range(101, 200).map(bigFile)),
      filesPage(48, 3, page3),
      filesPage(48, 4, page4)
    ),
    home
  );
  fs.writeFileSync(callLog, '');
  process.env.LOCAL_REVIEW_GH_CALL_LOG = callLog;

  const bigState = await call(`/api/state?${bigQ(48)}&fresh=1`);
  ok(bigState.status === 200, 'PR на 301 файл открывается, а не падает с HTTP 406', JSON.stringify(bigState.body).slice(0, 300));
  eq((bigState.body.files || []).length, 301, 'PR на 301 файл: в списке все 301');
  // `ok`, not `eq`: a mismatch must not print 301 paths twice.
  ok(
    JSON.stringify((bigState.body.files || []).map((f) => f.path).sort()) ===
      JSON.stringify(range(1, 298).map(bigName).concat(['assets/pic.bin', 'src/huge.txt', 'src/quiet.txt']).sort()),
    'PR на 301 файл: пути со всех четырёх страниц, ни один не потерян'
  );
  ok(bigState.body.truncated === null, 'PR на 301 файл: список полный, пометки об обрезке нет', JSON.stringify(bigState.body.truncated));
  eq(
    [bigName(7), 'src/huge.txt', 'assets/pic.bin', 'src/quiet.txt'].map((p) => lineCounts({ files: bigState.body.files || [] })[p]),
    [[1, 1], [7000, 5000], [null, null], [null, null]],
    'PR на 301 файл: счётчики строк — из патча, из API (патч не отдан) и null, когда GitHub их не посчитал'
  );
  eq(
    logLines().filter((l) => l.includes('pulls/48')).sort(),
    ['api repos/o/r/pulls/48'].concat(range(1, 4).map((p) => `api repos/o/r/pulls/48/files?per_page=100&page=${p}`)),
    'PR на 301 файл: один запрос числа файлов и ровно четыре страницы'
  );

  const bigDiff = await call(`/api/diff?file=${encodeURIComponent(bigName(7))}&${bigQ(48)}`);
  eq(
    [bigDiff.status, bigDiff.body.binary, bigDiff.body.oldText, bigDiff.body.newText],
    [200, false, 'old 7\n', 'new 7\n'],
    'PR на 301 файл: дифф файла открывается с текстами обеих сторон'
  );
  eq(
    (bigDiff.body.hunks || []).flatMap((h) => h.lines).map((l) => `${l.type}:${l.text}`),
    ['del:old 7', 'add:new 7'],
    'PR на 301 файл: ханки файла разобраны из patch страницы'
  );
  const hugeDiff = await call(`/api/diff?file=${encodeURIComponent('src/huge.txt')}&${bigQ(48)}`);
  eq(
    [hugeDiff.body.binary, (hugeDiff.body.hunks || []).length, hugeDiff.body.oldText, hugeDiff.body.newText],
    [false, 0, 'huge old\n', 'huge new\n'],
    'текстовый файл без patch (слишком большой дифф) — не бинарный: тексты отданы, дифф строит клиент'
  );
  const binDiff = await call(`/api/diff?file=${encodeURIComponent('assets/pic.bin')}&${bigQ(48)}`);
  ok(binDiff.body.binary === true && binDiff.body.newText === null, 'бинарный файл большого PR-а остаётся бинарным', JSON.stringify(binDiff.body));
  const quietDiff = await call(`/api/diff?file=${encodeURIComponent('src/quiet.txt')}&${bigQ(48)}`);
  eq(
    [quietDiff.body.binary, quietDiff.body.oldText, quietDiff.body.newText],
    [false, 'quiet old\n', 'quiet new\n'],
    'текстовый файл без patch и без счётчиков (GitHub перестал считать дифф) — не бинарный, тексты отданы'
  );
  eq(
    logLines().filter((l) => l === 'pr diff 48 --repo o/r' || l.includes('pulls/48')).length,
    6,
    'PR на 301 файл: диффы файлов берут список из кэша, новых запросов списка нет'
  );

  fs.writeFileSync(callLog, '');
  const smallState = await call(`/api/state?${bigQ(25)}&fresh=1`);
  eq(
    [smallState.body.files.length, smallState.body.truncated, logLines().sort()],
    [5, null, ['pr diff 25 --repo o/r', viewKeyFor(25)].sort()],
    'обычный PR: по-прежнему один `gh pr diff` и шапка, ни одного лишнего запроса'
  );

  // The hard limit: GitHub lists at most 3000 files of a PR.
  ghFixtures(
    Object.assign(
      {
        [viewKeyFor(49)]: prView(49),
        'pr diff 49 --repo o/r': TOO_LARGE,
        'api repos/o/r/pulls/49': { code: 0, stdout: JSON.stringify({ changed_files: 3500 }) },
      },
      ...range(1, 30).map((p) => filesPage(49, p, range((p - 1) * 100 + 1, p * 100).map(bigFile)))
    ),
    home
  );
  // A mark on a file past the cap: the list does not have it, and the sweep of
  // stale marks (lib/viewed-prune.js) must not take that for "gone from the diff".
  const capStoreFile = path.join(home, 'pr', 'github.com__o__r__49.json');
  const capMarks = { [bigName(3200)]: { 'pr:all': { fingerprint: 'past-the-cap', viewedAt: '2026-09-01T00:00:00.000Z' } } };
  fs.mkdirSync(path.dirname(capStoreFile), { recursive: true });
  fs.writeFileSync(capStoreFile, JSON.stringify({ version: 1, comments: [], viewed: capMarks }, null, 2), 'utf8');
  fs.writeFileSync(callLog, '');
  const capState = await call(`/api/state?${bigQ(49)}&fresh=1`);
  eq(
    JSON.parse(fs.readFileSync(capStoreFile, 'utf8')).viewed,
    capMarks,
    'PR на 3500 файлов: обрезанный список не удаляет отметки файлов, которых в нём нет'
  );
  ok(capState.status === 200, 'PR на 3500 файлов открывается', JSON.stringify(capState.body).slice(0, 300));
  eq((capState.body.files || []).length, 3000, 'PR на 3500 файлов: показаны 3000 — предел GitHub');
  eq(capState.body.truncated, { shown: 3000, total: 3500, limit: 3000 }, 'PR на 3500 файлов: /api/state говорит, сколько показано и сколько всего');
  eq(
    logLines().filter((l) => l.includes('pulls/49/files')).length,
    30,
    'PR на 3500 файлов: запрошено ровно 30 страниц, 31-й нет'
  );

  // A commit range of the same PR goes through the compare API, which is
  // capped lower: 300 files, all of them on the first page whatever per_page
  // says, and no word on how many there are in total.
  const RANGE_FROM = 'a'.repeat(40);
  const RANGE_TO = 'b'.repeat(40);
  ghFixtures(
    Object.assign(
      {
        [viewKeyFor(49)]: prView(49),
        [`api repos/o/r/commits/${RANGE_FROM}`]: { code: 0, stdout: JSON.stringify({ parents: [{ sha: 'rangeLeft' }] }) },
      },
      ...[range(1, 300), []].map((numbers, i) => ({
        [`api repos/o/r/compare/rangeLeft...${RANGE_TO}?per_page=100&page=${i + 1}`]: {
          code: 0,
          stdout: JSON.stringify({ files: numbers.map(bigFile) }),
        },
      }))
    ),
    home
  );
  const capRange = await call(`/api/state?${bigQ(49)}&from=${RANGE_FROM}&to=${RANGE_TO}&fresh=1`);
  eq(
    [capRange.status, (capRange.body.files || []).length, capRange.body.truncated],
    [200, 300, { shown: 300, total: null, limit: 300 }],
    'диапазон коммитов на 300+ файлов: показаны 300 и пометка, что список может быть неполным'
  );
  delete process.env.LOCAL_REVIEW_GH_CALL_LOG;

  const localState = await call('/api/state');
  ok(localState.body.truncated === null, 'локальный дифф: пометки об обрезке нет', JSON.stringify(localState.body.truncated));

  const lspDirs = await lspChecks(call, home);

  await new Promise((resolve) => server.server.close(resolve));

  console.log(`\n${checks - failures}/${checks} проверок прошло`);
  if (failures) {
    console.error(`\n${failures} проверок упало. Временный репозиторий оставлен: ${repo}\n`);
    process.exit(1);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(clean, { recursive: true, force: true });
  fs.rmSync(viewedRepo, { recursive: true, force: true });
  fs.rmSync(pruneRepo, { recursive: true, force: true });
  fs.rmSync(pruneNotRepo, { recursive: true, force: true });
  fs.rmSync(notRepo, { recursive: true, force: true });
  fs.rmSync(noGitignoreRepo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(staticDir, { recursive: true, force: true });
  for (const dir of lspDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nвсе проверки зелёные\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nСмоук упал с исключением:\n', err);
  process.exit(1);
});
