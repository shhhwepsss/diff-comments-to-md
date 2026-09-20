'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { findRepoRoot, getGlobalConfig, setGlobalConfig } = require('./lib/git');
const { resolveRange } = require('./lib/diff');
const { CommentStore, STORE_DIR, STORE_FILE } = require('./lib/store');
const { sendJson, getPublicDir } = require('./lib/http');
const { createApp, MODES } = require('./lib/routes');
const config = require('./lib/config');

function parseArgs(argv) {
  const options = {
    // Empty = the repository's default branch, resolved from origin/HEAD.
    base: '',
    port: 4321,
    mode: 'working',
    open: true,
    // Dev mode: the UI comes from the Vite server, this process is API only.
    apiOnly: false,
    // A port that silently slides to the next free one breaks the Vite proxy,
    // which is pinned to 4321; dev asks for the port it needs or nothing.
    strictPort: false,
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
      case '--api-only':
        options.apiOnly = true;
        break;
      case '--strict-port':
        options.strictPort = true;
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

  review [флаги]                         (после npm link)
  node tools/local-review/review.js [флаги]

  --working            рабочая копия vs HEAD (по умолчанию)
  --staged             индекс vs HEAD
  --base <rev>         рабочая копия vs merge-base(<rev>, HEAD); по умолчанию
                       ветка по умолчанию у origin (origin/HEAD)
  --mode <m>           working | staged | base
  --port <n>           стартовый порт (по умолчанию 4321, занятый — берётся следующий)
  --strict-port        не искать свободный порт: занятый --port — ошибка
  --host <addr>        адрес прослушивания (по умолчанию 127.0.0.1)
  --cwd <dir>          папка внутри репозитория (по умолчанию текущая)
  --api-only           только /api, UI не отдавать и сборку не требовать
                       (для разработки фронта: UI поднимает vite)
  --no-open            не открывать браузер
  -h, --help           эта справка

Комментарии хранятся в ${STORE_DIR}/comments.json в корне репозитория.
`;

// Lines that already ignore the store at the repository root.
const GITIGNORE_ENTRIES = [STORE_DIR, `${STORE_DIR}/`, `/${STORE_DIR}`, `/${STORE_DIR}/`, `**/${STORE_DIR}`, `**/${STORE_DIR}/`];

/** `~` is git's spelling of the home directory, not the filesystem's. */
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * The machine-wide ignore file. `core.excludesFile` wins when it is set;
 * otherwise git's own default, $XDG_CONFIG_HOME/git/ignore (or
 * ~/.config/git/ignore), which the caller then also records in the global
 * config so the choice is visible in `git config --list`.
 */
async function globalExcludesFile() {
  const configured = await getGlobalConfig('core.excludesFile', process.cwd());
  if (configured) return { file: path.resolve(expandHome(configured.trim())), configured: true };
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return { file: path.join(base, 'git', 'ignore'), configured: false };
}

/**
 * Appends `.local-review/` to an ignore file unless one of the spellings that
 * already ignore it is there. A missing file is created, a missing trailing
 * newline is added first, and CRLF is kept.
 */
function appendEntry(file) {
  const entry = `${STORE_DIR}/`;
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { changed: false, error: e.message };
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => GITIGNORE_ENTRIES.includes(l))) {
    return { changed: false };
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : eol;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${prefix}${entry}${eol}`, 'utf8');
    return { changed: true };
  } catch (e) {
    return { changed: false, error: e.message };
  }
}

/**
 * Makes git ignore .local-review/, where the user asked for it to be ignored
 * (gitignoreTarget in ~/.local-review/settings.json):
 *
 *  - 'project' (default): the top-level .gitignore of the repository that
 *    contains `dir`. `dir` may be any folder inside it — the line never goes
 *    to a nested .gitignore, and outside a repository nothing is written.
 *  - 'global': the machine's ignore file, so the line never shows up in
 *    anybody's diff. No repository is needed.
 *
 * Switching targets only ever adds a line to the new one; a line already
 * written to the other file stays where it is (removing it could take a line
 * the user put there, or edited, with it).
 */
async function ensureGitignore(dir) {
  const target = config.readSettings().gitignoreTarget;
  if (target === 'global') {
    const { file, configured } = await globalExcludesFile();
    const result = appendEntry(file);
    if (result.error) return Object.assign({ target, file }, result);
    if (!configured) {
      // git reads ~/.config/git/ignore on its own, but only while
      // core.excludesFile is unset; writing it down keeps the file in charge
      // even if something sets that key later.
      try {
        await setGlobalConfig('core.excludesFile', file, process.cwd());
      } catch (e) {
        return { changed: result.changed, target, file, error: e.message };
      }
    }
    return Object.assign({ target, file }, result);
  }
  const repoRoot = await findRepoRoot(dir);
  if (!repoRoot) return { changed: false, target: 'project', file: null };
  const file = path.join(repoRoot, '.gitignore');
  return Object.assign({ target: 'project', file }, appendEntry(file));
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
  // Fail before touching anything else: a UI that was never built is not a
  // git problem, a port problem, or a repo-selection problem, and should not
  // be diagnosed as one of those.
  // --api-only serves no UI, so an unbuilt dist/ is not its problem.
  const staticDir = getPublicDir();
  if (!options.apiOnly && !fs.existsSync(path.join(staticDir, 'index.html'))) {
    const err = new Error(
      `UI не собран: выполни \`npm run build\` (каталог ${staticDir})`
    );
    err.userFacing = true;
    throw err;
  }

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
  const range = repoRoot ? await resolveRange(repoRoot, options.mode, options.base) : null;
  const resolvedBase = (range && range.base) || options.base;

  // No repository under cwd is no longer a reason to refuse: the UI opens on
  // the folder picker and the descriptor arrives with the first request.
  // Outside a repository this is a no-op for the 'project' target, while the
  // 'global' one needs no repository at all.
  const gitignore = await ensureGitignore(repoRoot || options.cwd);
  const defaults = repoRoot
    ? { source: 'local', root: repoRoot, mode: options.mode, base: options.base }
    : null;
  const store = repoRoot ? new CommentStore(path.join(repoRoot, STORE_DIR, STORE_FILE)) : null;
  const handler = createApp({ defaults, homeDir, apiOnly: Boolean(options.apiOnly) });

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

  let port;
  try {
    port = await listen(server, options.port, options.host, options.strictPort ? 0 : 50);
  } catch (err) {
    // With --strict-port a busy port is the whole answer, and the dev who hit
    // it needs to know which process to stop, not a stack trace.
    if (options.strictPort && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
      const busy = new Error(
        `Порт ${options.port} занят: останови чужой review (или задай --port <n>).`
      );
      busy.userFacing = true;
      throw busy;
    }
    throw err;
  }
  return { server, port, repoRoot, store, gitignore, homeDir, resolvedBase };
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
  console.log(`  local-review    ${url}${options.apiOnly ? '  (только API, UI — на vite)' : ''}`);
  if (started.repoRoot) {
    console.log(`  репозиторий     ${started.repoRoot}`);
    console.log(
      `  режим           ${options.mode}${
        options.mode === 'base' ? ` (${started.resolvedBase})` : ''
      }`
    );
    console.log(`  комментарии     ${STORE_DIR}/comments.json (${started.store.all().length} шт.)`);
  } else {
    console.log('  репозиторий     не выбран — выбери папку на странице «Папка»');
  }
  if (started.gitignore.changed) {
    console.log(`  игнор           ${STORE_DIR}/ добавлен в ${started.gitignore.file}`);
  }
  if (started.port !== options.port) console.log(`  порт ${options.port} занят, взят ${started.port}`);
  console.log('\n  Ctrl+C — выход\n');

  // Nothing to open in --api-only: this port answers /api and nothing else.
  if (options.open && !options.apiOnly) openBrowser(url);
}

if (require.main === module) {
  main();
}

module.exports = { main, start, parseArgs, ensureGitignore, createApp };
