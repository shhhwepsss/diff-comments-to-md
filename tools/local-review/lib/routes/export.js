'use strict';

const { sendJson, sendText } = require('../http');
const { renderMarkdown, writeMarkdownFile } = require('../export');
const { parseDescriptor } = require('../descriptor');
const { storeFor } = require('../stores/factory');
const config = require('../config');

// Export is read-only with respect to the comment store: it never adds,
// changes or removes a comment.

async function exportText(req, res, ctx, url) {
  const store = storeFor(parseDescriptor(url, ctx.defaults), ctx.homeDir);
  sendText(res, 200, renderMarkdown(store.all()), 'text/markdown; charset=utf-8');
}

async function exportFile(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const store = storeFor(descriptor, ctx.homeDir);
  const comments = store.all();
  // Local mode writes into the repository root, as it always has; a PR has no
  // repository on disk, so its export goes to the home config.
  const dir = descriptor.source === 'local' ? descriptor.root : config.exportsDir();
  const written = writeMarkdownFile(dir, comments);
  sendJson(res, 200, {
    file: written.name,
    path: written.path,
    dir,
    count: comments.length,
    remaining: store.all().length,
  });
}

module.exports = { exportText, exportFile };
