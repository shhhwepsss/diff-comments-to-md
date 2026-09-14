'use strict';

// Fetch + toast: the two things every screen needs and nothing else does.

async function api(pathname, options) {
  const res = await fetch(pathname, options);
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = payload && payload.error ? payload.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

/**
 * Descriptor -> query string. One place builds it, every request uses it —
 * including POST and DELETE, so the server reads it from exactly one place.
 */
function qs(extra) {
  const p = new URLSearchParams();
  const d = state.descriptor;
  if (d && d.source === 'local') {
    p.set('source', 'local');
    p.set('root', d.root);
    p.set('mode', d.mode || 'working');
    p.set('base', d.base || 'origin/main');
  } else if (d && d.source === 'pr') {
    p.set('source', 'pr');
    p.set('host', d.host);
    p.set('owner', d.owner);
    p.set('repo', d.repo);
    p.set('number', String(d.number));
  }
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}

function hashFor(d) {
  if (!d) return '';
  if (d.source === 'local') return `#/local/${encodeURIComponent(d.root)}`;
  return `#/pr/${d.host}/${d.owner}/${d.repo}/${d.number}`;
}

function descriptorFromHash(hash) {
  const parts = String(hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean);
  if (parts[0] === 'local' && parts[1]) {
    return {
      source: 'local',
      root: decodeURIComponent(parts[1]),
      mode: 'working',
      base: 'origin/main',
    };
  }
  if (parts[0] === 'pr' && parts.length >= 5) {
    return {
      source: 'pr',
      host: parts[1],
      owner: parts[2],
      repo: parts[3],
      number: Number(parts[4]),
    };
  }
  return null;
}

let toastTimer = null;
function toast(message, isError) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('error', Boolean(isError));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, isError ? 8000 : 5000);
}
