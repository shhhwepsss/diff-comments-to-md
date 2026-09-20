'use strict';

const { sendJson } = require('../http');
const { ghStatus } = require('../gh');
const { searchPrs, resolvePr } = require('../pr-search');
const { listRepos } = require('../repos');
const { parseDescriptor } = require('../descriptor');
const config = require('../config');

/** Always 200: "gh is missing" is a screen state, not a request failure. */
async function status(req, res) {
  sendJson(res, 200, await ghStatus());
}

/**
 * The repositories the PR screen offers in its picker. A gh failure is a real
 * failure here (unlike `status` above): the screen keeps its text input, so
 * it can show why the list is missing and still search by a typed name.
 */
async function repos(req, res) {
  sendJson(res, 200, { items: await listRepos() });
}

async function search(req, res, ctx, url) {
  const p = url.searchParams;
  const result = await searchPrs({
    repo: p.get('repo'),
    q: p.get('q'),
    state: p.get('state'),
    limit: p.get('limit'),
    author: p.get('author'),
  });
  // The stored-PR count and config path are shown on the search screen so the
  // home directory never grows unnoticed (spec 3.2).
  sendJson(res, 200, {
    mode: result.mode,
    items: result.items,
    homeDir: config.homeDir(),
    storedPrs: config.countStoredPrs(),
  });
}

async function resolve(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  if (descriptor.source !== 'pr') {
    sendJson(res, 400, { error: 'Нужен дескриптор PR-а (source=pr)' });
    return;
  }
  sendJson(res, 200, await resolvePr(descriptor));
}

module.exports = { status, repos, search, resolve };
