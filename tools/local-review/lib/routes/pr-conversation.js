'use strict';

const { sendJson } = require('../http');
const { parseDescriptor } = require('../descriptor');
const { loadConversation } = require('../pr-conversation');

/**
 * GET /api/pr/conversation: a page of what was written on the PR at GitHub.
 * No cursor is the first page (with the description and the side column);
 * `timelineAfter` / `threadsAfter` continue the list they belong to.
 */
async function get(req, res, ctx, url) {
  const descriptor = parseDescriptor(url, ctx.defaults);
  if (descriptor.source !== 'pr') {
    sendJson(res, 400, { error: 'Нужен дескриптор PR-а (source=pr)' });
    return;
  }
  const p = url.searchParams;
  const cursors = { timelineAfter: p.get('timelineAfter') || '', threadsAfter: p.get('threadsAfter') || '' };
  sendJson(res, 200, await loadConversation(descriptor, cursors, p.get('fresh') === '1'));
}

module.exports = { get };
