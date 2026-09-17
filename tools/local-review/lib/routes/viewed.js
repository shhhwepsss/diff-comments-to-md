'use strict';

const { sendJson, readJsonBody } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { storeFor } = require('../stores/factory');
const { modeKeyOf } = require('../viewed');

/**
 * POST { file, fingerprint, viewed: true } marks a file viewed;
 * POST { file, viewed: false } takes the mark off.
 *
 * The fingerprint comes from the client on purpose: it is the one /api/state
 * handed out with the diff the reviewer actually looked at. If the diff has
 * moved on since, the next /api/state computes a different fingerprint and
 * the file correctly reads as not viewed — re-deriving it here instead would
 * mark a version nobody has seen.
 */
async function set(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const store = storeFor(descriptor, ctx.homeDir);
  // Which view the mark belongs to comes from the descriptor, not the body:
  // it is the same descriptor /api/state answered with.
  const modeKey = modeKeyOf(descriptor);
  const body = await readJsonBody(req);
  if (!body.file || typeof body.file !== 'string' || body.file === '__proto__') {
    sendJson(res, 400, { error: 'file обязателен' });
    return;
  }
  if (body.viewed !== true && body.viewed !== false) {
    sendJson(res, 400, { error: 'viewed должен быть true или false' });
    return;
  }
  if (body.viewed === false) {
    store.unsetViewed(body.file, modeKey);
    sendJson(res, 200, { file: body.file, viewed: false });
    return;
  }
  if (!body.fingerprint || typeof body.fingerprint !== 'string') {
    sendJson(res, 400, { error: 'Чтобы отметить файл просмотренным, нужен fingerprint из /api/state' });
    return;
  }
  const record = store.setViewed(body.file, modeKey, body.fingerprint);
  sendJson(res, 200, { file: body.file, viewed: true, fingerprint: record.fingerprint, viewedAt: record.viewedAt });
}

module.exports = { set };
