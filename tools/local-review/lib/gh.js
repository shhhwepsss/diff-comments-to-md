'use strict';

const { spawn } = require('node:child_process');

const HTTP_STATUS = {
  'not-installed': 503,
  'not-authenticated': 401,
  'rate-limit': 429,
  network: 502,
  'not-found': 404,
  unknown: 502,
};

/**
 * The only place in the tool that runs gh. Same shape as lib/git.js: an argv
 * array, shell:false, no string interpolation — paths and search queries carry
 * spaces and Cyrillic and must survive verbatim.
 *
 * LOCAL_REVIEW_GH_BIN is the substitution point for the smoke test. When it
 * names a .js file we run it with the current node binary, because Node
 * refuses to spawn .cmd/.bat without a shell and we never want a shell here.
 */
function ghBin() {
  const raw = process.env.LOCAL_REVIEW_GH_BIN || 'gh';
  if (/\.(c|m)?js$/i.test(raw)) return { bin: process.execPath, prefixArgs: [raw] };
  return { bin: raw, prefixArgs: [] };
}

function ghRaw(args) {
  const { bin, prefixArgs } = ghBin();
  return new Promise((resolve) => {
    const child = spawn(bin, prefixArgs.concat(args), {
      windowsHide: true,
      shell: false,
      env: Object.assign({}, process.env, {
        GH_PAGER: 'cat',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
      }),
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) =>
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: e })
    );
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), spawnError: null })
    );
  });
}

/**
 * Turns a failed gh run into a sentence a human can act on. Order matters:
 * rate-limit is checked before auth, because GitHub's rate-limit message
 * sometimes contains the word "authenticated".
 */
function classifyGhError(res, args) {
  const stderr = res.stderr ? res.stderr.toString('utf8') : '';
  const lower = stderr.toLowerCase();
  let reason = 'unknown';
  let message = (stderr.split('\n').find((l) => l.trim()) || `gh ${args.join(' ')} -> ${res.code}`)
    .trim()
    .slice(0, 300);

  if (res.spawnError && res.spawnError.code === 'ENOENT') {
    reason = 'not-installed';
    message = 'gh не установлен. Установи GitHub CLI и выполни `gh auth login`.';
  } else if (lower.includes('rate limit')) {
    reason = 'rate-limit';
    message = 'Превышен лимит GitHub API. Подожди и повтори.';
  } else if (
    lower.includes('dial tcp') ||
    lower.includes('no such host') ||
    lower.includes('timeout') ||
    lower.includes('connection refused')
  ) {
    reason = 'network';
    message = 'Нет связи с GitHub.';
  } else if (
    lower.includes('http 404') ||
    lower.includes('could not resolve to a') ||
    lower.includes('not found')
  ) {
    reason = 'not-found';
    message = 'Репозиторий или PR не найден, либо нет доступа.';
  } else if (
    lower.includes('not logged') ||
    lower.includes('authentication') ||
    lower.includes('auth login') ||
    lower.includes('gh auth')
  ) {
    reason = 'not-authenticated';
    message = 'Ты не залогинен в gh. Выполни `gh auth login`.';
  }

  const err = new Error(message);
  err.userFacing = true;
  err.ghReason = reason;
  err.status = HTTP_STATUS[reason];
  return err;
}

async function gh(args) {
  const res = await ghRaw(args);
  if (res.spawnError || res.code !== 0) throw classifyGhError(res, args);
  return res.stdout.toString('utf8');
}

async function ghJson(args) {
  const text = await gh(args);
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('gh вернул не JSON — обнови GitHub CLI.');
    err.userFacing = true;
    err.status = 502;
    err.ghReason = 'unknown';
    throw err;
  }
}

/** Never throws: "gh is missing" is a screen state, not a request failure. */
async function ghStatus() {
  const res = await ghRaw(['auth', 'status']);
  if (res.spawnError) {
    return {
      installed: false,
      authenticated: false,
      login: null,
      host: null,
      message: 'gh не установлен. Установи GitHub CLI и выполни `gh auth login`.',
    };
  }
  const text = `${res.stdout.toString('utf8')}\n${res.stderr.toString('utf8')}`;
  if (res.code !== 0) {
    return {
      installed: true,
      authenticated: false,
      login: null,
      host: null,
      message: classifyGhError(res, ['auth', 'status']).message,
    };
  }
  // "  ✓ Logged in to github.com account octocat (keyring)"
  const loggedIn = /Logged in to (\S+) account (\S+)/.exec(text);
  return {
    installed: true,
    authenticated: true,
    login: loggedIn ? loggedIn[2] : null,
    host: loggedIn ? loggedIn[1] : 'github.com',
    message: null,
  };
}

module.exports = { gh, ghJson, ghRaw, ghStatus, classifyGhError, ghBin };
