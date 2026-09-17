'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findRepoRoot } = require('./git');
const { readState } = require('./config');

function isRepo(dir) {
  // Only the presence of .git directly inside. Never opens it.
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Directory names only. File contents are never read and files never appear in
 * the listing. `parent` is a hint for the ".." button — the server never climbs
 * on its own and never scans a default root.
 */
function browse(requestedPath) {
  const dir = path.resolve(requestedPath);
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    const err = new Error(
      e.code === 'ENOENT' ? `Каталог не найден: ${dir}` : `Каталог недоступен: ${dir}`
    );
    err.userFacing = true;
    err.status = e.code === 'ENOENT' ? 404 : 403;
    throw err;
  }
  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      isRepo: isRepo(path.join(dir, d.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    separator: path.sep,
    isRepo: isRepo(dir),
    entries,
  };
}

/** No `path` in the request -> home directory + recently opened repositories. */
function startingPoints() {
  const home = os.homedir();
  const recent = readState().recent.map((r) => ({
    name: path.basename(r.root),
    path: r.root,
    isRepo: isRepo(r.root),
    recent: true,
  }));
  return {
    path: null,
    parent: null,
    separator: path.sep,
    home,
    entries: [{ name: path.basename(home) || home, path: home, isRepo: isRepo(home) }].concat(
      recent
    ),
  };
}

async function validateRoot(requestedPath) {
  const requested = path.resolve(requestedPath);
  const root = await findRepoRoot(requested);
  if (!root) {
    return {
      ok: false,
      repoRoot: null,
      sameAsRequested: false,
      requested,
      error: `${requested} — не git-репозиторий.`,
    };
  }
  const same = path.resolve(root) === requested;
  return { ok: true, repoRoot: root, sameAsRequested: same, requested, error: null };
}

module.exports = { browse, startingPoints, validateRoot, isRepo };
