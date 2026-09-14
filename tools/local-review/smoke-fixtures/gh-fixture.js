#!/usr/bin/env node
'use strict';

// A stand-in for the gh CLI, driven by a JSON manifest. Used only by smoke.js:
// production always spawns the real `gh`.
//
// Manifest: { "<argv joined by spaces>": { "code": 0, "stdout": "...", "stderr": "..." } }
// The special key "*" is the fallback.

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
const hit = manifest[key] || manifest['*'];
if (!hit) {
  process.stderr.write(`gh-fixture: no fixture for: ${key}\n`);
  process.exit(98);
}
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code === undefined ? 0 : hit.code);
