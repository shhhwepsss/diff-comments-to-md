'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res) {
  const state = config.readState();
  sendJson(res, 200, {
    last: state.last,
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
    // Required lazily so the review.js <-> routes cycle resolves at call time.
    gitignore = require('../../review').ensureGitignore(d.root);
    config.addRecent(d.root);
  }
  config.setLast(d);
  const state = config.readState();
  sendJson(res, 200, { ok: true, last: state.last, recent: state.recent, gitignore });
}

module.exports = { get, post };
