'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { ghRaw, classifyGhError } = require('./gh');
const { gitTry, findRepoRoot } = require('./git');
const { resolvePr } = require('./pr-search');

// A local clone for a GitHub PR: what lets a language server (and «open a file
// outside the diff») work on a PR at all. The reviewer either has the server
// clone the repository (`gh repo clone` + `gh pr checkout`) into a folder of
// their choosing, or names a clone they already have. Either way the binding
// is remembered in ~/.local-review/pr-clones.json, per repository: every PR
// of that repository uses the same clone, and the page says when the clone is
// not at the PR's head (the files may then differ from the diff).
//
// Nothing here runs a shell: gh and git get argv arrays. A clone is somebody
// else's code, so it is not trusted to run its own programs: the language
// servers in its node_modules/.bin are started only after the reviewer says
// so (`trusted`), see lib/lsp/registry.js.

const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of a failed command's output a job keeps to show. */
const LOG_TAIL = 4000;

function bad(message, status) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = status || 400;
  return err;
}

function clonesPath() {
  return path.join(config.homeDir(), 'pr-clones.json');
}

/** One binding per repository: the PR number is not part of the key. */
function repoKey(d) {
  return `${d.host || 'github.com'}/${d.owner}/${d.repo}`.toLowerCase();
}

// What a PR descriptor may name, before any of it reaches gh as an argument:
// a value starting with `-` would be read as a flag, a `/`, `:` or `..` would
// make `owner/repo` another repository or a URL (gh repo clone takes those).
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

/** The descriptor, its host/owner/repo checked to be plain names; a 400 otherwise. */
function checkedRepo(d) {
  const host = d.host || 'github.com';
  const repo = String(d.repo || '');
  if (!HOST_RE.test(host) || host.includes('..')) throw bad(`Некорректный хост: ${host}`);
  if (!OWNER_RE.test(String(d.owner || '')) || d.owner.length > 100) throw bad(`Некорректный владелец репозитория: ${d.owner}`);
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..' || repo.length > 100) throw bad(`Некорректное имя репозитория: ${repo}`);
  if (!Number.isInteger(d.number) || d.number <= 0) throw bad('Некорректный номер PR');
  return d;
}

/** `owner/repo`, or `host/owner/repo` off github.com — what `gh repo clone` takes. */
function repoArg(d) {
  const host = d.host || 'github.com';
  return host === 'github.com' ? `${d.owner}/${d.repo}` : `${host}/${d.owner}/${d.repo}`;
}

/** The bindings, and whether the file is there but unreadable as such (hand-edited, cut short). */
function loadClones() {
  let raw;
  try {
    raw = fs.readFileSync(clonesPath(), 'utf8');
  } catch {
    return { clones: {}, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.clones && typeof parsed.clones === 'object' && !Array.isArray(parsed.clones)) return { clones: parsed.clones, corrupt: false };
  } catch {
    /* corrupt, below */
  }
  return { clones: {}, corrupt: true };
}

function readClones() {
  // Missing or corrupt: no clone is known, the PR works by text.
  return loadClones().clones;
}

/**
 * Read, change, write back — synchronously, so two requests of this server
 * never interleave; the rename makes the write atomic for a reader. A corrupt
 * file is not silently replaced: it is kept beside as `.corrupt`.
 */
function updateClones(change) {
  const { clones, corrupt } = loadClones();
  change(clones);
  config.ensureHome();
  const file = clonesPath();
  if (corrupt) {
    try {
      fs.copyFileSync(file, `${file}.corrupt`);
    } catch {
      /* gone meanwhile: nothing to keep */
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, clones }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** { path, trusted } of the PR's repository, or null. The file is hand-editable, so it is checked. */
function bindingOf(d) {
  const record = readClones()[repoKey(d)];
  if (!record || typeof record.path !== 'string' || !path.isAbsolute(record.path)) return null;
  return { path: record.path, trusted: record.trusted === true, linkedAt: record.linkedAt || null };
}

/**
 * Remembers the folder by its real path: git reports the top of a repository
 * that way, the language servers are keyed by it, and trust must not differ
 * between two spellings (a symlink, `..`) of one folder.
 */
function bind(d, dir) {
  const real = realOrSelf(dir);
  updateClones((clones) => {
    const key = repoKey(d);
    const previous = clones[key];
    // Trust is about a folder: naming the same one again keeps it, another one starts untrusted.
    const trusted = Boolean(previous && typeof previous.path === 'string' && realOrSelf(previous.path) === real && previous.trusted === true);
    clones[key] = { path: real, trusted, linkedAt: new Date().toISOString() };
  });
}

function setTrusted(d, trusted) {
  updateClones((clones) => {
    const key = repoKey(d);
    if (!clones[key]) throw bad('Для этого PR не указан клон', 409);
    clones[key] = Object.assign({}, clones[key], { trusted: Boolean(trusted) });
  });
}

function unbind(d) {
  updateClones((clones) => {
    delete clones[repoKey(d)];
  });
}

/** `~` and `~/x` are the user's home: the dialog suggests `~/projects/<repo>`. */
function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** An absolute folder a request names, or a 400. */
function folderOf(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw bad('Не указана папка');
  const dir = expandHome(raw);
  if (!path.isAbsolute(dir)) throw bad('Путь к папке должен быть абсолютным (или начинаться с ~/)');
  return path.resolve(dir);
}

function suggestedDir(d) {
  return `~/projects/${d.repo}`;
}

/**
 * { host, owner, repo } of a remote URL, or null. The forms git and gh write:
 * `git@github.com:o/r.git`, `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r`.
 */
function parseRemote(url) {
  const s = String(url || '').trim();
  let host;
  let rest;
  // scp-like `[user@]host:path` — not `C:\\…` (one letter) and not `scheme://`.
  const scp = /^(?:[\w.-]+@)?([^:/\\@]{2,}):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    try {
      const u = new URL(s);
      host = u.hostname;
      rest = u.pathname;
    } catch {
      return null;
    }
  }
  const parts = rest
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  // Exactly owner/repo: `github.com/evil/acme/web` is not acme/web.
  if (parts.length !== 2) return null;
  return { host: host.toLowerCase(), owner: parts[0], repo: parts[1] };
}

function remoteMatches(url, d) {
  const r = parseRemote(url);
  if (!r) return false;
  // A remote names the host without the port an https address of the PR may carry.
  const host = String(d.host || 'github.com').toLowerCase().replace(/:\d+$/, '');
  return (
    r.host === host &&
    r.owner.toLowerCase() === String(d.owner).toLowerCase() &&
    r.repo.toLowerCase() === String(d.repo).toLowerCase()
  );
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * What a folder is, as a clone of the PR's repository: { ok, problem, head,
 * branch, dirty, remotes }. `ok` only for the top of a git repository one of
 * whose remotes is the PR's repository.
 */
async function inspect(dir, d) {
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) return { ok: false, problem: `Папки нет: ${dir}` };
  const top = await findRepoRoot(dir);
  if (!top) return { ok: false, problem: `${dir} — не git-репозиторий` };
  if (realOrSelf(top) !== realOrSelf(dir)) return { ok: false, problem: `${dir} — не корень репозитория (корень: ${top})` };
  const remotes = [
    ...new Set(
      String((await gitTry(['remote', '-v'], dir)) || '')
        .split('\n')
        .map((l) => l.split(/\s+/)[1])
        .filter(Boolean)
    ),
  ];
  if (!remotes.some((u) => remoteMatches(u, d))) {
    return {
      ok: false,
      problem: remotes.length
        ? `Папка — клон другого репозитория (${remotes.join(', ')}), а нужен ${d.owner}/${d.repo}`
        : `У репозитория в папке нет remote ${d.owner}/${d.repo}`,
      remotes,
    };
  }
  const head = String((await gitTry(['rev-parse', 'HEAD'], dir)) || '').trim() || null;
  const branch = String((await gitTry(['symbolic-ref', '--short', '-q', 'HEAD'], dir)) || '').trim() || null;
  const dirty = String((await gitTry(['status', '--porcelain', '--untracked-files=no'], dir)) || '').trim() !== '';
  return { ok: true, problem: null, head, branch, dirty, remotes };
}

/** The same commit, one of the two possibly abbreviated (a range in the address may be short). */
function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

// ------------------------------------------------------------------ jobs

// Cloning takes a while: it runs as a job the dialog polls. One job per
// repository at a time; finished ones are kept a little for the last poll.
const JOBS = new Map(); // id -> job
const JOB_KEEP_MS = 10 * 60 * 1000;

function jobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    steps: job.steps.map((s) => s.label),
    step: job.step,
    error: job.error,
    log: job.log,
  };
}

function runningJobFor(d) {
  const key = repoKey(d);
  for (const job of JOBS.values()) if (job.repo === key && job.status === 'running') return job;
  return null;
}

function latestJobFor(d) {
  const key = repoKey(d);
  let latest = null;
  for (const job of JOBS.values()) if (job.repo === key && (!latest || job.startedAt > latest.startedAt)) latest = job;
  return latest;
}

function forgetOldJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) if (job.status !== 'running' && now - job.endedAt > JOB_KEEP_MS) JOBS.delete(id);
}

/**
 * Runs the steps one after another: { label, args, cwd, timeoutMs, after }.
 * Every step is a gh run (argv, no shell); `after` runs once it succeeded.
 */
function startJob(d, kind, steps) {
  forgetOldJobs();
  if (runningJobFor(d)) throw bad('Для этого репозитория уже выполняется клонирование или переключение — дождитесь его', 409);
  const job = {
    id: crypto.randomBytes(8).toString('hex'),
    repo: repoKey(d),
    kind,
    status: 'running',
    steps,
    step: 0,
    error: null,
    log: '',
    startedAt: Date.now(),
    endedAt: 0,
  };
  JOBS.set(job.id, job);
  (async () => {
    for (let i = 0; i < steps.length; i += 1) {
      job.step = i;
      const step = steps[i];
      // git must not ask for a password on the terminal the server runs in: it would wait there unseen.
      const res = await ghRaw(step.args, { cwd: step.cwd, timeoutMs: step.timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } });
      const out = `${res.stdout ? res.stdout.toString('utf8') : ''}${res.stderr ? res.stderr.toString('utf8') : ''}`;
      job.log = (job.log + out).slice(-LOG_TAIL);
      if (res.spawnError || res.timedOut || res.code !== 0) {
        job.status = 'failed';
        job.error = jobError(res, step.args);
        job.endedAt = Date.now();
        return;
      }
      if (step.after) await step.after();
    }
    job.status = 'done';
    job.step = steps.length;
    job.endedAt = Date.now();
  })().catch((e) => {
    job.status = 'failed';
    job.error = e && e.message ? e.message : String(e);
    job.endedAt = Date.now();
  });
  return job;
}

/**
 * What went wrong with a step, for the dialog. gh's own failures (network,
 * auth, rate limit) keep their wording; otherwise git's last `fatal:`/`error:`
 * line says more than the first line, which is «Cloning into …».
 */
function jobError(res, args) {
  const failure = classifyGhError(res, args);
  if (failure.ghReason && failure.ghReason !== 'unknown') return failure.message;
  const lines = (res.stderr ? res.stderr.toString('utf8') : '').split('\n').map((l) => l.trim()).filter(Boolean);
  const fatal = [...lines].reverse().find((l) => /^(fatal|error|failed)\b/i.test(l));
  return (fatal || lines[lines.length - 1] || failure.message).slice(0, 300);
}

function jobById(id) {
  return JOBS.get(String(id || '')) || null;
}

// ---------------------------------------------------------------- actions

/** Everything the page shows about the PR's clone. */
async function cloneStatus(d) {
  const binding = bindingOf(d);
  const job = jobView(latestJobFor(d));
  if (!binding) return { bound: false, suggested: suggestedDir(d), job };
  const info = await inspect(binding.path, d);
  let pr = null;
  try {
    pr = await resolvePr(d);
  } catch {
    // Without the PR's head the clone still works; whether it matches is unknown.
  }
  // A commit range shows its `to`; the whole PR, its head.
  const target = d.to || (pr && pr.headSha) || null;
  return {
    bound: true,
    suggested: suggestedDir(d),
    path: binding.path,
    trusted: binding.trusted,
    valid: info.ok,
    problem: info.problem,
    head: info.head || null,
    branch: info.branch || null,
    dirty: Boolean(info.dirty),
    prHead: target,
    prBranch: pr ? pr.headRefName : null,
    onHead: info.ok && info.head && target ? sameCommit(info.head, target) : null,
    repoBin: fs.existsSync(path.join(binding.path, 'node_modules', '.bin')),
    job,
  };
}

/** `gh repo clone <repo> <dir>`, then `gh pr checkout <n>` in it. The folder must be new or empty. */
function startClone(d, rawDir) {
  checkedRepo(d);
  const dir = folderOf(rawDir);
  let stat = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) throw bad(`${dir} — это файл, а нужна папка`);
  if (stat && fs.readdirSync(dir).length > 0) throw bad(`Папка ${dir} уже существует и не пуста — выберите другую или укажите её как свой клон`);
  return startJob(d, 'clone', [
    {
      label: `gh repo clone ${repoArg(d)} ${dir}`,
      args: ['repo', 'clone', repoArg(d), dir],
      timeoutMs: CLONE_TIMEOUT_MS,
      // Bound as soon as it exists: a failed checkout leaves a clone the bar can switch later.
      after: async () => bind(d, dir),
    },
    checkoutStep(d, dir),
  ]);
}

/**
 * `gh pr checkout <n> --repo <repo>`: the PR is the descriptor's, whatever
 * gh would pick as the default repository of the folder (a clone of a fork
 * with an `upstream` remote would otherwise check out the fork's PR <n>).
 */
function checkoutStep(d, cwd) {
  const args = ['pr', 'checkout', String(d.number), '--repo', repoArg(d)];
  return { label: `gh ${args.join(' ')}`, args, cwd, timeoutMs: CHECKOUT_TIMEOUT_MS };
}

/** An existing clone: checked to be the PR's repository, then remembered. Never switched silently. */
async function link(d, rawDir) {
  checkedRepo(d);
  const dir = folderOf(rawDir);
  const info = await inspect(dir, d);
  if (!info.ok) throw bad(info.problem, 400);
  bind(d, dir);
  return dir;
}

/** `gh pr checkout <n>` in the bound clone, asked for by the reviewer; refused over uncommitted changes. */
async function startCheckout(d) {
  checkedRepo(d);
  const binding = bindingOf(d);
  if (!binding) throw bad('Для этого PR не указан клон', 409);
  const info = await inspect(binding.path, d);
  if (!info.ok) throw bad(info.problem, 409);
  if (info.dirty) throw bad('В клоне есть незакоммиченные изменения — переключение на PR отменено. Сохраните или уберите их и повторите.', 409);
  return startJob(d, 'checkout', [checkoutStep(d, binding.path)]);
}

module.exports = {
  checkedRepo,
  bindingOf,
  bind,
  unbind,
  setTrusted,
  cloneStatus,
  startClone,
  startCheckout,
  link,
  jobById,
  jobView,
  parseRemote,
  remoteMatches,
  expandHome,
  clonesPath,
  repoKey,
};
