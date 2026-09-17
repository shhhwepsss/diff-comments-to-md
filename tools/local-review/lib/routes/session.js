'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res, ctx) {
  const state = config.readState();
  sendJson(res, 200, {
    last: state.last,
    // The repository this server was started in, when there was one. Running
    // `review` inside a folder is a deliberate act now; `last` is only what
    // some previous run happened to leave behind, so the UI prefers this.
    defaults: (ctx && ctx.defaults) || null,
    recent: state.recent,
    homeDir: config.homeDir(),
    storedPrs: config.countStoredPrs(),
  });
}

async function post(req, res) {
  const body = await readJsonBody(req);
  const d = body.descriptor;
  if (!d || (d.source !== 'local' && d.source !== 'pr')) {
    sendJson(res, 400, { error: 'Нужен descriptor с source local|pr' });
    return;
  }
  let gitignore = { changed: false };
  if (d.source === 'local') {
    if (!d.root) {
      sendJson(res, 400, { error: 'Для локального источника нужен root' });
      return;
    }
    // The .gitignore line is written here and nowhere else during browsing:
    // only a confirmed folder selection touches the user's repository.
    // It lands in the repository's top-level .gitignore even when d.root is a
    // subfolder. Required lazily so the review.js <-> routes cycle resolves at
    // call time.
    gitignore = await require('../../review').ensureGitignore(d.root);
    config.addRecent(d.root);
  }
  config.setLast(d);
  const state = config.readState();
  sendJson(res, 200, { ok: true, last: state.last, recent: state.recent, gitignore });
}

module.exports = { get, post };
