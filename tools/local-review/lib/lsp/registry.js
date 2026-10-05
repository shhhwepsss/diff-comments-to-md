'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Which language server serves which file, and where its executable is.
// Nothing is ever installed: a server is looked up in the repository's own
// node_modules/.bin first (a project pins its typescript-language-server
// there, next to the TypeScript it should use), then on PATH. Not found means
// «LSP не найден» in the file header, with the hint below.

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
 * may be any version). jdtls keeps an index per workspace and refuses to
 * share one between projects, so it gets its own `-data` directory under the
 * tool's home (never inside the repository, which must stay untouched).
 */
function commandFor(server, root, options) {
  const { homeDir, env = process.env, platform = process.platform } = options || {};
  for (const candidate of server.commands) {
    if (candidate.applies && !candidate.applies(root)) continue;
    if (candidate.repoOnly && !root) continue;
    const found = findExecutable(candidate.bin, { root, env: candidate.repoOnly ? { PATHEXT: env.PATHEXT } : env, platform });
    if (!found) continue;
    const args = candidate.args.slice();
    if (server.id === 'java') args.push('-data', path.join(homeDir, 'jdtls', rootHash(root)));
    return { command: found.command, args, source: found.source, label: candidate.label };
  }
  return null;
}

module.exports = { SERVERS, serverFor, serverById, languageIdFor, findExecutable, commandFor, rootHash, workspaceTsMajor };
