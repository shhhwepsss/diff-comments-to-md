'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_NAME = '.local-review';
const RECENT_LIMIT = 10;

/** LOCAL_REVIEW_HOME lets the smoke test point the whole config elsewhere. */
function homeDir() {
  return process.env.LOCAL_REVIEW_HOME || path.join(os.homedir(), DIR_NAME);
}

function statePath() {
  return path.join(homeDir(), 'state.json');
}

function exportsDir() {
  return path.join(homeDir(), 'exports');
}

function ensureHome() {
  const home = homeDir();
  fs.mkdirSync(path.join(home, 'pr'), { recursive: true });
  fs.mkdirSync(path.join(home, 'exports'), { recursive: true });
  return home;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return {
      last: parsed && parsed.last ? parsed.last : null,
      recent: parsed && Array.isArray(parsed.recent) ? parsed.recent : [],
    };
  } catch {
    // A missing or corrupt state file is not an error: it just means "no memory".
    return { last: null, recent: [] };
  }
}

function writeState(next) {
  ensureHome();
  const tmp = `${statePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, statePath());
  return next;
}

function setLast(descriptor) {
  const state = readState();
  state.last = descriptor;
  return writeState(state);
}

function addRecent(root) {
  const state = readState();
  state.recent = [{ root, openedAt: new Date().toISOString() }]
    .concat(state.recent.filter((r) => r.root !== root))
    .slice(0, RECENT_LIMIT);
  return writeState(state);
}

function countStoredPrs() {
  try {
    return fs.readdirSync(path.join(homeDir(), 'pr')).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

module.exports = {
  homeDir,
  statePath,
  exportsDir,
  ensureHome,
  readState,
  writeState,
  setLast,
  addRecent,
  countStoredPrs,
  DIR_NAME,
  RECENT_LIMIT,
};
