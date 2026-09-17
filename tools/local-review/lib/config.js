'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_NAME = '.local-review';
const RECENT_LIMIT = 10;
const GITIGNORE_TARGETS = ['project', 'global'];

/** LOCAL_REVIEW_HOME lets the smoke test point the whole config elsewhere. */
function homeDir() {
  return process.env.LOCAL_REVIEW_HOME || path.join(os.homedir(), DIR_NAME);
}

function statePath() {
  return path.join(homeDir(), 'state.json');
}

function settingsPath() {
  return path.join(homeDir(), 'settings.json');
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

function writeJsonAtomic(file, value) {
  ensureHome();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return value;
}

function writeState(next) {
  return writeJsonAtomic(statePath(), next);
}

/**
 * User preferences, kept apart from state.json: that file is rewritten on
 * every screen change from whatever readState() returns, so a key it does not
 * know about would be dropped. `gitignoreTarget` says where the
 * `.local-review/` ignore line goes — into the repository's root .gitignore
 * ('project', the default and the historical behaviour) or into the machine's
 * global ignore file, core.excludesFile ('global').
 */
function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      gitignoreTarget:
        parsed && GITIGNORE_TARGETS.includes(parsed.gitignoreTarget) ? parsed.gitignoreTarget : 'project',
    };
  } catch {
    // Same as state.json: missing or corrupt just means defaults.
    return { gitignoreTarget: 'project' };
  }
}

function writeSettings(patch) {
  return writeJsonAtomic(settingsPath(), Object.assign(readSettings(), patch));
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
  settingsPath,
  exportsDir,
  ensureHome,
  readState,
  writeState,
  readSettings,
  writeSettings,
  setLast,
  addRecent,
  countStoredPrs,
  DIR_NAME,
  RECENT_LIMIT,
  GITIGNORE_TARGETS,
};
