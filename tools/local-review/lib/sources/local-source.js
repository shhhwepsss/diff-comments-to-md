'use strict';

const { listFiles, fileDiff, numstat, withLineCounts } = require('../diff');
const { listCommitFiles, commitFileDiff, rangeLabel } = require('../commits');
const { descriptorKey } = require('../descriptor');
const { withLocalFingerprints } = require('../viewed');

function createLocalSource(descriptor) {
  const { root, mode, base, from, to } = descriptor;
  return {
    id: descriptorKey(descriptor),
    kind: 'local',
    descriptor,
    // Both sources take the same arguments; `options` is meaningless here
    // because git is re-read on every call anyway.
    async listFiles() {
      if (mode === 'commits') {
        const { files, args } = await listCommitFiles(root, from, to);
        // Side by side: neither needs the other, and both walk the whole diff.
        const [stats, marked] = await Promise.all([numstat(root, args), withLocalFingerprints(root, mode, files)]);
        return { files: withLineCounts(marked, stats), range: { label: rangeLabel(from, to) } };
      }
      const { files, range } = await listFiles(root, mode, base);
      // Only the file list carries fingerprints and line counts: fileDiff
      // re-lists files for every request and has no use for hashing the
      // worktree, or for a numstat of the whole diff, again.
      const [stats, marked] = await Promise.all([numstat(root, range.args), withLocalFingerprints(root, mode, files)]);
      return { files: withLineCounts(marked, stats), range };
    },
    async fileDiff(filePath, context) {
      if (mode === 'commits') return commitFileDiff(root, from, to, filePath, context);
      return fileDiff(root, mode, base, filePath, context);
    },
    async meta() {
      return null; // no PR header on the local screen
    },
  };
}

module.exports = { createLocalSource };
