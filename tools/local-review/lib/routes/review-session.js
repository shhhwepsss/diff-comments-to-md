'use strict';

const { sendJson, sendText, readJsonBody } = require('../http');
const { exportSession, writeMarkdownFile } = require('../export');
const { storeFor } = require('../stores/factory');
const { resolvePr, splitRepo } = require('../pr-search');
const sessions = require('../review-session');
const config = require('../config');

function bad(message) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = 400;
  return err;
}

function prStore(ctx, session, number) {
  return storeFor({ source: 'pr', host: session.host, owner: session.owner, repo: session.repo, number }, ctx.homeDir);
}

/**
 * Per PR of the session: how many comments its own store holds, and how many of
 * those were written before the session began. This is what the session's PR
 * list shows and what the cleanup offers to delete. Read from the stores on
 * every request: a store is a small file, and two tabs never serve each other
 * stale numbers.
 */
function countsOf(ctx, session) {
  const counts = {};
  for (const pr of session.prs) {
    const store = prStore(ctx, session, pr.number);
    counts[pr.number] = { total: store.all().length, old: store.countBefore(session.startedAt) };
  }
  return counts;
}

/** The active session with its counts, or `{ session: null }`. */
async function get(req, res, ctx) {
  const session = sessions.loadActive();
  sendJson(res, 200, session ? { session, counts: countsOf(ctx, session) } : { session: null, counts: {} });
}

/** At most this many `gh pr view` at once when the search did not carry a PR's details. */
const RESOLVE_BATCH = 4;

/**
 * The search results already carry title, branch and head of each PR in a
 * repository search, so the client sends them and nothing is fetched. What it
 * could not send (a search across repositories has no branch, and no head
 * commit) is read here, once, when the session starts — a session pins the
 * head its export names.
 */
async function completePrs(host, owner, repo, prs) {
  const out = prs.slice();
  const missing = out.map((pr, i) => i).filter((i) => !out[i].title || !out[i].headRefName || !out[i].headSha);
  for (let at = 0; at < missing.length; at += RESOLVE_BATCH) {
    await Promise.all(
      missing.slice(at, at + RESOLVE_BATCH).map(async (i) => {
        const meta = await resolvePr({ host, owner, repo, number: out[i].number }, { fresh: true });
        out[i] = {
          number: out[i].number,
          title: out[i].title || meta.title || '',
          headRefName: out[i].headRefName || meta.headRefName || null,
          headSha: out[i].headSha || meta.headSha || null,
        };
      }),
    );
  }
  return out;
}

async function post(req, res, ctx) {
  const body = await readJsonBody(req);
  if (!Array.isArray(body.prs)) throw bad('prs должен быть списком');
  const { owner, repo } = splitRepo(`${body.owner || ''}/${body.repo || ''}`);
  const host = body.host || 'github.com';
  const listed = body.prs.map(sessions.normalizePr);
  // Before gh is asked about anything: a request that cannot make a session costs no network.
  sessions.checkPrs(listed);
  const prs = await completePrs(host, owner, repo, listed);
  const session = sessions.create({ host, owner, repo, prs, carryOver: body.carryOver === true });
  sendJson(res, 201, { session, counts: countsOf(ctx, session) });
}

async function put(req, res) {
  const body = await readJsonBody(req);
  sendJson(res, 200, { session: sessions.update(body) });
}

async function finish(req, res) {
  sendJson(res, 200, { session: sessions.finish(sessions.requireActive()) });
}

async function addGeneral(req, res) {
  const body = await readJsonBody(req);
  const { session, comment } = sessions.addGeneral(body.text);
  sendJson(res, 201, { session, comment });
}

async function updateGeneral(req, res, ctx, url, id) {
  const body = await readJsonBody(req);
  const { session, comment } = sessions.updateGeneral(id, body.text);
  sendJson(res, 200, { session, comment });
}

async function removeGeneral(req, res, ctx, url, id) {
  sendJson(res, 200, { session: sessions.removeGeneral(id), removed: id });
}

/** `scope` is `all` (the default) or `pr` with the number of a PR of the session. */
function exportOf(ctx, url) {
  const session = sessions.requireActive();
  const scope = url.searchParams.get('scope') || 'all';
  if (scope !== 'all' && scope !== 'pr') throw bad('scope — all или pr');
  const number = Number(url.searchParams.get('number'));
  if (scope === 'pr' && !session.prs.some((p) => p.number === number)) throw bad('Для scope=pr нужен номер PR-а из сессии');

  const settings = config.readSettings();
  const commentsByPr = {};
  for (const pr of session.prs) commentsByPr[pr.number] = prStore(ctx, session, pr.number).all();
  const text = exportSession({
    session,
    scope,
    number,
    commentsByPr,
    copyPrompt: settings.copyPrompt,
    orchestratorPrompt: settings.orchestratorPrompt,
  });
  const comments = scope === 'pr' ? (commentsByPr[number] || []).length : Object.values(commentsByPr).reduce((n, c) => n + c.length, 0);
  return { text, scope, number, comments };
}

// Like the single-PR export, this only reads: no comment, mark or session changes.
async function exportText(req, res, ctx, url) {
  sendText(res, 200, exportOf(ctx, url).text, 'text/markdown; charset=utf-8');
}

async function exportFile(req, res, ctx, url) {
  const { text, scope, number, comments } = exportOf(ctx, url);
  const dir = config.exportsDir();
  const written = writeMarkdownFile(dir, text, undefined, scope === 'pr' ? `session-pr${number}` : 'session');
  sendJson(res, 200, { file: written.name, path: written.path, dir, count: comments });
}

/**
 * Deletes the comments of the chosen PRs that were written before the session
 * began — the ones a previous session left. What was written during this one
 * stays, and so do PRs not named. Numbers outside the session are an error:
 * this endpoint deletes, so it does not guess.
 */
async function cleanup(req, res, ctx) {
  const session = sessions.requireActive();
  const body = await readJsonBody(req);
  if (!Array.isArray(body.numbers) || !body.numbers.every((n) => session.prs.some((p) => p.number === n))) {
    throw bad('numbers — номера PR-ов этой сессии');
  }
  const removed = {};
  let total = 0;
  for (const number of new Set(body.numbers)) {
    removed[number] = prStore(ctx, session, number).removeBefore(session.startedAt);
    total += removed[number];
  }
  sendJson(res, 200, { removed: total, perPr: removed, counts: countsOf(ctx, session) });
}

/**
 * The same deletion before any session exists: the search screen asks about
 * old comments ahead of starting one, and «Удалить» there must not need a
 * session to act through. `items` names each PR with `before`, the ISO time
 * its comments must predate to go (omitted: every comment on it now).
 */
async function deleteOld(req, res, ctx) {
  const body = await readJsonBody(req);
  const { owner, repo } = splitRepo(`${body.owner || ''}/${body.repo || ''}`);
  const host = body.host || 'github.com';
  if (!Array.isArray(body.items)) throw bad('items должен быть списком');
  const now = new Date().toISOString();
  const removed = {};
  let total = 0;
  for (const item of body.items) {
    const number = Number(item && item.number);
    if (!Number.isInteger(number) || number <= 0) throw bad('Некорректный номер PR');
    if (item.before !== undefined && Number.isNaN(Date.parse(item.before))) throw bad('before — время в формате ISO');
  }
  for (const item of body.items) {
    const store = storeFor({ source: 'pr', host, owner, repo, number: Number(item.number) }, ctx.homeDir);
    removed[item.number] = store.removeBefore(item.before || now);
    total += removed[item.number];
  }
  sendJson(res, 200, { removed: total, perPr: removed });
}

/**
 * Comments already on the PRs of one repository — for the search screen, which
 * asks before any session exists. `before` (an ISO time) limits it to the
 * older ones; without it every comment counts, since a session started now
 * would not have written any of them.
 */
async function oldComments(req, res, ctx, url) {
  const p = url.searchParams;
  const { owner, repo } = splitRepo(`${p.get('owner') || ''}/${p.get('repo') || ''}`);
  const host = p.get('host') || 'github.com';
  const numbers = (p.get('numbers') || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const before = p.get('before');
  if (before && Number.isNaN(Date.parse(before))) throw bad('before — время в формате ISO');
  const counts = {};
  for (const number of numbers) {
    const store = storeFor({ source: 'pr', host, owner, repo, number }, ctx.homeDir);
    const n = before ? store.countBefore(before) : store.all().length;
    if (n > 0) counts[number] = n;
  }
  sendJson(res, 200, { counts });
}

module.exports = { get, post, put, finish, addGeneral, updateGeneral, removeGeneral, exportText, exportFile, cleanup, deleteOld, oldComments };
