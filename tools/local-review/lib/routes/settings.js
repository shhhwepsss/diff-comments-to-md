'use strict';

const { sendJson, readJsonBody } = require('../http');
const config = require('../config');

async function get(req, res) {
  sendJson(res, 200, config.readSettings());
}

/** Only the keys present in the body change; today that is just copyPrompt. */
async function put(req, res) {
  const body = await readJsonBody(req);
  if (body.copyPrompt === undefined) {
    sendJson(res, 400, { error: 'Нечего сохранять: передай copyPrompt' });
    return;
  }
  if (typeof body.copyPrompt !== 'string') {
    sendJson(res, 400, { error: 'copyPrompt должен быть строкой' });
    return;
  }
  sendJson(res, 200, config.writeSettings({ copyPrompt: body.copyPrompt }));
}

module.exports = { get, put };
