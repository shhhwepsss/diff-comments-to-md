'use strict';

const el = {
  repoRoot: document.getElementById('repo-root'),
  tabLocal: document.getElementById('tab-local'),
  tabPr: document.getElementById('tab-pr'),
  topbarMid: document.getElementById('topbar-mid'),
  modes: document.getElementById('modes'),
  baseInput: document.getElementById('base-input'),
  reload: document.getElementById('reload'),
  total: document.getElementById('comment-total'),
  copyAll: document.getElementById('copy-all'),
  exportMd: document.getElementById('export-md'),
  clearAll: document.getElementById('clear-all'),
  rangeLabel: document.getElementById('range-label'),
  fileList: document.getElementById('file-list'),
  fileHeader: document.getElementById('file-header'),
  diff: document.getElementById('diff'),
  overlay: document.getElementById('modal-overlay'),
  modalText: document.getElementById('modal-text'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm'),

  // folder picker
  localPath: document.getElementById('local-path'),
  localUp: document.getElementById('local-up'),
  localEntries: document.getElementById('local-entries'),
  localRecent: document.getElementById('local-recent'),
  localManual: document.getElementById('local-manual'),
  localOpen: document.getElementById('local-open'),
  localError: document.getElementById('local-error'),
  rootModalOverlay: document.getElementById('root-modal-overlay'),
  rootModalText: document.getElementById('root-modal-text'),
  rootModalCancel: document.getElementById('root-modal-cancel'),
  rootModalConfirm: document.getElementById('root-modal-confirm'),

  // PR screen
  ghStatus: document.getElementById('gh-status'),
  prRepo: document.getElementById('pr-repo'),
  prQuery: document.getElementById('pr-query'),
  prState: document.getElementById('pr-state'),
  prSearchBtn: document.getElementById('pr-search-btn'),
  prResults: document.getElementById('pr-results'),
  prConfigLine: document.getElementById('pr-config-line'),
  prHeader: document.getElementById('pr-header'),
};

const state = {
  // The one source of truth about what we are looking at, kept in sync with
  // location.hash. Null on the picker screens.
  descriptor: null,
  mode: 'working',
  base: 'origin/main',
  files: [],
  orphanFiles: [],
  comments: [],
  activeFile: null,
  diff: null,
  selection: null, // { start, end } — real line numbers in the new file
  editing: null, // comment id being edited
};

// ------------------------------------------------------------------- header

function renderTopbar() {
  const isLocal = state.descriptor && state.descriptor.source === 'local';
  el.repoRoot.textContent = isLocal ? state.descriptor.root : '';
  el.repoRoot.title = el.repoRoot.textContent;
  for (const button of el.modes.querySelectorAll('.mode')) {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  }
  el.baseInput.hidden = state.mode !== 'base';
  if (document.activeElement !== el.baseInput) el.baseInput.value = state.base;
  el.rangeLabel.textContent = state.rangeLabel || '';
  el.total.textContent = String(state.comments.length);
  el.total.classList.toggle('has', state.comments.length > 0);
  const empty = state.comments.length === 0;
  el.copyAll.disabled = empty;
  el.exportMd.disabled = empty;
  el.clearAll.disabled = empty;
}

// ------------------------------------------------------------------ actions

async function refreshState(keepFile) {
  const data = await api(`/api/state?${qs()}`);
  state.rangeLabel = data.rangeLabel;
  state.files = data.files;
  state.orphanFiles = data.orphanFiles || [];
  if (data.mode) state.mode = data.mode;
  if (data.base) state.base = data.base;
  renderPrHeader(data.pr);

  const commentData = await api(`/api/comments?${qs()}`);
  state.comments = commentData.comments;

  const stillThere =
    keepFile &&
    (state.files.some((f) => f.path === keepFile) ||
      state.orphanFiles.some((f) => f.path === keepFile));
  renderTopbar();
  if (stillThere) {
    await selectFile(keepFile, !state.files.some((f) => f.path === keepFile));
  } else {
    state.activeFile = null;
    state.diff = null;
    renderFiles();
    renderDiff();
    if (state.files.length) await selectFile(state.files[0].path, false);
  }
}

// -------------------------------------------------------------------- modal

let modalResolve = null;

function openModal(text) {
  el.modalText.textContent = text;
  el.overlay.hidden = false;
  el.modalCancel.focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  el.overlay.hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(result);
}

el.modalCancel.addEventListener('click', () => closeModal(false));
el.modalConfirm.addEventListener('click', () => closeModal(true));
el.overlay.addEventListener('click', (event) => {
  if (event.target === el.overlay) closeModal(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el.overlay.hidden) {
    closeModal(false);
    return;
  }
  if (!el.rootModalOverlay.hidden) {
    closeRootModal(false);
    return;
  }
  cancelDrag();
});

async function clearAll() {
  const count = state.comments.length;
  const confirmed = await openModal(
    `Будет удалено комментариев: ${count}. Действие необратимо.`
  );
  if (!confirmed) {
    toast('Отменено — ничего не удалено');
    return;
  }
  const result = await api(`/api/comments/clear-all?${qs()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  await refreshComments();
  toast(`Удалено комментариев: ${result.removed}`);
}

// ------------------------------------------------------------------- router

function showScreen(name) {
  for (const id of ['screen-diff', 'screen-local', 'screen-pr']) {
    document.getElementById(id).hidden = id !== `screen-${name}`;
  }
  const source = (state.descriptor || {}).source;
  // A PR descriptor has no working/staged/base modes.
  el.topbarMid.hidden = !(name === 'diff' && source === 'local');
  el.tabLocal.classList.toggle('active', name === 'local' || source === 'local');
  el.tabPr.classList.toggle('active', name === 'pr' || source === 'pr');
}

async function route() {
  const hash = location.hash;
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const d = descriptorFromHash(hash);

  if (d) {
    state.descriptor = d;
    state.mode = d.mode || 'working';
    state.base = d.base || 'origin/main';
    showScreen('diff');
    await refreshState(null);
    // Remember the choice so an empty hash after a restart lands here again.
    api('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ descriptor: d }),
    }).catch(() => {});
    return;
  }

  state.descriptor = null;
  state.comments = [];
  state.files = [];
  state.orphanFiles = [];
  state.activeFile = null;
  state.diff = null;
  renderPrHeader(null);
  renderTopbar();

  if (parts[0] === 'pr') {
    showScreen('pr');
    await renderPrScreen();
    return;
  }
  showScreen('local');
  await renderLocalScreen();
}

// ------------------------------------------------------------------- wiring

el.diff.addEventListener('mousemove', extendDrag);
document.addEventListener('mouseup', finishDrag);
// Курсор ушёл из окна с зажатой кнопкой — отпускание мы уже не увидим.
window.addEventListener('blur', cancelDrag);

el.reload.addEventListener('click', () => {
  refreshState(state.activeFile).catch((e) => toast(e.message, true));
});

el.copyAll.addEventListener('click', () => copyAll().catch((e) => toast(e.message, true)));
el.exportMd.addEventListener('click', () => exportMd().catch((e) => toast(e.message, true)));
el.clearAll.addEventListener('click', () => clearAll().catch((e) => toast(e.message, true)));

wireLocalScreen();
wirePrScreen();

window.addEventListener('hashchange', () => {
  route().catch((e) => toast(e.message, true));
});

(async function boot() {
  try {
    if (!location.hash) {
      // The hash is the source of truth; the saved descriptor is consulted only
      // when there is no hash at all (a fresh tab after a server restart).
      const session = await api('/api/session');
      location.hash = hashFor(session.last) || '#/local';
      if (!location.hash) location.hash = '#/local';
    }
    await route();
  } catch (e) {
    toast(e.message, true);
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = e.message;
    el.diff.textContent = '';
    el.diff.append(div);
  }
})();
