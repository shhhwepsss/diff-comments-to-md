#!/usr/bin/env node
'use strict';

// A stand-in for the gh CLI, driven by a JSON manifest. Used only by smoke.js:
// production always spawns the real `gh`.
//
// Manifest: { "<argv joined by spaces>": { "code": 0, "stdout": "...", "stderr": "..." } }
// The special key "*" is the fallback.
//
// For the request-reliability tests an entry may also:
//   - be an array of such objects: the n-th run of that argv answers with the
//     n-th element (the last one repeats). Runs are counted in the call log,
//     so this needs LOCAL_REVIEW_GH_CALL_LOG.
//   - carry "delayMs": the answer is held back that long, which is what lets
//     a test see requests overlap (LOCAL_REVIEW_GH_SPAN_LOG gets a
//     "start <ms> <key>" / "end <ms> <key>" pair per run).
//   - carry "exec": [[command, ...args], ...] — run one after another in the
//     fixture's working directory before answering, for the commands that
//     act on disk (`gh repo clone` makes a clone with `git clone`, `gh pr
//     checkout` switches it with `git checkout`). A failing one ends the
//     fixture with its exit code and stderr.

const fs = require('node:fs');

const argv = process.argv.slice(2);
const manifestPath = process.env.LOCAL_REVIEW_GH_FIXTURES;

let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  process.stderr.write(`gh-fixture: cannot read manifest ${manifestPath}: ${e.message}\n`);
  process.exit(99);
}

const key = argv.join(' ');

// Optional call log, for tests that need to prove a cache actually prevented
// a second invocation (e.g. per-file PR content fetches). Only written when
// a test opts in, so it costs nothing to every other caller of this fixture.
const callLogPath = process.env.LOCAL_REVIEW_GH_CALL_LOG;
let earlierRuns = 0;
if (callLogPath) {
  try {
    earlierRuns = fs.readFileSync(callLogPath, 'utf8').split('\n').filter((l) => l === key).length;
  } catch {
    /* no log yet: this is the first run */
  }
  try {
    fs.appendFileSync(callLogPath, `${key}\n`);
  } catch {
    /* logging is a test convenience, never a reason to fail the fixture */
  }
}

const entry = manifest[key] || manifest['*'];
const hit = Array.isArray(entry) ? entry[Math.min(earlierRuns, entry.length - 1)] : entry;
if (!hit) {
  process.stderr.write(`gh-fixture: no fixture for: ${key}\n`);
  process.exit(98);
}

const spanLogPath = process.env.LOCAL_REVIEW_GH_SPAN_LOG;
function span(edge) {
  if (!spanLogPath) return;
  try {
    fs.appendFileSync(spanLogPath, `${edge} ${Date.now()} ${key}\n`);
  } catch {
    /* same as the call log: never a reason to fail the fixture */
  }
}

span('start');
for (const [command, ...args] of hit.exec || []) {
  const run = require('node:child_process').spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8' });
  if (run.status !== 0) {
    process.stderr.write(run.stderr || `gh-fixture: ${command} failed\n`);
    process.exit(run.status || 1);
  }
}
setTimeout(() => {
  if (hit.stdout) process.stdout.write(hit.stdout);
  if (hit.stderr) process.stderr.write(hit.stderr);
  span('end');
  process.exitCode = hit.code === undefined ? 0 : hit.code;
}, hit.delayMs || 0);
