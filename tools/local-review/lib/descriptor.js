'use strict';

const MODES = new Set(['working', 'staged', 'base']);

function bad(message) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = 400;
  return err;
}

/**
 * A descriptor is the whole answer to "what are we looking at". It travels in
 * the query string of every request, including POST and DELETE, so there is
 * exactly one place it is read from and no mutable "current selection" on the
 * server that two browser tabs could fight over.
 */
function parseDescriptor(url, defaults) {
  const p = url.searchParams;
  const source = p.get('source');

  if (!source) {
    // No descriptor in the request -> CLI defaults, exactly like mode/base today.
    if (!defaults) throw bad('Не выбран источник: открой папку или PR.');
    const mode = p.get('mode') || defaults.mode;
    const base = p.get('base') || defaults.base;
    if (!MODES.has(mode)) throw bad(`Неизвестный режим: ${mode}`);
    return Object.assign({}, defaults, { mode, base });
  }

  if (source === 'local') {
    const root = p.get('root');
    if (!root) throw bad('Не передан параметр root');
    const mode = p.get('mode') || 'working';
    // Empty base = "the repository's default branch"; resolveRange decides
    // which revision that is, because only it can ask git.
    const base = p.get('base') || '';
    if (!MODES.has(mode)) throw bad(`Неизвестный режим: ${mode}`);
    return { source: 'local', root, mode, base };
  }

  if (source === 'pr') {
    const host = p.get('host') || 'github.com';
    const owner = p.get('owner');
    const repo = p.get('repo');
    const number = Number(p.get('number'));
    if (!owner || !repo) throw bad('Для PR нужны owner и repo');
    if (!Number.isInteger(number) || number <= 0) throw bad('Некорректный номер PR');
    return { source: 'pr', host, owner, repo, number };
  }

  throw bad(`Неизвестный источник: ${source}`);
}

function descriptorKey(d) {
  return d.source === 'local'
    ? `local:${d.root}:${d.mode}:${d.base}`
    : `pr:${d.host}/${d.owner}/${d.repo}#${d.number}`;
}

function descriptorLabel(d) {
  return d.source === 'local' ? d.root : `${d.owner}/${d.repo}#${d.number}`;
}

module.exports = { parseDescriptor, descriptorKey, descriptorLabel, MODES };
