'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { sendJson, readJsonBody } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { findRepoRoot } = require('../git');
const { MAX_TEXT_BYTES } = require('../diff');
const { resolveInRepo, relativeToRepo } = require('../repo-path');
const { serverFor, languageIdFor } = require('../lsp/registry');
const { LspManager, LspError } = require('../lsp/manager');

// POST /api/lsp — one language-server question about a position in a file:
//   query: the review descriptor (like every other endpoint)
//   body:  { method: 'definition' | 'hover', path, line, character, text? }
// `line` and `character` are LSP positions: zero-based, UTF-16 code units.
// `text` is the content the browser shows when it is not the working tree
// (staged, commits); without it the file is read from disk.
//
// GET /api/lsp/status — which servers are installed for this repository and
// what the running ones are doing, for the file header and the settings page.
//
// Only a local folder has files a server can read. A PR has none until it is
// cloned, and says so: { ok: false, reason: 'no-clone' }.

const METHODS = {
  definition: 'textDocument/definition',
  hover: 'textDocument/hover',
};

const REQUEST_TIMEOUT_MS = 20 * 1000;
/** How long after its first didOpen a server is given to announce the indexing it starts. */
const FIRST_OPEN_GRACE_MS = 400;

let manager = null;

/** The one manager of this process; `configure` is for tests (shorter idle time, no restart delay). */
function getManager(ctx) {
  if (!manager) manager = new LspManager({ homeDir: (ctx && ctx.homeDir) || require('../config').homeDir() });
  return manager;
}

function configure(options) {
  getManager().configure(options);
}

const NO_CLONE = {
  ok: false,
  reason: 'no-clone',
  message: 'Нет локального клона: LSP работает только для локальной папки.',
};

// A repository root, once confirmed by git, stays confirmed: hover fires often.
const knownRoots = new Set();

function bad(message, status) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = status || 400;
  return err;
}

/**
 * The repository root of a local descriptor, checked to be one: a language
 * server is started in that folder, so it must be a repository's top level
 * and not any directory a request names.
 */
async function repoRootOf(descriptor) {
  const root = path.resolve(descriptor.root);
  if (knownRoots.has(root)) return root;
  const top = await findRepoRoot(root);
  if (!top || path.resolve(top) !== root) throw bad('Папка не является корнем git-репозитория');
  knownRoots.add(root);
  return root;
}

function position(body) {
  const line = Number(body.line);
  const character = Number(body.character);
  if (!Number.isInteger(line) || line < 0 || !Number.isInteger(character) || character < 0) {
    throw bad('line и character должны быть целыми числами ≥ 0');
  }
  return { line, character };
}

/**
 * The text the server should see for the file: the one the browser sent
 * (mtimeMs null), or the file on disk (with its mtime, so a later edit is noticed).
 */
function documentText(abs, text) {
  if (text !== undefined && text !== null) {
    if (typeof text !== 'string') throw bad('text должен быть строкой');
    return { text, mtimeMs: null };
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw bad('Файла нет на диске', 404);
  }
  if (!stat.isFile()) throw bad('Это не файл', 404);
  if (stat.size > MAX_TEXT_BYTES) throw bad('Файл слишком большой для LSP', 413);
  return { text: fs.readFileSync(abs, 'utf8'), mtimeMs: stat.mtimeMs };
}

/** Location | Location[] | LocationLink[] | null -> places the browser can open. */
function locationsOf(root, result) {
  const list = result ? (Array.isArray(result) ? result : [result]) : [];
  return list
    .map((l) => {
      const uri = l.targetUri || l.uri;
      const range = l.targetSelectionRange || l.targetRange || l.range;
      if (typeof uri !== 'string' || !range || !range.start) return null;
      const where = {
        line: range.start.line,
        character: range.start.character,
        endLine: range.end ? range.end.line : range.start.line,
        endCharacter: range.end ? range.end.character : range.start.character,
      };
      if (!uri.startsWith('file:')) return Object.assign({ path: null, external: uri }, where);
      let abs;
      try {
        abs = fileURLToPath(uri);
      } catch {
        return Object.assign({ path: null, external: uri }, where);
      }
      const rel = relativeToRepo(root, abs);
      return Object.assign(rel ? { path: rel } : { path: null, external: abs }, where);
    })
    .filter(Boolean);
}

/** MarkupContent | MarkedString | MarkedString[] -> one markdown or plaintext block. */
function hoverOf(result) {
  if (!result || !result.contents) return null;
  const marked = (m) => (typeof m === 'string' ? m : m && m.value ? '```' + (m.language || '') + '\n' + m.value + '\n```' : '');
  const c = result.contents;
  let value;
  let kind = 'markdown';
  if (Array.isArray(c)) value = c.map(marked).filter(Boolean).join('\n\n');
  else if (typeof c === 'object' && c.kind) {
    value = String(c.value || '');
    kind = c.kind === 'plaintext' ? 'plaintext' : 'markdown';
  } else value = marked(c);
  if (!value.trim()) return null;
  return { kind, value };
}

function serverInfo(m, root, def) {
  const status = m.status(root).find((s) => s.id === def.id);
  return { id: def.id, label: status ? status.label : def.label, state: status ? status.state : 'stopped' };
}

async function request(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const body = await readJsonBody(req);
  const method = METHODS[body.method];
  if (!method) throw bad(`Неизвестный метод LSP: ${body.method}`);
  if (descriptor.source !== 'local') {
    sendJson(res, 200, NO_CLONE);
    return;
  }
  const root = await repoRootOf(descriptor);
  const abs = resolveInRepo(root, body.path);
  const pos = position(body);
  const def = serverFor(abs);
  if (!def) {
    sendJson(res, 200, { ok: false, reason: 'unsupported', message: 'Для этого типа файлов нет language server' });
    return;
  }
  const m = getManager(ctx);
  // The browser gave up (a newer hover, a closed tab): so does the server.
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const server = await m.ensure(root, def);
    const uri = pathToFileURL(abs).href;
    const doc = documentText(abs, body.text);
    server.refreshFromDisk(doc.mtimeMs !== null);
    const first = server.sync(uri, languageIdFor(def, abs), doc.text, abs, doc.mtimeMs);
    await server.settled(first ? FIRST_OPEN_GRACE_MS : 0, REQUEST_TIMEOUT_MS);
    const result = await server.request(
      method,
      { textDocument: { uri }, position: pos },
      { timeoutMs: REQUEST_TIMEOUT_MS, signal: abort.signal }
    );
    const payload = body.method === 'hover' ? { hover: hoverOf(result) } : { locations: locationsOf(root, result) };
    sendJson(res, 200, Object.assign({ ok: true, server: serverInfo(m, root, def) }, payload));
  } catch (e) {
    if (!(e instanceof LspError)) throw e;
    if (e.reason === 'aborted') return;
    sendJson(res, 200, {
      ok: false,
      reason: e.reason,
      message: e.message,
      hint: e.hint || null,
      server: serverInfo(m, root, def),
    });
  }
}

async function status(req, res, ctx, url) {
  const m = getManager(ctx);
  // The settings page may be opened with no review at all: then only PATH is
  // looked at, and what is running anywhere is listed.
  // A descriptor that is there but broken is still a 400.
  const descriptor = url.searchParams.get('source') || ctx.defaults ? parseDescriptor(url, ctx.defaults) : null;
  const running = m.running();
  if (descriptor && descriptor.source === 'pr') {
    sendJson(res, 200, Object.assign({}, NO_CLONE, { available: false, root: null, servers: m.status(null), running }));
    return;
  }
  const root = descriptor ? await repoRootOf(descriptor) : null;
  sendJson(res, 200, { ok: true, available: Boolean(root), root, servers: m.status(root), running });
}

module.exports = { request, status, configure, getManager, locationsOf, hoverOf, repoRootOf };
