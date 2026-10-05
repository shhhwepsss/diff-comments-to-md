'use strict';

const { sendJson, readJsonBody } = require('../http');
const { parseDescriptor } = require('../descriptor');
const prClone = require('../pr-clone');
const { getManager } = require('./lsp');

// The local clone of a GitHub PR (lib/pr-clone.js):
//   GET  /api/pr/clone?<PR descriptor>       — is there one, where, is it at the PR's head, trusted?
//   POST /api/pr/clone?<PR descriptor>       — body { action, dir?, trusted? }:
//        clone    { dir }      gh repo clone + gh pr checkout, as a job (202 { job });
//        link     { dir }      an existing clone of the same repository;
//        checkout              gh pr checkout in the bound clone, as a job;
//        trust    { trusted }  may servers come from the clone's node_modules/.bin;
//        unlink                forget the clone (the folder stays).
//   GET  /api/pr/clone/job?id=<id>           — how a clone or checkout is going.
// The descriptor's PR is what is cloned and checked out; nothing else is
// taken from the browser but a folder.

function prDescriptor(url, ctx) {
  const d = parseDescriptor(url, ctx.defaults);
  if (d.source !== 'pr') {
    const err = new Error('Клон бывает только у PR-а (source=pr)');
    err.userFacing = true;
    err.status = 400;
    throw err;
  }
  return d;
}

async function get(req, res, ctx, url) {
  sendJson(res, 200, await prClone.cloneStatus(prDescriptor(url, ctx)));
}

async function post(req, res, ctx, url) {
  const d = prDescriptor(url, ctx);
  const body = await readJsonBody(req);
  const before = prClone.bindingOf(d);
  switch (body.action) {
    case 'clone': {
      const job = prClone.startClone(d, body.dir);
      sendJson(res, 202, { job: prClone.jobView(job) });
      return;
    }
    case 'checkout': {
      const job = await prClone.startCheckout(d);
      sendJson(res, 202, { job: prClone.jobView(job) });
      return;
    }
    case 'link':
      await prClone.link(d, body.dir);
      break;
    case 'trust':
      if (typeof body.trusted !== 'boolean') {
        sendJson(res, 400, { error: 'trusted должен быть true или false' });
        return;
      }
      prClone.setTrusted(d, body.trusted);
      break;
    case 'unlink':
      prClone.unbind(d);
      break;
    default:
      sendJson(res, 400, { error: `Неизвестное действие: ${body.action}` });
      return;
  }
  // The servers of the old folder, or of the old trust, answer for nothing now.
  if (before) await getManager(ctx).stopRoot(before.path);
  sendJson(res, 200, await prClone.cloneStatus(d));
}

async function job(req, res, ctx, url) {
  const found = prClone.jobById(url.searchParams.get('id'));
  if (!found) {
    sendJson(res, 404, { error: 'Задача не найдена (сервер ревью перезапускался?)' });
    return;
  }
  sendJson(res, 200, { job: prClone.jobView(found) });
}

module.exports = { get, post, job };
