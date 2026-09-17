'use strict';

const { sendJson, readJsonBody } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { storeFor } = require('../stores/factory');

/** Every handler resolves its own store: the descriptor is the only input. */
function storeOf(ctx, url) {
  return storeFor(parseDescriptor(url, ctx.defaults), ctx.homeDir);
}

async function list(req, res, ctx, url) {
  sendJson(res, 200, { comments: storeOf(ctx, url).all() });
}

async function create(req, res, ctx, url) {
  const store = storeOf(ctx, url);
  const body = await readJsonBody(req);
  // Only a literal `general: true` makes a general comment, so a client that
  // merely forgot `file` still gets a 400 instead of a silent general comment.
  const general = body.general === true;
  if (general && body.file !== undefined && body.file !== null) {
    sendJson(res, 400, { error: 'Общий комментарий не привязан к файлу: передай либо general, либо file' });
    return;
  }
  if (!general && (!body.file || typeof body.file !== 'string')) {
    sendJson(res, 400, { error: 'file обязателен' });
    return;
  }
  if (!body.text || !String(body.text).trim()) {
    sendJson(res, 400, { error: 'Пустой комментарий' });
    return;
  }
  const comment = general
    ? store.add({ file: null, startLine: null, endLine: null, text: String(body.text).trim() })
    : store.add({
        file: body.file,
        startLine: body.startLine === undefined ? null : body.startLine,
        endLine: body.endLine === undefined ? null : body.endLine,
        text: String(body.text).trim(),
        // The client only sends this when the selection is not just the
        // latest commit (see docs on lib/store.js's normalizeCommit).
        commit: body.commit,
      });
  sendJson(res, 201, { comment });
}

/** The one and only bulk delete. Callers must pass confirm:true explicitly. */
async function clearAll(req, res, ctx, url) {
  const store = storeOf(ctx, url);
  const body = await readJsonBody(req);
  if (body.confirm !== true) {
    sendJson(res, 400, {
      error: 'Нужно подтверждение: {"confirm": true}',
      remaining: store.all().length,
    });
    return;
  }
  const removed = store.clearAll();
  sendJson(res, 200, { removed, remaining: store.all().length });
}

async function updateOne(req, res, ctx, url, id) {
  const store = storeOf(ctx, url);
  const body = await readJsonBody(req);
  if (!body.text || !String(body.text).trim()) {
    sendJson(res, 400, { error: 'Пустой комментарий' });
    return;
  }
  const comment = store.update(id, String(body.text).trim());
  if (!comment) {
    sendJson(res, 404, { error: 'Комментарий не найден' });
    return;
  }
  sendJson(res, 200, { comment });
}

async function removeOne(req, res, ctx, url, id) {
  const ok = storeOf(ctx, url).remove(id);
  sendJson(res, ok ? 200 : 404, ok ? { removed: id } : { error: 'Комментарий не найден' });
}

module.exports = { list, create, clearAll, updateOne, removeOne };
