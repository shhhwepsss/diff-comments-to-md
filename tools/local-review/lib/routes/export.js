'use strict';

const { sendJson, sendText } = require('../http');
const { renderMarkdown, withPrompt, writeMarkdownFile } = require('../export');
const { parseDescriptor } = require('../descriptor');
const { storeFor } = require('../stores/factory');
const config = require('../config');

// Export is read-only with respect to the comment store: it never adds,
// changes or removes a comment.

// Only the clipboard text carries the user's copy prompt; the .md file stays
// the comments alone.
async function exportText(req, res, ctx, url) {
  const store = storeFor(parseDescriptor(url, ctx.defaults), ctx.homeDir);
  const text = withPrompt(config.readSettings().copyPrompt, renderMarkdown(store.all()));
  sendText(res, 200, text, 'text/markdown; charset=utf-8');
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
