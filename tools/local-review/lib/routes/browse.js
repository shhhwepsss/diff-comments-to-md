'use strict';

const { sendJson } = require('../http');
const browseLib = require('../browse');
const folderDialog = require('../folder-dialog');

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

async function pickFolder(req, res) {
  // Blocks until the person closes the dialog: there is no timeout on purpose.
  const result = await folderDialog.pickFolder();
  if (result.busy) {
    sendJson(res, 409, { error: 'Диалог выбора папки уже открыт — переключись на него' });
    return;
  }
  if (result.error) {
    sendJson(res, 500, { error: result.error });
    return;
  }
  sendJson(res, 200, result);
}

module.exports = { browse, validate, pickFolder };
