'use strict';

const { spawn } = require('node:child_process');

/**
 * Runs git with an argv array (never a shell string): Windows paths contain
 * spaces and backslashes, and we never want the shell to re-split them.
 * Returns stdout as a Buffer so we can handle -z output and any encoding.
 */
function gitRaw(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      // Keep git from paging / colorizing / prompting for credentials.
      env: Object.assign({}, process.env, {
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      }),
    });

    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (e) => {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e.message)) });
    });
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

async function git(args, cwd) {
  const res = await gitRaw(args, cwd);
  if (res.code !== 0) {
    const message =
      res.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed (code ${res.code})`;
    const error = new Error(message);
    error.gitArgs = args;
    error.gitCode = res.code;
    throw error;
  }
  return res.stdout;
}

async function gitText(args, cwd) {
  return (await git(args, cwd)).toString('utf8');
}

/** null instead of throwing, for probes like rev-parse / merge-base. */
async function gitTry(args, cwd) {
  const res = await gitRaw(args, cwd);
  if (res.code !== 0) return null;
  return res.stdout.toString('utf8');
}

async function findRepoRoot(startDir) {
  const out = await gitTry(['rev-parse', '--show-toplevel'], startDir);
  if (!out) return null;
  return out.trim().split('\\').join('/');
}

async function hasHead(cwd) {
  return (await gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)) !== null;
}

async function revExists(rev, cwd) {
  return (await gitTry(['rev-parse', '--verify', '--quiet', rev + '^{commit}'], cwd)) !== null;
}

async function mergeBase(rev, cwd) {
  const out = await gitTry(['merge-base', rev, 'HEAD'], cwd);
  return out ? out.trim() : null;
}

const BASE_FALLBACKS = ['origin/main', 'origin/master', 'main', 'master'];

/**
 * The revision a branch is measured against when the user named none.
 * `origin/HEAD` is what the remote itself calls its default branch, so it is
 * right in repositories whose main branch is not called "main" — the guessed
 * names are only for a repo with no remote, or one that never fetched a HEAD.
 */
async function defaultBase(cwd) {
  const out = await gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  const named = out ? out.trim() : '';
  if (named) return named;
  for (const candidate of BASE_FALLBACKS) {
    if (await revExists(candidate, cwd)) return candidate;
  }
  return 'origin/main';
}

/**
 * `git show <rev>:<path>` as raw bytes, or null on any failure — missing
 * revision, path not present at that revision, no HEAD yet, etc. Callers rely
 * on this null-on-anything-wrong behaviour instead of special-casing "added"
 * / "deleted" / "no HEAD" themselves: a path that does not exist at `rev`
 * naturally 404s here exactly like it would at the git-cli level.
 * `rev` may be the empty string to mean the index (`git show :<path>`).
 */
async function gitShow(rev, filePath, cwd) {
  const res = await gitRaw(['show', `${rev}:${filePath}`], cwd);
  if (res.code !== 0) return null;
  return res.stdout;
}

module.exports = {
  git,
  gitText,
  gitTry,
  findRepoRoot,
  hasHead,
  revExists,
  mergeBase,
  defaultBase,
  gitShow,
};
