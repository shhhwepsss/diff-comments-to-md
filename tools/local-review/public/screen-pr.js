'use strict';

// The GitHub PR screen: gh status, search form, results. The diff of a PR is
// rendered by diff-view.js — the same code the local screen uses.

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function prRow(item) {
  const li = document.createElement('li');
  li.className = 'pr-item';

  const num = document.createElement('span');
  num.className = 'pr-number';
  num.textContent = `#${item.number}`;

  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = item.title || '';

  const meta = document.createElement('span');
  meta.className = 'pr-meta';
  const repo = item.owner && item.repo ? `${item.owner}/${item.repo}` : '';
  // Branch is "—" for a global search: gh search prs does not return it.
  meta.textContent = [
    repo,
    item.author || '',
    item.headRefName || '—',
    String(item.state || '').toLowerCase(),
    formatDate(item.updatedAt),
  ]
    .filter(Boolean)
    .join(' · ');

  const open = document.createElement('button');
  open.className = 'link';
  open.textContent = 'открыть';
  open.disabled = !item.owner || !item.repo;
  open.addEventListener('click', () => {
    location.hash = hashFor({
      source: 'pr',
      host: item.host || 'github.com',
      owner: item.owner,
      repo: item.repo,
      number: item.number,
    });
  });

  li.append(num, title, meta, open);
  return li;
}

async function runPrSearch() {
  el.prResults.textContent = '';
  const params = new URLSearchParams();
  const repo = el.prRepo.value.trim();
  const q = el.prQuery.value.trim();
  if (repo) params.set('repo', repo);
  if (q) params.set('q', q);
  params.set('state', el.prState.value || 'open');

  let data;
  try {
    data = await api('/api/pr/search?' + params.toString());
  } catch (e) {
    // On screen, not in a toast that disappears in eight seconds.
    const box = document.createElement('li');
    box.className = 'browse-item muted';
    box.textContent = e.message;
    el.prResults.append(box);
    return;
  }

  if (!data.items.length) {
    const box = document.createElement('li');
    box.className = 'browse-item muted';
    box.textContent = 'Ничего не найдено';
    el.prResults.append(box);
  }
  for (const item of data.items) el.prResults.append(prRow(item));
  el.prConfigLine.textContent = `Комментарии к PR-ам: ${data.homeDir} (хранится PR-ов: ${data.storedPrs})`;
}

async function renderPrScreen() {
  const status = await api('/api/gh/status');
  el.ghStatus.textContent = '';
  if (!status.installed || !status.authenticated) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.textContent = status.message;
    el.ghStatus.append(box);
    el.prSearchBtn.disabled = true;
    el.prResults.textContent = '';
    return; // a readable message, never an empty screen or a stack trace
  }
  el.prSearchBtn.disabled = false;
  el.ghStatus.textContent = `gh: ${status.login || '?'} @ ${status.host || 'github.com'}`;
  await runPrSearch();
}

/** The PR header above the diff. Hidden entirely for a local descriptor. */
function renderPrHeader(pr) {
  el.prHeader.textContent = '';
  if (!pr) {
    el.prHeader.hidden = true;
    return;
  }
  el.prHeader.hidden = false;

  const title = document.createElement('span');
  title.className = 'pr-title';
  title.textContent = `#${pr.number} ${pr.title || ''}`;

  const meta = document.createElement('span');
  meta.className = 'pr-meta';
  meta.textContent = [
    `${pr.owner}/${pr.repo}`,
    pr.author || '',
    pr.baseRefName && pr.headRefName ? `${pr.baseRefName} ← ${pr.headRefName}` : '',
    String(pr.state || '').toLowerCase() + (pr.isDraft ? ' · черновик' : ''),
  ]
    .filter(Boolean)
    .join(' · ');

  const link = document.createElement('a');
  link.className = 'link';
  link.href = pr.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = 'открыть на GitHub';

  el.prHeader.append(title, meta, link);
}

function wirePrScreen() {
  el.prSearchBtn.addEventListener('click', () => runPrSearch().catch((e) => toast(e.message, true)));
  for (const node of [el.prRepo, el.prQuery]) {
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runPrSearch().catch((e) => toast(e.message, true));
    });
  }
  el.prState.addEventListener('change', () => runPrSearch().catch((e) => toast(e.message, true)));
}
