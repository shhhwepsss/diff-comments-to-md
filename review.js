#!/usr/bin/env node
'use strict';

// Thin shim so the tool can be started from the repo root as `node review.js`.
require('./tools/local-review/review.js').main();
