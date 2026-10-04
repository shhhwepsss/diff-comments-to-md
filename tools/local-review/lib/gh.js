'use strict';

const { spawn } = require('node:child_process');

const HTTP_STATUS = {
  'not-installed': 503,
  'not-authenticated': 401,
  'rate-limit': 429,
  timeout: 504,
  network: 502,
  server: 502,
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

/**
 * Measured on a real PR (#55): every gh run is a new process with its own TCP
 * + TLS connection, and on a flaky link about one connection in twenty either
 * stalls for ~5 s or never opens — gh then gives up after Windows' own 21 s
 * connect timeout with "dial tcp … connectex: …". One such run used to fail
 * the whole request with «Нет связи с GitHub». Hence, in this order:
 *   - a run that outlives its time limit is killed (the first limit is short:
 *     a connection that has not opened by then rarely will; later attempts
 *     get longer ones, so a response that really is slow still arrives);
 *   - only failures that a repeat can cure are repeated (isTransient);
 *   - identical requests in flight share one run, and no more than
 *     `maxConcurrent` runs exist at once.
 * Everything gh does for this tool is a read, so a repeat is always safe.
 */
const DEFAULTS = {
  maxConcurrent: 6,
  attemptTimeoutsMs: [12000, 25000, 45000],
  // One entry per repeat: two repeats, three attempts in all.
  retryDelaysMs: [300, 1200],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const settings = Object.assign({}, DEFAULTS);

// `gh auth status` is not retried (it is a screen state, see ghStatus), so it
// gets one generous limit instead of the escalating ones.
const STATUS_TIMEOUT_MS = 30000;

/**
 * Changes the limits above and returns what they were, so a caller can put
 * them back. Exists for the smoke test: backoff delays and time limits must
 * be replaceable, or every test of a failing gh would sit them out for real.
 */
function configure(patch) {
  const previous = Object.assign({}, settings);
  Object.assign(settings, patch);
  return previous;
}

function ghRaw(args, options) {
  const { bin, prefixArgs } = ghBin();
  const timeoutMs = options && options.timeoutMs;
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
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), spawnError: e });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        spawnError: null,
        timedOut,
        timeoutMs,
      });
    });
  });
}

const TIMEOUT_MARKS = ['timeout', 'timed out', 'deadline exceeded', 'did not properly respond'];
const NETWORK_MARKS = [
  'dial tcp',
  'no such host',
  'connection refused',
  'connection reset',
  'forcibly closed',
  'network is unreachable',
  'no route to host',
  'server misbehaving',
  'proxyconnect',
  'unexpected eof',
];
const NOT_FOUND_MARKS = ['http 404', 'could not resolve to a', 'not found'];
const AUTH_MARKS = ['not logged', 'authentication', 'auth login', 'gh auth', 'http 401', 'bad credentials'];

/**
 * Turns a failed gh run into a sentence a human can act on. Order matters:
 *   - rate-limit before auth: GitHub's rate-limit message sometimes contains
 *     the word "authenticated";
 *   - a 5xx before timeout: "Gateway Timeout (HTTP 504)" is GitHub's failure,
 *     not the connection's;
 *   - timeout before network: a connection that never opened is reported by
 *     gh as "dial tcp … did not properly respond" / "i/o timeout", and that
 *     is a slow link, not a missing one — «нет связи» is kept for the cases
 *     where there really is no route (DNS, refused, reset).
 */
function classifyGhError(res, args) {
  const stderr = res.stderr ? res.stderr.toString('utf8') : '';
  const lower = stderr.toLowerCase();
  const has = (marks) => marks.some((mark) => lower.includes(mark));
  const serverStatus = /http (5\d\d)/.exec(lower);
  let reason = 'unknown';
  let message = (stderr.split('\n').find((l) => l.trim()) || `gh ${args.join(' ')} -> ${res.code}`)
    .trim()
    .slice(0, 300);

  if (res.spawnError && res.spawnError.code === 'ENOENT') {
    reason = 'not-installed';
    message = 'gh не установлен. Установи GitHub CLI и выполни `gh auth login`.';
  } else if (res.timedOut) {
    reason = 'timeout';
    message = `GitHub не ответил за ${Math.round(res.timeoutMs / 1000)} с — запрос прерван. Повтори попытку.`;
  } else if (lower.includes('secondary rate limit') || lower.includes('abuse detection')) {
    reason = 'rate-limit';
    message = 'GitHub временно ограничил частоту запросов (secondary rate limit). Подожди пару минут и повтори.';
  } else if (lower.includes('rate limit')) {
    reason = 'rate-limit';
    message = 'Превышен лимит GitHub API. Подожди и повтори.';
  } else if (serverStatus) {
    reason = 'server';
    message = `GitHub ответил ошибкой сервера (HTTP ${serverStatus[1]}). Повтори чуть позже.`;
  } else if (has(TIMEOUT_MARKS)) {
    reason = 'timeout';
    message = 'GitHub не ответил вовремя: соединение не установилось. Повтори попытку.';
  } else if (has(NETWORK_MARKS)) {
    reason = 'network';
    message = 'Нет связи с GitHub: проверь интернет, VPN или прокси.';
  } else if (has(NOT_FOUND_MARKS)) {
    reason = 'not-found';
    message = 'Репозиторий или PR не найден, либо нет доступа.';
  } else if (has(AUTH_MARKS)) {
    reason = 'not-authenticated';
    message = 'Ты не залогинен в gh. Выполни `gh auth login`.';
  }

  const err = new Error(message);
  err.userFacing = true;
  err.ghReason = reason;
  err.status = HTTP_STATUS[reason];
  return err;
}

// ------------------------------------------------------------ retry policy

const TRANSIENT_REASONS = new Set(['timeout', 'network', 'server']);

/**
 * Whether running the same request again can help. Deliberately narrow: a
 * 404 / 406 / 422, a missing login and a rate limit all answer the same way
 * the second time, and repeating a rate-limited request only makes the limit
 * last longer. Anything unrecognised ('unknown') is not repeated either.
 */
function isTransient(err) {
  return Boolean(err) && TRANSIENT_REASONS.has(err.ghReason);
}

/**
 * Runs `attempt(index)` until it succeeds, fails for good, or the delays run
 * out: one repeat per entry of `delaysMs`, each after that long a pause.
 */
async function retryTransient(attempt, { delaysMs, sleep }) {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt(index);
    } catch (e) {
      if (!isTransient(e) || index >= delaysMs.length) throw e;
      await sleep(delaysMs[index]);
    }
  }
}

// ------------------------------------------------------ concurrency limit

/**
 * At most `limit()` tasks at once, the rest wait in order. The limit is read
 * on every decision, so it can be changed while tasks are queued.
 */
function createLimiter(limit) {
  const waiting = [];
  let running = 0;

  const pump = () => {
    while (running < limit() && waiting.length) waiting.shift()();
  };

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          running += 1;
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              running -= 1;
              pump();
            });
        });
        pump();
      });
    },
  };
}

// ------------------------------------------- one run per identical request

/**
 * While a task for `key` is running, everyone asking for the same key gets
 * that task's promise. Not a cache: the entry is gone the moment it settles.
 */
function shareInFlight(pending, key, task) {
  const running = pending.get(key);
  if (running) return running;
  const promise = Promise.resolve()
    .then(task)
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

// --------------------------------------------- answers that cannot change

// For requests addressed by commit sha only (`{ immutable: true }`): the
// answer is the same forever, so it is kept — bounded, least recently used out.
const IMMUTABLE = new Map(); // request key -> stdout text
const IMMUTABLE_LIMIT = 50;

function rememberImmutable(key, text) {
  IMMUTABLE.delete(key);
  IMMUTABLE.set(key, text);
  if (IMMUTABLE.size > IMMUTABLE_LIMIT) IMMUTABLE.delete(IMMUTABLE.keys().next().value);
}

// ------------------------------------------------------------------- gh()

const limiter = createLimiter(() => settings.maxConcurrent);
const IN_FLIGHT = new Map(); // request key -> Promise<stdout text>

/** One run of gh, time-limited; throws the classified error on any failure. */
async function ghOnce(args, attemptIndex) {
  const limits = settings.attemptTimeoutsMs;
  const timeoutMs = limits[Math.min(attemptIndex, limits.length - 1)];
  const startedAt = Date.now();
  const res = await ghRaw(args, { timeoutMs });
  const failure = res.spawnError || res.timedOut || res.code !== 0 ? classifyGhError(res, args) : null;
  logAttempt(args, attemptIndex, Date.now() - startedAt, failure);
  if (failure) throw failure;
  return res.stdout.toString('utf8');
}

/**
 * LOCAL_REVIEW_GH_DEBUG=1 prints one line per gh run to stderr: how long it
 * took, which attempt it was and how it ended. This is how #55 was diagnosed;
 * it stays because "GitHub is slow" is otherwise invisible from the outside.
 */
function logAttempt(args, attemptIndex, ms, failure) {
  if (!process.env.LOCAL_REVIEW_GH_DEBUG) return;
  const outcome = failure ? `FAIL ${failure.ghReason}` : 'ok';
  console.error(`[gh] ${String(ms).padStart(6)} ms  attempt ${attemptIndex + 1}  ${outcome}  ${args.join(' ')}`);
}

/**
 * `options.immutable` — the request names its subject by commit sha, so a
 * successful answer may be reused for the life of the server.
 */
function gh(args, options) {
  const immutable = Boolean(options && options.immutable);
  const key = args.join('\u0000');
  if (immutable && IMMUTABLE.has(key)) {
    const text = IMMUTABLE.get(key);
    rememberImmutable(key, text); // touch for LRU
    return Promise.resolve(text);
  }
  return shareInFlight(IN_FLIGHT, key, async () => {
    // The slot is held per attempt, not across the pause between attempts.
    const text = await retryTransient((index) => limiter.run(() => ghOnce(args, index)), {
      delaysMs: settings.retryDelaysMs,
      sleep: settings.sleep,
    });
    if (immutable) rememberImmutable(key, text);
    return text;
  });
}

async function ghJson(args, options) {
  const text = await gh(args, options);
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
  const res = await ghRaw(['auth', 'status'], { timeoutMs: STATUS_TIMEOUT_MS });
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

module.exports = {
  gh,
  ghJson,
  ghRaw,
  ghStatus,
  classifyGhError,
  isTransient,
  retryTransient,
  createLimiter,
  shareInFlight,
  configure,
  ghBin,
};
