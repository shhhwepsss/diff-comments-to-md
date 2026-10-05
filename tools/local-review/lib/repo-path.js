'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Paths a browser names inside a repository. The client is trusted with which
// repository to open, never with leaving it: `../`, absolute paths and
// symlinks that point outside are refused before anything is read or handed
// to a language server.

function bad(message) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = 400;
  return err;
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `child` is `root` itself or somewhere under it. */
function isInside(root, child) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The absolute path of repository-relative `rel`, or a 400. The file need not
 * exist (a document shown from the index may be gone from disk); when it, or
 * any folder on the way, does exist, its real location must still be inside
 * the repository.
 */
function resolveInRepo(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw bad('Не передан путь файла');
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw bad('Путь должен быть относительным к корню репозитория');
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs === base || !isInside(base, abs)) throw bad('Путь вне репозитория');
  // The deepest part of the path that exists decides where it really leads.
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
  if (!isInside(realOrSelf(base), realOrSelf(probe))) throw bad('Путь вне репозитория (символическая ссылка)');
  return abs;
}

/**
 * An absolute path the language server named, as a repository-relative
 * `/`-separated path — or null when it is outside (a library, the JDK).
 * Both spellings of the root are tried: a server may report real paths for a
 * repository opened through a symlink.
 */
function relativeToRepo(root, abs) {
  for (const base of new Set([path.resolve(root), realOrSelf(root)])) {
    for (const candidate of new Set([path.resolve(abs), realOrSelf(abs)])) {
      if (candidate !== base && isInside(base, candidate)) {
        return path.relative(base, candidate).split(path.sep).join('/');
      }
    }
  }
  return null;
}

module.exports = { resolveInRepo, relativeToRepo, isInside };
