'use strict';

const path = require('node:path');
const { CommentStore, STORE_DIR, STORE_FILE } = require('../store');

/** Anything outside [A-Za-z0-9._-] becomes '_' so a PR key is a safe filename. */
function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The single place where a descriptor becomes a path. Keeping it in one
 * function is what makes "stores never overlap" checkable instead of trusted.
 */
function commentsFilePath(descriptor, homeDir) {
  if (descriptor.source === 'local') {
    return path.join(descriptor.root, STORE_DIR, STORE_FILE);
  }
  if (descriptor.source === 'pr') {
    const name =
      [descriptor.host, descriptor.owner, descriptor.repo, descriptor.number]
        .map(sanitizeSegment)
        .join('__') + '.json';
    return path.join(homeDir, 'pr', name);
  }
  const err = new Error(`Неизвестный источник: ${descriptor.source}`);
  err.userFacing = true;
  err.status = 400;
  throw err;
}

/**
 * A fresh store per request: load() re-reads the file, so two browser tabs
 * (one on a local repo, one on a PR) never serve each other stale data.
 */
function storeFor(descriptor, homeDir) {
  return new CommentStore(commentsFilePath(descriptor, homeDir));
}

module.exports = { commentsFilePath, storeFor, sanitizeSegment };
