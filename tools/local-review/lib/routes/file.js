'use strict';

const fs = require('node:fs');
const { sendJson } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { MAX_TEXT_BYTES, TEXT_TOO_BIG_MESSAGE } = require('../diff');
const { resolveInRepo } = require('../repo-path');
const { repoRootOf } = require('./lsp');

// GET /api/file?<descriptor>&path=<repo-relative path> — a whole file of the
// working tree, for a file outside the diff that «go to definition» led to.
// Only inside the repository; only for a local folder (a PR has no files on
// disk until it is cloned).

function looksBinary(buf) {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true;
  return false;
}

async function read(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  if (descriptor.source !== 'local') {
    sendJson(res, 409, { error: 'Нет локального клона: файлы вне диффа доступны только для локальной папки' });
    return;
  }
  const root = await repoRootOf(descriptor);
  const rel = url.searchParams.get('path');
  const abs = resolveInRepo(root, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    sendJson(res, 404, { error: `Файл не найден: ${rel}` });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: `Это не файл: ${rel}` });
    return;
  }
  if (stat.size > MAX_TEXT_BYTES) {
    sendJson(res, 200, { path: rel, text: null, binary: false, textUnavailable: TEXT_TOO_BIG_MESSAGE });
    return;
  }
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    sendJson(res, 200, { path: rel, text: null, binary: true });
    return;
  }
  sendJson(res, 200, { path: rel, text: buf.toString('utf8'), binary: false });
}

module.exports = { read };
