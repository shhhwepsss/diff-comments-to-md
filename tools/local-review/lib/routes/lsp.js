'use strict';

const crypto = require('node:crypto');
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

// POST /api/lsp — one language-server question about a file:
//   query: the review descriptor (like every other endpoint)
//   body:  { method, path, line, character, text?, item?, token? }
// Methods:
//   definition | hover | references | implementation | prepareCallHierarchy
//     — about the symbol at `line`/`character` of `path`;
//   incomingCalls | outgoingCalls
//     — about a call hierarchy `item` an earlier answer handed out, sent back
//       as it came with its `token`; `path` is the file the hierarchy was
//       started in (it picks the server).
// `line` and `character` are LSP positions: zero-based, UTF-16 code units.
// `text` is the content the browser shows when it is not the working tree
// (staged, commits); without it the file is read from disk.
//
// Places in answers carry a repository-relative path, or path null and
// `external` when they are outside the repository (a library, the JDK) —
// such files are never read. Places inside get `preview`: the text of their
// line, so a list of references needs no file fetched whole.
//
// GET /api/lsp/status — which servers are installed for this repository and
// what the running ones are doing, for the file header and the settings page.
//
// Only a local folder has files a server can read. A PR has none until it is
// cloned, and says so: { ok: false, reason: 'no-clone' }.

/**
 * name -> the LSP request, the capability a server must announce for it
 * (null: asked regardless, as phase one did) and the words for «не поддерживается».
 */
const METHODS = {
  definition: { lsp: 'textDocument/definition', capability: null, label: 'переход к определению' },
  hover: { lsp: 'textDocument/hover', capability: null, label: 'подсказки' },
  references: { lsp: 'textDocument/references', capability: 'referencesProvider', label: 'поиск ссылок' },
  implementation: { lsp: 'textDocument/implementation', capability: 'implementationProvider', label: 'поиск реализаций' },
  prepareCallHierarchy: { lsp: 'textDocument/prepareCallHierarchy', capability: 'callHierarchyProvider', label: 'иерархию вызовов' },
  incomingCalls: { lsp: 'callHierarchy/incomingCalls', capability: 'callHierarchyProvider', label: 'иерархию вызовов', item: true },
  outgoingCalls: { lsp: 'callHierarchy/outgoingCalls', capability: 'callHierarchyProvider', label: 'иерархию вызовов', item: true },
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

/** Previews read per answer at most: a symbol used everywhere must not read the whole repository. */
const MAX_PREVIEW_FILES = 300;
/** Of a long line, this much is sent, starting a little before the symbol. */
const PREVIEW_CHARS = 240;
const PREVIEW_LEAD = 60;

/**
 * Line texts for previews within one answer. A document the server has open
 * is read from there — it may be the shown version (staged, a commit), which
 * is what the positions refer to; anything else from disk, through the same
 * checks as every path a browser names (inside the repository, not .git).
 */
class Previews {
  constructor(root, server) {
    this.root = root;
    this.server = server;
    this.files = new Map();
  }

  lines(rel) {
    if (this.files.has(rel)) return this.files.get(rel);
    let lines = null;
    if (this.files.size < MAX_PREVIEW_FILES) {
      try {
        const abs = resolveInRepo(this.root, rel);
        const open = this.server && this.server.docs.get(pathToFileURL(abs).href);
        let text = open ? open.text : null;
        if (text === null) {
          const stat = fs.statSync(abs);
          if (stat.isFile() && stat.size <= MAX_TEXT_BYTES) {
            const buf = fs.readFileSync(abs);
            if (!buf.subarray(0, 8000).includes(0)) text = buf.toString('utf8');
          }
        }
        if (text !== null) lines = text.split(/\r?\n/);
      } catch {
        lines = null;
      }
    }
    this.files.set(rel, lines);
    return lines;
  }

  /** { text, start }: a piece of the line and where in the line it starts; null when unknown. */
  of(rel, line, character) {
    const lines = this.lines(rel);
    const full = lines && lines[line];
    if (typeof full !== 'string') return null;
    let start = full.length - full.trimStart().length;
    if (character - start > PREVIEW_CHARS - PREVIEW_LEAD) start = Math.max(0, character - PREVIEW_LEAD);
    return { text: full.slice(start, start + PREVIEW_CHARS).trimEnd(), start };
  }
}

/** A file: URI -> repository-relative path, or { external } for anything outside. */
function placeOf(root, uri) {
  if (typeof uri !== 'string') return null;
  if (!uri.startsWith('file:')) return { path: null, external: uri };
  let abs;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return { path: null, external: uri };
  }
  const rel = relativeToRepo(root, abs);
  return rel ? { path: rel } : { path: null, external: abs };
}

/** A range in the file at `uri` as the browser gets it, with the preview of its line when asked. */
function locationAt(root, uri, range, previews) {
  if (!range || !range.start) return null;
  const place = placeOf(root, uri);
  if (!place) return null;
  const where = {
    line: range.start.line,
    character: range.start.character,
    endLine: range.end ? range.end.line : range.start.line,
    endCharacter: range.end ? range.end.character : range.start.character,
  };
  const out = Object.assign(place, where);
  if (previews && out.path) out.preview = previews.of(out.path, where.line, where.character);
  return out;
}

/** Location | Location[] | LocationLink[] | null -> places the browser can open. */
function locationsOf(root, result, previews) {
  const list = result ? (Array.isArray(result) ? result : [result]) : [];
  return list
    .filter(Boolean)
    .map((l) => locationAt(root, l.targetUri || l.uri, l.targetSelectionRange || l.targetRange || l.range, previews))
    .filter(Boolean);
}

// Call hierarchy items go to the browser and come back for the next level.
// The server only forwards what it signed: an item is a URI the language
// server will open, and a forged one could point it anywhere on disk.
const ITEM_SECRET = crypto.randomBytes(32);

function signItem(item) {
  return crypto.createHmac('sha256', ITEM_SECRET).update(JSON.stringify(item)).digest('base64url');
}

function verifiedItem(body) {
  const item = body.item;
  const token = typeof body.token === 'string' ? body.token : '';
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Не передан элемент иерархии вызовов');
  const expected = Buffer.from(signItem(item));
  const given = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw bad('Элемент иерархии вызовов не выдан этим сервером', 403);
  }
  return item;
}

/** A CallHierarchyItem -> a node of the tree: where it is declared, and the item to expand it by. */
function callNodeOf(root, item, previews) {
  if (!item || typeof item.uri !== 'string' || !item.range) return null;
  const at = locationAt(root, item.uri, item.selectionRange || item.range, previews);
  if (!at) return null;
  return Object.assign(
    {
      name: String(item.name || ''),
      kind: Number.isInteger(item.kind) ? item.kind : null,
      detail: item.detail ? String(item.detail) : '',
    },
    at,
    { item, token: signItem(item) }
  );
}

/**
 * incomingCalls / outgoingCalls -> [{ node, sites }]. The call sites
 * (`fromRanges`) are in the caller's file: the other end for incoming calls,
 * the expanded item itself for outgoing ones.
 */
function callsOf(root, method, parent, result, previews) {
  const incoming = method === 'incomingCalls';
  return (Array.isArray(result) ? result : [])
    .map((call) => {
      const node = callNodeOf(root, incoming ? call && call.from : call && call.to, previews);
      if (!node) return null;
      const siteUri = incoming ? node.item.uri : parent.uri;
      const sites = ((call && call.fromRanges) || []).map((r) => locationAt(root, siteUri, r, previews)).filter(Boolean);
      return { node, sites };
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

/** The parameters of the LSP request for `name`. */
function paramsFor(name, uri, body) {
  if (METHODS[name].item) return { item: verifiedItem(body) };
  const params = { textDocument: { uri }, position: position(body) };
  // The declaration is a reference too: a list without it misses the one place everybody looks for.
  if (name === 'references') params.context = { includeDeclaration: true };
  return params;
}

function payloadFor(name, root, result, previews, params) {
  switch (name) {
    case 'hover':
      return { hover: hoverOf(result) };
    case 'definition':
      return { locations: locationsOf(root, result) };
    case 'references':
    case 'implementation':
      return { locations: locationsOf(root, result, previews) };
    case 'prepareCallHierarchy':
      return { items: (Array.isArray(result) ? result : []).map((item) => callNodeOf(root, item, previews)).filter(Boolean) };
    default:
      return { calls: callsOf(root, name, params.item, result, previews) };
  }
}

async function request(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const body = await readJsonBody(req);
  const name = Object.prototype.hasOwnProperty.call(METHODS, body.method) ? body.method : null;
  if (!name) throw bad(`Неизвестный метод LSP: ${body.method}`);
  const method = METHODS[name];
  if (descriptor.source !== 'local') {
    sendJson(res, 200, NO_CLONE);
    return;
  }
  const root = await repoRootOf(descriptor);
  const abs = resolveInRepo(root, body.path);
  const uri = pathToFileURL(abs).href;
  // Malformed requests are a 400 before any server is started for them.
  const params = paramsFor(name, uri, body);
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
    if (method.capability && !server.capabilities[method.capability]) {
      sendJson(res, 200, {
        ok: false,
        reason: 'not-supported',
        message: `${server.label} не поддерживает ${method.label}`,
        server: serverInfo(m, root, def),
      });
      return;
    }
    const doc = documentText(abs, body.text);
    server.refreshFromDisk(doc.mtimeMs !== null);
    const first = server.sync(uri, languageIdFor(def, abs), doc.text, abs, doc.mtimeMs);
    await server.settled(first ? FIRST_OPEN_GRACE_MS : 0, REQUEST_TIMEOUT_MS);
    const result = await server.request(method.lsp, params, { timeoutMs: REQUEST_TIMEOUT_MS, signal: abort.signal });
    const payload = payloadFor(name, root, result, new Previews(root, server), params);
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

module.exports = { request, status, configure, getManager, locationsOf, hoverOf, repoRootOf, METHODS };
