'use strict';

const { sendJson, sendText } = require('../http');
const { exportMarkdown, writeMarkdownFile } = require('../export');
const { parseDescriptor } = require('../descriptor');
const { storeFor } = require('../stores/factory');
const config = require('../config');

// Export is read-only with respect to the comment store: it never adds,
// changes or removes a comment.

// The clipboard text and the .md file are the same text, copy prompt included.
async function exportText(req, res, ctx, url) {
  const store = storeFor(parseDescriptor(url, ctx.defaults), ctx.homeDir);
  const text = exportMarkdown(store.all(), config.readSettings().copyPrompt);
  sendText(res, 200, text, 'text/markdown; charset=utf-8');
}

async function exportFile(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const store = storeFor(descriptor, ctx.homeDir);
  const comments = store.all();
  // Local mode writes into the repository root, as it always has; a PR has no
  // repository on disk, so its export goes to the home config.
  const dir = descriptor.source === 'local' ? descriptor.root : config.exportsDir();
  const written = writeMarkdownFile(dir, exportMarkdown(comments, config.readSettings().copyPrompt));
  sendJson(res, 200, {
    file: written.name,
    path: written.path,
    dir,
    count: comments.length,
    remaining: store.all().length,
  });
}

module.exports = { exportText, exportFile };
