'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

// A review session is the reviewer's pass over several PRs of one repository:
// which PRs, in what order, where they stopped, what they marked as fine or
// skipped, and the remarks meant for the agent that will hand the PRs out.
// Comments on the PRs stay in the PR stores (lib/stores/factory.js); a session
// only points at them. One JSON file per session in ~/.local-review/sessions,
// never cleaned up, like the rest of that directory. At most one is active
// (finishedAt === null); a client never names a session, it always means that
// one, so there is no id to forge into a path.

const MARKS = ['lgtm', 'skip'];
/** Far more than anyone reviews in one sitting; a bound against a runaway request. */
const MAX_PRS = 200;

function bad(message, status = 400) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = status;
  return err;
}

function fileOf(id) {
  return path.join(config.sessionsDir(), `${id}.json`);
}

function writeSession(session) {
  config.ensureHome();
  fs.mkdirSync(config.sessionsDir(), { recursive: true });
  const file = fileOf(session.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return session;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A file that is not a session (hand-edited, half-written) is not one; it stays where it is. */
function readSession(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.prs) || !parsed.owner || !parsed.repo) return null;
    return {
      version: 1,
      id: parsed.id,
      host: parsed.host || 'github.com',
      owner: parsed.owner,
      repo: parsed.repo,
      prs: parsed.prs,
      current: Number.isInteger(parsed.current) ? parsed.current : 0,
      marks: isPlainObject(parsed.marks) ? parsed.marks : {},
      visited: isPlainObject(parsed.visited) ? parsed.visited : {},
      general: Array.isArray(parsed.general) ? parsed.general : [],
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt || null,
    };
  } catch {
    return null;
  }
}

/** The session being reviewed, or null. Should several be open (a hand edit), the latest one is it. */
function loadActive() {
  let names;
  try {
    names = fs.readdirSync(config.sessionsDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  let active = null;
  for (const name of names) {
    const session = readSession(path.join(config.sessionsDir(), name));
    if (!session || session.finishedAt) continue;
    if (!active || String(session.startedAt) > String(active.startedAt)) active = session;
  }
  return active;
}

function requireActive() {
  const session = loadActive();
  if (!session) throw bad('Нет активной сессии ревью', 404);
  return session;
}

function finish(session) {
  session.finishedAt = new Date().toISOString();
  return writeSession(session);
}

/** `{ number, title, headRefName, headSha }` with only what is usable; throws on a bad number. */
function normalizePr(raw) {
  const number = Number(raw && raw.number);
  if (!Number.isInteger(number) || number <= 0) throw bad('Некорректный номер PR');
  const text = (value, limit) => (typeof value === 'string' && value ? value.slice(0, limit) : null);
  return {
    number,
    title: text(raw.title, 500) || '',
    headRefName: text(raw.headRefName, 500),
    headSha: text(raw.headSha, 64),
  };
}

/** What a list of PRs must be to make a session; checked before anything is fetched for it. */
function checkPrs(prs) {
  if (!Array.isArray(prs) || prs.length === 0) throw bad('Нужен хотя бы один PR');
  if (prs.length > MAX_PRS) throw bad(`Слишком много PR-ов в сессии (больше ${MAX_PRS})`);
  if (new Set(prs.map((p) => p.number)).size !== prs.length) throw bad('Номера PR-ов в сессии не должны повторяться');
}

/**
 * Starts a session over `prs` (already normalized, in the order to review)
 * and finishes the active one. With `carryOver` the new session continues the
 * old one — «Изменить состав и порядок»: it keeps the start time (so what was
 * written during the session does not turn into «comments of a previous
 * session»), the remarks for the orchestrator, and the marks and visits of
 * the PRs that stay; it opens on the PR the reviewer was on, if it stays.
 */
function create({ host, owner, repo, prs, carryOver }) {
  if (!owner || !repo) throw bad('Нужны owner и repo');
  checkPrs(prs);
  const numbers = new Set(prs.map((p) => p.number));

  const previous = loadActive();
  const now = new Date().toISOString();
  const session = {
    version: 1,
    id: `${now.replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}-${crypto.randomBytes(3).toString('hex')}`,
    host: host || 'github.com',
    owner,
    repo,
    prs,
    current: 0,
    marks: {},
    visited: { [prs[0].number]: true },
    general: [],
    startedAt: now,
    finishedAt: null,
  };
  if (previous) {
    if (carryOver && previous.host === session.host && previous.owner === owner && previous.repo === repo) {
      session.startedAt = previous.startedAt;
      session.general = previous.general;
      for (const n of numbers) {
        if (previous.marks[n]) session.marks[n] = previous.marks[n];
        if (previous.visited[n]) session.visited[n] = true;
      }
      const index = prs.findIndex((p) => p.number === (previous.prs[previous.current] || {}).number);
      if (index >= 0) {
        session.current = index;
        session.visited[prs[index].number] = true;
      }
    }
    finish(previous);
  }
  return writeSession(session);
}

/**
 * Where the reviewer is, what they marked, which PRs they have opened.
 * `marks` maps a PR number to 'lgtm' | 'skip', or to null to take the mark
 * off; `visited` lists numbers to add (a visit is never undone).
 */
function update(patch) {
  const session = requireActive();
  const known = (n) => session.prs.some((p) => p.number === Number(n));

  if (patch.current !== undefined) {
    if (!Number.isInteger(patch.current) || patch.current < 0 || patch.current >= session.prs.length) {
      throw bad('current вне списка PR-ов сессии');
    }
  }
  if (patch.marks !== undefined) {
    if (!isPlainObject(patch.marks)) throw bad('marks должен быть объектом');
    for (const [n, mark] of Object.entries(patch.marks)) {
      if (!known(n)) throw bad(`PR #${n} нет в сессии`);
      if (mark !== null && !MARKS.includes(mark)) throw bad('Отметка — lgtm, skip или null');
    }
  }
  if (patch.visited !== undefined) {
    if (!Array.isArray(patch.visited) || !patch.visited.every(known)) throw bad('visited — номера PR-ов сессии');
  }

  if (patch.current !== undefined) session.current = patch.current;
  for (const [n, mark] of Object.entries(patch.marks || {})) {
    if (mark === null) delete session.marks[n];
    else session.marks[n] = mark;
  }
  for (const n of patch.visited || []) session.visited[Number(n)] = true;
  return writeSession(session);
}

function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw bad('Пустой комментарий');
  return text;
}

function addGeneral(text) {
  const session = requireActive();
  const now = new Date().toISOString();
  const comment = { id: crypto.randomUUID(), text: cleanText(text), createdAt: now, updatedAt: now };
  session.general.push(comment);
  writeSession(session);
  return { session, comment };
}

function updateGeneral(id, text) {
  const session = requireActive();
  const comment = session.general.find((g) => g.id === id);
  if (!comment) throw bad('Комментарий не найден', 404);
  comment.text = cleanText(text);
  comment.updatedAt = new Date().toISOString();
  writeSession(session);
  return { session, comment };
}

function removeGeneral(id) {
  const session = requireActive();
  const index = session.general.findIndex((g) => g.id === id);
  if (index === -1) throw bad('Комментарий не найден', 404);
  session.general.splice(index, 1);
  return writeSession(session);
}

module.exports = {
  MARKS,
  loadActive,
  requireActive,
  finish,
  create,
  update,
  addGeneral,
  updateGeneral,
  removeGeneral,
  normalizePr,
  checkPrs,
};
