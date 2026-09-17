'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res) {
  sendJson(res, 200, config.readSettings());
}

/** Only the keys present in the body change; today that is just gitignoreTarget. */
async function put(req, res) {
  const body = await readJsonBody(req);
  if (body.gitignoreTarget === undefined) {
    sendJson(res, 400, { error: 'Нечего сохранять: передай gitignoreTarget' });
    return;
  }
  if (!config.GITIGNORE_TARGETS.includes(body.gitignoreTarget)) {
    sendJson(res, 400, { error: 'gitignoreTarget должен быть project или global' });
    return;
  }
  sendJson(res, 200, config.writeSettings({ gitignoreTarget: body.gitignoreTarget }));
}

module.exports = { get, put };
