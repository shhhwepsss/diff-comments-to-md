'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, type) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limitBytes || 2 * 1024 * 1024)) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Некорректный JSON в теле запроса');
    err.userFacing = true;
    err.status = 400;
    throw err;
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  const normalized = path.resolve(abs);
  if (!normalized.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(normalized).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * Second line of defence behind the 127.0.0.1 bind. Folder picking turns the
 * repository path into a client-supplied value, so a page on another origin
 * must not be able to make us list directories or write comment files.
 * Headers that are absent are fine: non-browser clients (curl, the smoke test)
 * send neither, browsers always send Sec-Fetch-Site.
 */
function checkOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return `Кросс-сайтовый запрос отклонён (Sec-Fetch-Site: ${site})`;
  }
  const origin = req.headers.origin;
  if (!origin) return null;
  const host = req.headers.host || '';
  const port = host.includes(':') ? ':' + host.split(':')[1] : '';
  const allowed = new Set([`http://${host}`, `http://127.0.0.1${port}`, `http://localhost${port}`]);
  if (!allowed.has(origin)) return `Кросс-сайтовый запрос отклонён (Origin: ${origin})`;
  return null;
}

module.exports = {
  sendJson,
  sendText,
  readBody,
  readJsonBody,
  serveStatic,
  checkOrigin,
  PUBLIC_DIR,
  MIME,
};
