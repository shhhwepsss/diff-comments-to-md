#!/usr/bin/env node
'use strict';

// A stand-in language server for smoke.js, speaking just enough LSP over
// stdio. smoke.js puts a launcher for it at node_modules/.bin/
// typescript-language-server of a throwaway repository, so lib/lsp/registry.js
// finds it the way it finds the real one.
//
// Framing is written out here on purpose rather than taken from
// lib/lsp/jsonrpc.js: the test must not agree with the client just because
// both share the same bug.
//
// What it does with the word at the requested position:
//   definition — finds `function|class|interface|const <word>` in the open
//                documents, then in the repository's .ts/.js files on disk;
//                `outside` answers with a file outside the repository;
//                `crash` exits with code 3 (and says so on stderr).
//   hover      — «```ts\n(word) <word>\n```\nversion <n>», n being the
//                document's version, so the test sees didOpen/didChange.
//   references — every whole-word occurrence in the open documents and the
//                files on disk (an open document wins over its file), then
//                one place outside the repository.
//   implementation — `class X implements <word>`: the X of each.
//   prepareCallHierarchy — the `function <word>` declaration, if any.
//   incomingCalls / outgoingCalls — calls `name(` between one `function`
//                line and the next; a call outside any function comes from
//                the file itself (kind Module).
// LOCAL_REVIEW_LSP_FIXTURE_DROP (comma-separated capability names) leaves
// those capabilities out of the initialize answer.
// Every method received is appended as a JSON line to
// LOCAL_REVIEW_LSP_FIXTURE_LOG when that is set.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const log = process.env.LOCAL_REVIEW_LSP_FIXTURE_LOG;
const docs = new Map();
let root = process.cwd();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function wordAt(text, line, character) {
  const lineText = text.split(/\r?\n/)[line] || '';
  let from = character;
  let to = character;
  while (from > 0 && /[\w$]/.test(lineText[from - 1])) from -= 1;
  while (to < lineText.length && /[\w$]/.test(lineText[to])) to += 1;
  return lineText.slice(from, to);
}

function declarationIn(text, word) {
  const re = new RegExp(`\\b(?:function|class|interface|const|let|type)\\s+(${word})\\b`);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m) {
      const character = m.index + m[0].length - word.length;
      return { line: i, character };
    }
  }
  return null;
}

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(abs);
    else if (/\.(ts|js)$/.test(entry.name)) yield abs;
  }
}

function definition(word) {
  const range = (pos) => ({ start: pos, end: { line: pos.line, character: pos.character + word.length } });
  for (const [uri, doc] of docs) {
    const pos = declarationIn(doc.text, word);
    if (pos) return [{ uri, range: range(pos) }];
  }
  for (const abs of sourceFiles(root)) {
    const pos = declarationIn(fs.readFileSync(abs, 'utf8'), word);
    if (pos) return [{ uri: pathToFileURL(abs).href, range: range(pos) }];
  }
  return [];
}

/** Every source text: open documents over the files on disk. */
function allTexts() {
  const texts = new Map();
  for (const abs of sourceFiles(root)) texts.set(pathToFileURL(abs).href, fs.readFileSync(abs, 'utf8'));
  for (const [uri, doc] of docs) texts.set(uri, doc.text);
  return texts;
}

function rangeOf(line, character, length) {
  return { start: { line, character }, end: { line, character: character + length } };
}

function references(word) {
  const out = [];
  const re = new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  for (const [uri, text] of allTexts()) {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(re)) out.push({ uri, range: rangeOf(i, m.index, word.length) });
    });
  }
  if (out.length) out.push({ uri: pathToFileURL(path.join(path.dirname(root), 'lib.d.ts')).href, range: rangeOf(0, 0, word.length) });
  return out;
}

function implementations(word) {
  const out = [];
  const re = new RegExp(`\\bclass\\s+(\\w+)\\s+implements\\s+${word}\\b`);
  for (const [uri, text] of allTexts()) {
    text.split(/\r?\n/).forEach((line, i) => {
      const m = re.exec(line);
      if (m) out.push({ uri, range: rangeOf(i, m.index + m[0].indexOf(m[1], 5), m[1].length) });
    });
  }
  return out;
}

/** The functions of every file: name, where, and the lines of its body. */
function functions() {
  const out = [];
  for (const [uri, text] of allTexts()) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = /\bfunction\s+(\w+)/.exec(line);
      if (m) {
        out.push({ name: m[1], uri, line: i, character: m.index + m[0].length - m[1].length, from: i, to: lines.length - 1 });
        const prev = out[out.length - 2];
        if (prev && prev.uri === uri) prev.to = i - 1;
      }
    });
  }
  return out;
}

function itemOf(fn) {
  const range = rangeOf(fn.line, fn.character, fn.name.length);
  return { name: fn.name, kind: 12, detail: path.basename(fileURLToPath(fn.uri)), uri: fn.uri, range, selectionRange: range, data: { fixture: true } };
}

function moduleItem(uri) {
  const range = rangeOf(0, 0, 0);
  return { name: path.basename(fileURLToPath(uri)), kind: 2, uri, range, selectionRange: range };
}

function callsIn(text, from, to, name) {
  const ranges = [];
  const re = new RegExp(`(?<![\\w$])${name}\\(`, 'g');
  text.split(/\r?\n/).forEach((line, i) => {
    if (i < from || i > to || /\bfunction\s/.test(line)) return;
    for (const m of line.matchAll(re)) ranges.push(rangeOf(i, m.index, name.length));
  });
  return ranges;
}

function incomingCalls(item) {
  const fns = functions();
  const texts = allTexts();
  const out = [];
  for (const [uri, text] of texts) {
    const own = fns.filter((f) => f.uri === uri);
    const first = own.length ? own[0].from : text.split(/\r?\n/).length;
    const top = callsIn(text, 0, first - 1, item.name);
    if (top.length) out.push({ from: moduleItem(uri), fromRanges: top });
    for (const fn of own) {
      const ranges = callsIn(text, fn.from, fn.to, item.name);
      if (ranges.length) out.push({ from: itemOf(fn), fromRanges: ranges });
    }
  }
  return out;
}

function outgoingCalls(item) {
  const fns = functions();
  const self = fns.find((f) => f.uri === item.uri && f.name === item.name);
  if (!self) return [];
  const text = allTexts().get(item.uri);
  const out = [];
  for (const fn of fns) {
    const ranges = callsIn(text, self.from, self.to, fn.name);
    if (ranges.length) out.push({ to: itemOf(fn), fromRanges: ranges });
  }
  return out;
}

function wordOf(params) {
  const doc = docs.get(params.textDocument.uri);
  return doc ? wordAt(doc.text, params.position.line, params.position.character) : '';
}

function handle(message) {
  if (log && message.method) fs.appendFileSync(log, JSON.stringify({ method: message.method, pid: process.pid }) + '\n');
  const { id, method, params } = message;
  switch (method) {
    case 'initialize': {
      if (params && params.rootUri) root = fileURLToPath(params.rootUri);
      const capabilities = {
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        callHierarchyProvider: true,
        textDocumentSync: 1,
      };
      for (const name of (process.env.LOCAL_REVIEW_LSP_FIXTURE_DROP || '').split(',')) delete capabilities[name.trim()];
      send({ jsonrpc: '2.0', id, result: { capabilities } });
      return;
    }
    case 'initialized':
      // A request of our own, which the client must answer, and some progress.
      send({ jsonrpc: '2.0', id: 'cfg-1', method: 'workspace/configuration', params: { items: [{ section: 'x' }] } });
      send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'idx', value: { kind: 'begin', title: 'Indexing' } } });
      setTimeout(() => send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'idx', value: { kind: 'end' } } }), 100);
      return;
    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version });
      return;
    case 'textDocument/didChange': {
      const doc = docs.get(params.textDocument.uri);
      if (doc) {
        doc.text = params.contentChanges[params.contentChanges.length - 1].text;
        doc.version = params.textDocument.version;
      }
      return;
    }
    case 'textDocument/definition':
    case 'textDocument/hover': {
      const doc = docs.get(params.textDocument.uri);
      const word = doc ? wordAt(doc.text, params.position.line, params.position.character) : '';
      if (word === 'crash') {
        process.stderr.write('fixture: crash requested\n');
        process.exit(3);
      }
      if (method === 'textDocument/hover') {
        const value = word ? '```ts\n(word) ' + word + '\n```\nversion ' + doc.version : '';
        send({ jsonrpc: '2.0', id, result: value ? { contents: { kind: 'markdown', value } } : null });
        return;
      }
      if (word === 'outside') {
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
        send({ jsonrpc: '2.0', id, result: [{ uri: pathToFileURL(path.join(path.dirname(root), 'elsewhere.ts')).href, range }] });
        return;
      }
      send({ jsonrpc: '2.0', id, result: definition(word) });
      return;
    }
    case 'textDocument/references':
      send({ jsonrpc: '2.0', id, result: references(wordOf(params)) });
      return;
    case 'textDocument/implementation':
      send({ jsonrpc: '2.0', id, result: implementations(wordOf(params)) });
      return;
    case 'textDocument/prepareCallHierarchy': {
      const word = wordOf(params);
      const fn = functions().find((f) => f.name === word);
      send({ jsonrpc: '2.0', id, result: fn ? [itemOf(fn)] : null });
      return;
    }
    case 'callHierarchy/incomingCalls':
      send({ jsonrpc: '2.0', id, result: incomingCalls(params.item) });
      return;
    case 'callHierarchy/outgoingCalls':
      send({ jsonrpc: '2.0', id, result: outgoingCalls(params.item) });
      return;
    case 'shutdown':
      send({ jsonrpc: '2.0', id, result: null });
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (id !== undefined && method) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } });
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
    buffer = buffer.subarray(end + 4 + length);
    handle(JSON.parse(body));
  }
});
process.stdin.on('end', () => process.exit(0));
