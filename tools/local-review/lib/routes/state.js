'use strict';

const { sendJson } = require('../http');
const { parseDescriptor, MODES } = require('../descriptor');
const { defaultBase } = require('../git');
const { createSource } = require('../sources/factory');
const { storeFor } = require('../stores/factory');

function isFresh(url) {
  return url.searchParams.get('fresh') === '1';
}

async function getState(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const store = storeFor(descriptor, ctx.homeDir);
  const source = createSource(descriptor);

  const { files, range } = await source.listFiles({ fresh: isFresh(url) });
  // The PR header is metadata, not diff: a failure here surfaces as a readable
  // JSON error instead of an empty screen.
  const pr = descriptor.source === 'pr' ? await source.meta() : null;
  const counts = store.countsByFile();

  // The client may send no base at all; answer with the revision Base mode
  // would actually use, so the header shows `origin/production` and not a
  // placeholder the repository has never heard of.
  const base =
    descriptor.source !== 'local'
      ? descriptor.base
      : range.base || descriptor.base || (await defaultBase(descriptor.root));

  sendJson(res, 200, {
    repoRoot: descriptor.source === 'local' ? descriptor.root : null,
    source: descriptor.source,
    mode: descriptor.mode,
    base,
    pr,
    rangeLabel:
      pr && pr.baseRefName && pr.headRefName
        ? `${pr.baseRefName} ← ${pr.headRefName}`
        : range.label,
    totalComments: store.all().length,
    files: files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      kind: f.kind,
      untracked: Boolean(f.untracked),
      comments: counts[f.path] || 0,
    })),
    // Comments can outlive the diff they were written against; surface them
    // so nothing silently disappears from the UI.
    orphanFiles: Object.keys(counts)
      .filter((p) => !files.some((f) => f.path === p))
      .map((p) => ({ path: p, comments: counts[p], orphan: true })),
  });
}

async function getDiff(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  const file = url.searchParams.get('file');
  if (!file) {
    sendJson(res, 400, { error: 'Не передан параметр file' });
    return;
  }
  const source = createSource(descriptor);
  sendJson(res, 200, await source.fileDiff(file, 3, { fresh: isFresh(url) }));
}

module.exports = { getState, getDiff, MODES };
