#!/usr/bin/env node
'use strict';

// A stand-in for the native folder dialog (PowerShell / osascript / zenity).
// Used only by smoke.js: production always spawns the real dialog.
//
// LOCAL_REVIEW_FOLDER_DIALOG_RESULT is JSON: { "code": 0, "stdout": "...", "stderr": "...", "delayMs": 0 }

let result = {};
try {
  result = JSON.parse(process.env.LOCAL_REVIEW_FOLDER_DIALOG_RESULT || '{}');
} catch (e) {
  process.stderr.write(`folder-dialog-fixture: bad LOCAL_REVIEW_FOLDER_DIALOG_RESULT: ${e.message}\n`);
  process.exit(99);
}

setTimeout(() => {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code === undefined ? 0 : result.code);
}, result.delayMs || 0);
