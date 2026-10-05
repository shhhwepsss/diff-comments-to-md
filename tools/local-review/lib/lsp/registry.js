'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Which language server serves which file, and where its executable is.
// Nothing is ever installed: a server is looked up in the repository's own
// node_modules/.bin first (a project pins its typescript-language-server
// there, next to the TypeScript it should use), then on PATH. Not found means
// «LSP не найден» in the file header, with the hint below.
// The clone of somebody else's PR is not the reviewer's own code: its
// node_modules/.bin is only looked in once the reviewer trusts it
// (`repoBin: false` otherwise, see lib/pr-clone.js), and PATH alone is used.

/**
 * One entry per server process kind. A server can serve several languages
 * (tsserver does TS and JS): `languageIds` maps an extension to the LSP
 * languageId that didOpen needs.
 */
const SERVERS = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    label: 'tsserver',
    // TypeScript 7 is a native compiler with its own language server
    // (`tsc --lsp --stdio`) and no tsserver.js, which typescript-language-
    // server needs. A repository on TS 7 gets that server; any other gets
    // typescript-language-server, and a global `tsgo` (the TS 7 preview) is
    // the last resort.
    commands: [
      { bin: 'tsc', args: ['--lsp', '--stdio'], label: 'tsgo', repoOnly: true, applies: (root) => workspaceTsMajor(root) >= 7 },
      { bin: 'typescript-language-server', args: ['--stdio'], label: 'tsserver' },
      { bin: 'tsgo', args: ['--lsp', '--stdio'], label: 'tsgo' },
    ],
    languageIds: {
      '.ts': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.jsx': 'javascriptreact',
    },
    hint: 'npm i -D typescript typescript-language-server (в репозитории) или npm i -g typescript typescript-language-server; с TypeScript 7 достаточно самого typescript',
  },
  {
    id: 'java',
    name: 'Java',
    label: 'jdtls',
    // `-data` is added per repository, see commandFor().
    commands: [{ bin: 'jdtls', args: [], label: 'jdtls' }],
    languageIds: { '.java': 'java' },
    hint: 'Eclipse JDT Language Server (jdtls) в PATH, нужен JDK 21+',
  },
  {
    id: 'go',
    name: 'Go',
    label: 'gopls',
    commands: [{ bin: 'gopls', args: [], label: 'gopls' }],
    languageIds: { '.go': 'go' },
    hint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'python',
    name: 'Python',
    label: 'pyright',
    commands: [{ bin: 'pyright-langserver', args: ['--stdio'], label: 'pyright' }],
    languageIds: { '.py': 'python', '.pyi': 'python' },
    hint: 'npm i -g pyright или pip install pyright',
  },
  {
    id: 'rust',
    name: 'Rust',
    label: 'rust-analyzer',
    commands: [{ bin: 'rust-analyzer', args: [], label: 'rust-analyzer' }],
    languageIds: { '.rs': 'rust' },
    hint: 'rustup component add rust-analyzer',
  },
];

/** The server entry for a file, by extension; null for a file no server handles. */
function serverFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return SERVERS.find((s) => Object.prototype.hasOwnProperty.call(s.languageIds, ext)) || null;
}

function languageIdFor(server, filePath) {
  return server.languageIds[path.extname(filePath).toLowerCase()] || server.id;
}

function serverById(id) {
  return SERVERS.find((s) => s.id === id) || null;
}

/** Names a bare command can have on disk: `x`, or `x.cmd` / `x.exe` / … on Windows. */
function candidateNames(bin, platform, env) {
  if (platform !== 'win32') return [bin];
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return exts.map((e) => bin + e);
}

function isExecutable(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true; // the extension is what makes it runnable
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of `bin`, or null. `<root>/node_modules/.bin` wins over
 * PATH; `root` may be null (no repository to look in).
 * Returns { command, source: 'node_modules' | 'PATH' }.
 */
function findExecutable(bin, options) {
  const { root = null, env = process.env, platform = process.platform } = options || {};
  const names = candidateNames(bin, platform, env);
  if (root) {
    const dir = path.join(root, 'node_modules', '.bin');
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file, platform)) return { command: file, source: 'node_modules' };
    }
  }
  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file, platform)) return { command: file, source: 'PATH' };
    }
  }
  return null;
}

/**
 * The TypeScript a typescript-language-server installation brings along (its
 * own dependency, or the global one beside it), or null. Without being told,
 * the server loads the workspace's node_modules/typescript/lib/tsserver.js —
 * JavaScript of the repository, which an untrusted clone must not get to run.
 */
function bundledTsserver(command) {
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(command));
  } catch {
    return null;
  }
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'typescript-language-server') {
        return require.resolve('typescript/lib/tsserver.js', { paths: [dir] });
      }
    } catch {
      /* not this folder: one up */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * initialize options that keep a server from running the repository's own
 * code: tsserver from the server's installation, not the workspace; no
 * Gradle or Maven import for jdtls (they execute build scripts and plugins);
 * no build scripts, proc macros or `cargo check` for rust-analyzer; no
 * toolchain download for gopls (go.mod's `toolchain` line would fetch and run
 * another Go). Undefined when none apply. What is left is in the README.
 */
function untrustedOptions(server, candidate, command) {
  if (server.id === 'typescript' && candidate.bin === 'typescript-language-server') {
    const tsserver = bundledTsserver(command);
    return tsserver ? { tsserver: { path: tsserver } } : undefined;
  }
  if (server.id === 'java') {
    return { settings: { java: { import: { gradle: { enabled: false, wrapper: { enabled: false } }, maven: { enabled: false } } } } };
  }
  if (server.id === 'rust') {
    return { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false };
  }
  if (server.id === 'go') return { env: { GOTOOLCHAIN: 'local' } };
  return undefined;
}

/** Stable short name of a repository for per-repository server data. */
function rootHash(root) {
  return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16);
}

/**
 * The major version of the TypeScript the repository itself has installed,
 * or 0 when it has none (or it cannot be read).
 */
function workspaceTsMajor(root) {
  if (!root) return 0;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'typescript', 'package.json'), 'utf8'));
    return Number(String(pkg.version || '').split('.')[0]) || 0;
  } catch {
    return 0;
  }
}

/**
 * Everything needed to spawn `server` for `root`, or null when it is not
 * installed: the first of its commands that applies and is found.
 * `repoOnly` commands are looked for in the repository alone (a global `tsc`
 * may be any version). `repoBin: false` skips the repository's
 * node_modules/.bin (an untrusted clone). jdtls keeps an index per workspace and refuses to
 * share one between projects, so it gets its own `-data` directory under the
 * tool's home (never inside the repository, which must stay untouched).
 */
function commandFor(server, root, options) {
  const { homeDir, env = process.env, platform = process.platform, repoBin = true } = options || {};
  // Untrusted: the repository's own programs are not looked at — not even to
  // read which TypeScript it pins (that is a file of the repository, too, but
  // reading it runs nothing; the command it would pick does).
  const binRoot = repoBin ? root : null;
  for (const candidate of server.commands) {
    if (candidate.repoOnly && !binRoot) continue;
    if (candidate.applies && !candidate.applies(root)) continue;
    const found = findExecutable(candidate.bin, { root: binRoot, env: candidate.repoOnly ? { PATHEXT: env.PATHEXT } : env, platform });
    if (!found) continue;
    const args = candidate.args.slice();
    if (server.id === 'java') args.push('-data', path.join(homeDir, 'jdtls', rootHash(root)));
    const spec = { command: found.command, args, source: found.source, label: candidate.label };
    if (!repoBin) spec.initializationOptions = untrustedOptions(server, candidate, found.command);
    return spec;
  }
  return null;
}

module.exports = { SERVERS, serverFor, serverById, languageIdFor, findExecutable, commandFor, rootHash, workspaceTsMajor, bundledTsserver, untrustedOptions };
