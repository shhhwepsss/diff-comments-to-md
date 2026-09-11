'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { findRepoRoot } = require('./lib/git');
const { resolveRange } = require('./lib/diff');
const { CommentStore, STORE_DIR, STORE_FILE } = require('./lib/store');
const { sendJson } = require('./lib/http');
const { createApp, MODES } = require('./lib/routes');
const config = require('./lib/config');

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
        // An explicitly named directory that is not a repository is a typo, and
        // a typo should be loud. Launching anywhere without --cwd is not.
        options.cwdExplicit = true;
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
  // The only thing the tool ever creates outside the chosen repository.
  const homeDir = config.ensureHome();

  const repoRoot = await findRepoRoot(options.cwd);
  if (!repoRoot && options.cwdExplicit) {
    const err = new Error(
      `Это не git-репозиторий: ${options.cwd}\n` +
        'Запусти тулу из корня репозитория (или укажи --cwd <путь к репозиторию>).'
    );
    err.userFacing = true;
    throw err;
  }

  // Fail early with a readable message instead of a stack trace mid-request.
  if (repoRoot) await resolveRange(repoRoot, options.mode, options.base);

  // No repository under cwd is no longer a reason to refuse: the UI opens on
  // the folder picker and the descriptor arrives with the first request.
  const gitignore = repoRoot ? ensureGitignore(repoRoot) : { changed: false };
  const defaults = repoRoot
    ? { source: 'local', root: repoRoot, mode: options.mode, base: options.base }
    : null;
  const store = repoRoot ? new CommentStore(path.join(repoRoot, STORE_DIR, STORE_FILE)) : null;
  const handler = createApp({ defaults, homeDir });

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
  return { server, port, repoRoot, store, gitignore, homeDir };
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
  if (started.repoRoot) {
    console.log(`  репозиторий     ${started.repoRoot}`);
    console.log(
      `  режим           ${options.mode}${options.mode === 'base' ? ` (${options.base})` : ''}`
    );
    console.log(`  комментарии     ${STORE_DIR}/comments.json (${started.store.all().length} шт.)`);
  } else {
    console.log('  репозиторий     не выбран — выбери папку на странице «Папка»');
  }
  if (started.gitignore.changed) console.log(`  .gitignore      добавлен ${STORE_DIR}/`);
  if (started.port !== options.port) console.log(`  порт ${options.port} занят, взят ${started.port}`);
  console.log('\n  Ctrl+C — выход\n');

  if (options.open) openBrowser(url);
}

if (require.main === module) {
  main();
}

module.exports = { main, start, parseArgs, ensureGitignore, createApp };
