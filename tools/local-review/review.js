'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { findRepoRoot } = require('./lib/git');
const { listFiles, fileDiff, resolveRange } = require('./lib/diff');
const { CommentStore, STORE_DIR } = require('./lib/store');
const { renderMarkdown, writeMarkdownFile } = require('./lib/export');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MODES = new Set(['working', 'staged', 'base']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const options = {
    base: 'origin/main',
    port: 4321,
    mode: 'working',
    open: true,
    host: '127.0.0.1',
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const next = () => (inlineValue !== null ? inlineValue : argv[++i]);

    switch (name) {
      case '--base':
        options.base = next();
        options.mode = 'base';
        break;
      case '--port':
        options.port = Number(next());
        break;
      case '--mode':
        options.mode = next();
        break;
      case '--working':
        options.mode = 'working';
        break;
      case '--staged':
        options.mode = 'staged';
        break;
      case '--cwd':
        options.cwd = next();
        break;
      case '--host':
        options.host = next();
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Неизвестный флаг: ${arg}`);
          options.help = true;
          options.helpError = true;
        }
    }
  }
  if (!MODES.has(options.mode)) {
    console.error(`Неизвестный режим: ${options.mode} (working | staged | base)`);
    options.help = true;
    options.helpError = true;
  }
  if (!Number.isFinite(options.port) || options.port < 0 || options.port > 65535) {
    console.error('--port должен быть числом 0..65535');
    options.help = true;
    options.helpError = true;
  }
  return options;
}

const HELP = `
local-review — локальный просмотр git-диффа с комментариями к строкам.

  node tools/local-review/review.js [флаги]

  --working            рабочая копия vs HEAD (по умолчанию)
  --staged             индекс vs HEAD
  --base <rev>         рабочая копия vs merge-base(<rev>, HEAD); по умолчанию origin/main
  --mode <m>           working | staged | base
  --port <n>           стартовый порт (по умолчанию 4321, занятый — берётся следующий)
  --host <addr>        адрес прослушивания (по умолчанию 127.0.0.1)
  --cwd <dir>          папка внутри репозитория (по умолчанию текущая)
  --no-open            не открывать браузер
  -h, --help           эта справка

Комментарии хранятся в ${STORE_DIR}/comments.json в корне репозитория.
`;

/** Adds .local-review/ to .gitignore if it is not already ignored. */
function ensureGitignore(repoRoot) {
  const file = path.join(repoRoot, '.gitignore');
  const entry = `${STORE_DIR}/`;
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { changed: false, error: e.message };
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(STORE_DIR) || lines.includes(`/${entry}`)) {
    return { changed: false };
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : eol;
  try {
    fs.appendFileSync(file, `${prefix}${entry}${eol}`, 'utf8');
    return { changed: true };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, type) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limitBytes || 2 * 1024 * 1024)) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Некорректный JSON в теле запроса');
    err.userFacing = true;
    err.status = 400;
    throw err;
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  const normalized = path.resolve(abs);
  if (!normalized.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(normalized).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function createApp(context) {
  const { repoRoot, store } = context;

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    // ---- state -------------------------------------------------------------
    if (pathname === '/api/state' && req.method === 'GET') {
      const mode = url.searchParams.get('mode') || context.mode;
      const base = url.searchParams.get('base') || context.base;
      if (!MODES.has(mode)) {
        sendJson(res, 400, { error: `Неизвестный режим: ${mode}` });
        return;
      }
      const { files, range } = await listFiles(repoRoot, mode, base);
      const counts = store.countsByFile();
      sendJson(res, 200, {
        repoRoot,
        mode,
        base,
        rangeLabel: range.label,
        totalComments: store.all().length,
        files: files.map((f) => ({
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
          kind: f.kind,
          untracked: Boolean(f.untracked),
          comments: counts[f.path] || 0,
        })),
        // Comments can outlive the diff they were written against; surface them
        // so nothing silently disappears from the UI.
        orphanFiles: Object.keys(counts)
          .filter((p) => !files.some((f) => f.path === p))
          .map((p) => ({ path: p, comments: counts[p], orphan: true })),
      });
      return;
    }

    // ---- diff of one file --------------------------------------------------
    if (pathname === '/api/diff' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      const mode = url.searchParams.get('mode') || context.mode;
      const base = url.searchParams.get('base') || context.base;
      if (!file) {
        sendJson(res, 400, { error: 'Не передан параметр file' });
        return;
      }
      const result = await fileDiff(repoRoot, mode, base, file, 3);
      sendJson(res, 200, result);
      return;
    }

    // ---- comments ----------------------------------------------------------
    if (pathname === '/api/comments' && req.method === 'GET') {
      sendJson(res, 200, { comments: store.all() });
      return;
    }

    if (pathname === '/api/comments' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.file || typeof body.file !== 'string') {
        sendJson(res, 400, { error: 'file обязателен' });
        return;
      }
      if (!body.text || !String(body.text).trim()) {
        sendJson(res, 400, { error: 'Пустой комментарий' });
        return;
      }
      const comment = store.add({
        file: body.file,
        startLine: body.startLine === undefined ? null : body.startLine,
        endLine: body.endLine === undefined ? null : body.endLine,
        text: String(body.text).trim(),
      });
      sendJson(res, 201, { comment });
      return;
    }

    // ---- destructive: only here, only with explicit confirm ----------------
    if (pathname === '/api/comments/clear-all' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendJson(res, 400, {
          error: 'Нужно подтверждение: {"confirm": true}',
          remaining: store.all().length,
        });
        return;
      }
      const removed = store.clearAll();
      sendJson(res, 200, { removed, remaining: store.all().length });
      return;
    }

    const commentMatch = /^\/api\/comments\/([^/]+)$/.exec(pathname);
    if (commentMatch) {
      const id = commentMatch[1];
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (!body.text || !String(body.text).trim()) {
          sendJson(res, 400, { error: 'Пустой комментарий' });
          return;
        }
        const comment = store.update(id, String(body.text).trim());
        if (!comment) {
          sendJson(res, 404, { error: 'Комментарий не найден' });
          return;
        }
        sendJson(res, 200, { comment });
        return;
      }
      if (req.method === 'DELETE') {
        const ok = store.remove(id);
        sendJson(res, ok ? 200 : 404, ok ? { removed: id } : { error: 'Комментарий не найден' });
        return;
      }
    }

    // ---- export (read-only w.r.t. the comment store) ------------------------
    if (pathname === '/api/export/text' && req.method === 'GET') {
      sendText(res, 200, renderMarkdown(store.all()), 'text/markdown; charset=utf-8');
      return;
    }

    if (pathname === '/api/export/file' && req.method === 'POST') {
      const comments = store.all();
      const written = writeMarkdownFile(repoRoot, comments);
      sendJson(res, 200, {
        file: written.name,
        path: written.path,
        count: comments.length,
        remaining: store.all().length,
      });
      return;
    }

    sendJson(res, 404, { error: `Нет такого эндпоинта: ${req.method} ${pathname}` });
  };
}

function listen(server, port, host, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attemptsLeft > 0) {
        server.removeListener('error', onError);
        resolve(listen(server, port + 1, host, attemptsLeft - 1));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* opening a browser is a convenience, never a failure */
  }
}

async function start(options) {
  const repoRoot = await findRepoRoot(options.cwd);
  if (!repoRoot) {
    const err = new Error(
      `Это не git-репозиторий: ${options.cwd}\n` +
        'Запусти тулу из корня репозитория (или укажи --cwd <путь к репозиторию>).'
    );
    err.userFacing = true;
    throw err;
  }

  // Fail early with a readable message instead of a stack trace mid-request.
  await resolveRange(repoRoot, options.mode, options.base);

  const gitignore = ensureGitignore(repoRoot);
  const store = new CommentStore(repoRoot);
  const handler = createApp({ repoRoot, store, mode: options.mode, base: options.base });

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err.status || (err.userFacing ? 400 : 500);
      sendJson(res, status, { error: err.message || String(err) });
    });
  });

  const port = await listen(server, options.port, options.host, 50);
  return { server, port, repoRoot, store, gitignore };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    process.exit(options.helpError ? 1 : 0);
  }

  let started;
  try {
    started = await start(options);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }

  const url = `http://${options.host}:${started.port}/`;
  console.log('');
  console.log(`  local-review    ${url}`);
  console.log(`  репозиторий     ${started.repoRoot}`);
  console.log(
    `  режим           ${options.mode}${options.mode === 'base' ? ` (${options.base})` : ''}`
  );
  console.log(`  комментарии     ${STORE_DIR}/comments.json (${started.store.all().length} шт.)`);
  if (started.gitignore.changed) console.log(`  .gitignore      добавлен ${STORE_DIR}/`);
  if (started.port !== options.port) console.log(`  порт ${options.port} занят, взят ${started.port}`);
  console.log('\n  Ctrl+C — выход\n');

  if (options.open) openBrowser(url);
}

if (require.main === module) {
  main();
}

module.exports = { main, start, parseArgs, ensureGitignore, createApp };
