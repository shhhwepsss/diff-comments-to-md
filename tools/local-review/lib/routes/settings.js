'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res) {
  sendJson(res, 200, config.readSettings());
}

/** Only the keys present in the body change; the rest keep their saved value. */
async function put(req, res) {
  const body = await readJsonBody(req);
  const patch = {};
  if (body.copyPrompt !== undefined) {
    if (typeof body.copyPrompt !== 'string') {
      sendJson(res, 400, { error: 'copyPrompt должен быть строкой' });
      return;
    }
    patch.copyPrompt = body.copyPrompt;
  }
  if (body.gitignoreTarget !== undefined) {
    if (!config.GITIGNORE_TARGETS.includes(body.gitignoreTarget)) {
      sendJson(res, 400, { error: 'gitignoreTarget должен быть project или global' });
      return;
    }
    patch.gitignoreTarget = body.gitignoreTarget;
  }
  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { error: 'Нечего сохранять: передай copyPrompt или gitignoreTarget' });
    return;
  }
  sendJson(res, 200, config.writeSettings(patch));
}

module.exports = { get, put };
