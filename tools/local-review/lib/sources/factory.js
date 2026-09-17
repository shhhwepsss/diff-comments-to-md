'use strict';

const { createLocalSource } = require('./local-source');
const { createPrSource } = require('./pr-source');

function createSource(descriptor) {
  if (descriptor.source === 'local') return createLocalSource(descriptor);
  if (descriptor.source === 'pr') return createPrSource(descriptor);
  const err = new Error(`Неизвестный источник: ${descriptor.source}`);
  err.userFacing = true;
  err.status = 400;
  throw err;
}

module.exports = { createSource };
