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

function handle(message) {
  if (log && message.method) fs.appendFileSync(log, JSON.stringify({ method: message.method, pid: process.pid }) + '\n');
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      if (params && params.rootUri) root = fileURLToPath(params.rootUri);
      send({ jsonrpc: '2.0', id, result: { capabilities: { hoverProvider: true, definitionProvider: true, textDocumentSync: 1 } } });
      return;
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
