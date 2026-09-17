'use strict';

const { sendJson, sendText, serveStatic, checkOrigin } = require('../http');
const state = require('./state');
const comments = require('./comments');
const exportRoutes = require('./export');
const browseRoutes = require('./browse');
const session = require('./session');
const ghRoutes = require('./gh');
const commitsRoutes = require('./commits');
const viewedRoutes = require('./viewed');

const ROUTES = [
  { method: 'GET', path: '/api/state', handle: state.getState },
  { method: 'GET', path: '/api/diff', handle: state.getDiff },
  { method: 'GET', path: '/api/commits', handle: commitsRoutes.list },
  { method: 'GET', path: '/api/comments', handle: comments.list },
  { method: 'POST', path: '/api/comments', handle: comments.create },
  // Must be matched before the /api/comments/:id pattern below.
  { method: 'POST', path: '/api/comments/clear-all', handle: comments.clearAll },
  { method: 'POST', path: '/api/viewed', handle: viewedRoutes.set },
  { method: 'GET', path: '/api/export/text', handle: exportRoutes.exportText },
  { method: 'POST', path: '/api/export/file', handle: exportRoutes.exportFile },
  { method: 'GET', path: '/api/browse', handle: browseRoutes.browse },
  { method: 'GET', path: '/api/local/validate', handle: browseRoutes.validate },
  { method: 'GET', path: '/api/session', handle: session.get },
  { method: 'POST', path: '/api/session', handle: session.post },
  { method: 'GET', path: '/api/gh/status', handle: ghRoutes.status },
  { method: 'GET', path: '/api/pr/search', handle: ghRoutes.search },
  { method: 'GET', path: '/api/pr/resolve', handle: ghRoutes.resolve },
];

const COMMENT_ID = /^\/api\/comments\/([^/]+)$/;

function createApp(ctx) {
  return async function handle(req, res) {
    const originProblem = checkOrigin(req);
    if (originProblem) {
      sendJson(res, 403, { error: originProblem });
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed');
        return;
      }
      serveStatic(req, res, pathname);
      return;
    }

    for (const route of ROUTES) {
      if (route.path === pathname && route.method === req.method) {
        await route.handle(req, res, ctx, url);
        return;
      }
    }

    const idMatch = COMMENT_ID.exec(pathname);
    if (idMatch) {
      const id = idMatch[1];
      if (req.method === 'PUT' || req.method === 'PATCH') {
        await comments.updateOne(req, res, ctx, url, id);
        return;
      }
      if (req.method === 'DELETE') {
        await comments.removeOne(req, res, ctx, url, id);
        return;
      }
    }

    sendJson(res, 404, { error: `Нет такого эндпоинта: ${req.method} ${pathname}` });
  };
}

module.exports = { createApp, ROUTES, MODES: state.MODES };
