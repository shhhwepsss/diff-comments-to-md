'use strict';

const { sendJson } = require('../http');
const browseLib = require('../browse');

async function browse(req, res, ctx, url) {
  const requested = url.searchParams.get('path');
  // No path -> the starting screen. The server never picks a root on its own.
  sendJson(res, 200, requested ? browseLib.browse(requested) : browseLib.startingPoints());
}

async function validate(req, res, ctx, url) {
  const root = url.searchParams.get('root');
  if (!root) {
    sendJson(res, 400, { error: 'Не передан параметр root' });
    return;
  }
  // Always 200: the picker screen shows the message, it does not catch a throw.
  sendJson(res, 200, await browseLib.validateRoot(root));
}

module.exports = { browse, validate };
