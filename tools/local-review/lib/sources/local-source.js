'use strict';

const { listFiles, fileDiff } = require('../diff');
const { descriptorKey } = require('../descriptor');

function createLocalSource(descriptor) {
  const { root, mode, base } = descriptor;
  return {
    id: descriptorKey(descriptor),
    kind: 'local',
    descriptor,
    // Both sources take the same arguments; `options` is meaningless here
    // because git is re-read on every call anyway.
    async listFiles() {
      return listFiles(root, mode, base); // -> { files, range }
    },
    async fileDiff(filePath, context) {
      return fileDiff(root, mode, base, filePath, context);
    },
    async meta() {
      return null; // no PR header on the local screen
    },
  };
}

module.exports = { createLocalSource };
