'use strict';

// The local-folder screen: browse directories, pick a repository root, and
// confirm before climbing up to a root the user did not point at.

let rootModalResolve = null;

function openRootModal(text) {
  el.rootModalText.textContent = text;
  el.rootModalOverlay.hidden = false;
  el.rootModalCancel.focus();
  return new Promise((resolve) => {
    rootModalResolve = resolve;
  });
}

function closeRootModal(result) {
  el.rootModalOverlay.hidden = true;
  const resolve = rootModalResolve;
  rootModalResolve = null;
  if (resolve) resolve(result);
}

function browseRow(entry, onDescend) {
  const li = document.createElement('li');
  li.className = 'browse-item' + (entry.isRepo ? ' repo' : '');

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;

  const mark = document.createElement('span');
  mark.className = 'hint';
  mark.textContent = entry.isRepo ? 'репозиторий' : '';

  const open = document.createElement('button');
  open.className = 'link';
  open.textContent = 'открыть';
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    openFolder(entry.path).catch((e) => toast(e.message, true));
  });

  li.append(name, mark, open);
  // Click on the row descends; only the button opens. Descending never writes.
  if (onDescend) li.addEventListener('click', () => onDescend(entry.path));
  return li;
}

async function renderLocalScreen(startPath) {
  const data = await api(
    '/api/browse' + (startPath ? '?path=' + encodeURIComponent(startPath) : '')
  );
  const descend = (p) => renderLocalScreen(p).catch((e) => toast(e.message, true));

  el.localPath.textContent = data.path || 'Начни с домашней папки или недавних';
  el.localUp.hidden = !data.parent;
  el.localUp.onclick = () => descend(data.parent);

  el.localEntries.textContent = '';
  for (const entry of data.entries) el.localEntries.append(browseRow(entry, descend));

  // Recents come from the home config, not from the directory being browsed.
  const session = await api('/api/session');
  el.localRecent.textContent = '';
  for (const r of session.recent || []) {
    el.localRecent.append(
      browseRow({ name: r.root, path: r.root, isRepo: true }, null)
    );
  }
  if (!session.recent || !session.recent.length) {
    const li = document.createElement('li');
    li.className = 'browse-item muted';
    li.textContent = 'пока пусто';
    el.localRecent.append(li);
  }
}

async function openFolder(pathValue) {
  const value = String(pathValue || '').trim();
  if (!value) return;
  const v = await api('/api/local/validate?root=' + encodeURIComponent(value));
  if (!v.ok) {
    el.localError.textContent = v.error;
    el.localError.hidden = false;
    return; // stay on the picker, exactly as the spec requires
  }
  if (!v.sameAsRequested) {
    const confirmed = await openRootModal(
      `Выбран ${v.requested}. Это подкаталог репозитория ${v.repoRoot}. ` +
        `Дифф будем читать из корня ${v.repoRoot}. Открыть?`
    );
    if (!confirmed) {
      toast('Отменено — ничего не открыто');
      return;
    }
  }
  el.localError.hidden = true;
  const descriptor = { source: 'local', root: v.repoRoot, mode: 'working', base: 'origin/main' };
  const saved = await api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ descriptor }),
  });
  if (saved.gitignore && saved.gitignore.changed) {
    toast('в .gitignore добавлено .local-review/');
  }
  location.hash = hashFor(descriptor);
}

function wireLocalScreen() {
  el.rootModalCancel.addEventListener('click', () => closeRootModal(false));
  el.rootModalConfirm.addEventListener('click', () => closeRootModal(true));
  el.rootModalOverlay.addEventListener('click', (event) => {
    if (event.target === el.rootModalOverlay) closeRootModal(false);
  });

  el.localOpen.addEventListener('click', () => {
    openFolder(el.localManual.value).catch((e) => toast(e.message, true));
  });
  el.localManual.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openFolder(el.localManual.value).catch((e) => toast(e.message, true));
  });

  // Mode switching belongs to the local screen: a PR descriptor has no modes.
  el.modes.addEventListener('click', async (event) => {
    const button = event.target.closest('.mode');
    if (!button || !state.descriptor || state.descriptor.source !== 'local') return;
    state.descriptor.mode = button.dataset.mode;
    state.mode = button.dataset.mode;
    renderTopbar();
    try {
      await refreshState(state.activeFile);
    } catch (e) {
      toast(e.message, true);
    }
  });

  el.baseInput.addEventListener('change', async () => {
    if (!state.descriptor || state.descriptor.source !== 'local') return;
    state.descriptor.base = el.baseInput.value.trim() || 'origin/main';
    state.base = state.descriptor.base;
    try {
      await refreshState(state.activeFile);
    } catch (e) {
      toast(e.message, true);
    }
  });
}
