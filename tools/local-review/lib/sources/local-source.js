'use strict';

const { listFiles, fileDiff } = require('../diff');
const { listCommitFiles, commitFileDiff, rangeLabel } = require('../commits');
const { descriptorKey } = require('../descriptor');

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
        const { files } = await listCommitFiles(root, from, to);
        return { files, range: { label: rangeLabel(from, to) } };
      }
      return listFiles(root, mode, base); // -> { files, range }
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
