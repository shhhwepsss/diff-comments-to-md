'use strict';

const el = {
  repoRoot: document.getElementById('repo-root'),
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
  toast: document.getElementById('toast'),
};

const state = {
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

const MAX_RENDERED_LINES = 20000;

// ---------------------------------------------------------------- utilities

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

let toastTimer = null;
function toast(message, isError) {
  el.toast.textContent = message;
  el.toast.classList.toggle('error', Boolean(isError));
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, isError ? 8000 : 5000);
}

function anchorLabel(comment) {
  if (comment.startLine === null || comment.startLine === undefined) return comment.file;
  if (comment.endLine && comment.endLine !== comment.startLine) {
    return `${comment.file}:L${comment.startLine}-L${comment.endLine}`;
  }
  return `${comment.file}:L${comment.startLine}`;
}

function commentsFor(file) {
  return state.comments.filter((c) => c.file === file);
}

// ------------------------------------------------------------------- header

function renderTopbar() {
  el.repoRoot.textContent = state.repoRoot || '';
  el.repoRoot.title = state.repoRoot || '';
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

// ---------------------------------------------------------------- file list

function renderFiles() {
  el.fileList.textContent = '';
  const counts = {};
  for (const c of state.comments) counts[c.file] = (counts[c.file] || 0) + 1;

  const addItem = (file, orphan) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    if (file.path === state.activeFile) li.classList.add('active');

    const status = document.createElement('span');
    const kind = (file.status || 'M')[0];
    status.className = `status ${kind}`;
    status.textContent = orphan ? '?' : kind;
    status.title = orphan ? 'нет в текущем диффе' : file.status;

    const name = document.createElement('span');
    name.className = 'name';
    // bdi + rtl trick keeps the file name (tail of the path) visible on overflow
    name.textContent = file.path;
    name.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;

    const count = document.createElement('span');
    const n = counts[file.path] || 0;
    count.className = n ? 'count has' : 'count';
    count.textContent = n ? String(n) : '';

    li.append(status, name, count);
    li.addEventListener('click', () => selectFile(file.path, orphan));
    el.fileList.append(li);
  };

  if (state.files.length === 0) {
    const li = document.createElement('li');
    li.className = 'section';
    li.textContent = 'дифф пуст';
    el.fileList.append(li);
  }
  for (const file of state.files) addItem(file, false);

  if (state.orphanFiles.length) {
    const head = document.createElement('li');
    head.className = 'section';
    head.textContent = 'вне диффа';
    el.fileList.append(head);
    for (const file of state.orphanFiles) addItem(file, true);
  }
}

// --------------------------------------------------------------------- diff

function lineRow(line, filePath) {
  const tr = document.createElement('tr');
  tr.className = `line ${line.type}`;

  const oldTd = document.createElement('td');
  oldTd.className = 'num old';
  oldTd.textContent = line.oldLine === null ? '' : String(line.oldLine);

  const newTd = document.createElement('td');
  newTd.className = 'num new';
  newTd.textContent = line.newLine === null ? '' : String(line.newLine);
  if (line.newLine !== null) {
    newTd.classList.add('clickable');
    newTd.title = 'клик — комментарий к строке, Shift+клик — к диапазону';
    tr.dataset.newLine = String(line.newLine);
    newTd.addEventListener('click', (event) => onLineClick(filePath, line.newLine, event));
  }

  const code = document.createElement('td');
  code.className = 'code';
  const sign = document.createElement('span');
  sign.className = 'sign';
  sign.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  code.append(sign, document.createTextNode(line.text));

  tr.append(oldTd, newTd, code);
  return tr;
}

function renderDiff() {
  el.fileHeader.textContent = '';
  el.diff.textContent = '';
  if (!state.activeFile) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = state.files.length
      ? 'Выбери файл слева'
      : 'Изменений нет — дифф пуст';
    el.diff.append(div);
    return;
  }

  const diff = state.diff;
  const title = document.createElement('span');
  title.textContent = diff && diff.oldPath ? `${diff.oldPath} → ${state.activeFile}` : state.activeFile;
  el.fileHeader.append(title);

  if (diff && !diff.orphan) {
    const stats = document.createElement('span');
    stats.className = 'hint';
    stats.textContent = `+${diff.additions || 0} / -${diff.deletions || 0}`;
    el.fileHeader.append(stats);
  }
  const fileBtn = document.createElement('button');
  fileBtn.className = 'link';
  fileBtn.textContent = '+ комментарий к файлу';
  fileBtn.addEventListener('click', () => openEditor({ file: state.activeFile, start: null, end: null }));
  el.fileHeader.append(fileBtn);

  const fileComments = commentsFor(state.activeFile);
  const byLine = new Map();
  const unanchored = [];
  const visibleLines = new Set();
  if (diff && diff.hunks) {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) if (line.newLine !== null) visibleLines.add(line.newLine);
    }
  }
  for (const comment of fileComments) {
    const key = comment.endLine === null || comment.endLine === undefined ? null : comment.endLine;
    if (key === null || !visibleLines.has(key)) {
      unanchored.push(comment);
      continue;
    }
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(comment);
  }

  if (unanchored.length) {
    const box = document.createElement('div');
    box.style.padding = '8px 12px';
    const head = document.createElement('div');
    head.className = 'hint';
    head.textContent = 'Комментарии к файлу / вне видимой части диффа:';
    box.append(head);
    for (const comment of unanchored) box.append(commentCard(comment));
    el.diff.append(box);
  }

  if (!diff) return;

  if (diff.binary) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Бинарный файл — построчный дифф недоступен, оставь комментарий к файлу.';
    el.diff.append(div);
    return;
  }
  if (!diff.hunks || diff.hunks.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = diff.orphan
      ? 'Файл отсутствует в текущем диффе, но комментарии к нему сохранены.'
      : 'Изменений содержимого нет (возможно, только режим файла или переименование).';
    el.diff.append(div);
    return;
  }

  let rendered = 0;
  let truncated = false;
  const fragment = document.createDocumentFragment();

  for (const hunk of diff.hunks) {
    const table = document.createElement('table');
    table.className = 'hunk';
    const tbody = document.createElement('tbody');

    const headRow = document.createElement('tr');
    headRow.className = 'hunk-head';
    const headCell = document.createElement('td');
    headCell.colSpan = 3;
    headCell.textContent =
      `@@ -${hunk.oldStart} +${hunk.newStart} @@` + (hunk.heading ? ` ${hunk.heading}` : '');
    headRow.append(headCell);
    tbody.append(headRow);

    for (const line of hunk.lines) {
      if (rendered >= MAX_RENDERED_LINES) {
        truncated = true;
        break;
      }
      rendered += 1;
      const tr = lineRow(line, state.activeFile);
      if (
        state.selection &&
        line.newLine !== null &&
        line.newLine >= Math.min(state.selection.start, state.selection.end) &&
        line.newLine <= Math.max(state.selection.start, state.selection.end)
      ) {
        tr.classList.add('selected');
      }
      tbody.append(tr);

      if (line.newLine !== null && byLine.has(line.newLine)) {
        const row = document.createElement('tr');
        row.className = 'comment-row';
        const cell = document.createElement('td');
        cell.colSpan = 3;
        for (const comment of byLine.get(line.newLine)) cell.append(commentCard(comment));
        row.append(cell);
        tbody.append(row);
      }

      if (
        state.editorAnchor &&
        state.editorAnchor.file === state.activeFile &&
        state.editorAnchor.end === line.newLine
      ) {
        const row = document.createElement('tr');
        row.className = 'comment-row';
        const cell = document.createElement('td');
        cell.colSpan = 3;
        cell.append(editorCard(state.editorAnchor));
        row.append(cell);
        tbody.append(row);
      }
    }

    table.append(tbody);
    fragment.append(table);
    if (truncated) break;
  }

  el.diff.append(fragment);

  if (truncated) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = `Показаны первые ${MAX_RENDERED_LINES} строк диффа — файл слишком большой.`;
    el.diff.append(note);
  }

  if (state.editorAnchor && state.editorAnchor.end === null) {
    const box = document.createElement('div');
    box.style.padding = '8px 12px';
    box.append(editorCard(state.editorAnchor));
    el.diff.prepend(box);
  }

  if (state.pendingFocus) {
    const target = el.diff.querySelector('textarea');
    if (target) target.focus();
    state.pendingFocus = false;
  }
}

// ----------------------------------------------------------------- comments

function commentCard(comment) {
  const box = document.createElement('div');
  box.className = 'comment';

  if (state.editing === comment.id) {
    const textarea = document.createElement('textarea');
    textarea.value = comment.text;
    const row = document.createElement('div');
    row.className = 'row';
    const save = document.createElement('button');
    save.className = 'btn';
    save.textContent = 'Сохранить';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Отмена';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Ctrl+Enter — сохранить, Esc — отмена';

    const commit = async () => {
      const text = textarea.value.trim();
      if (!text) {
        toast('Пустой комментарий не сохраняю', true);
        return;
      }
      await api(`/api/comments/${encodeURIComponent(comment.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      state.editing = null;
      await refreshComments();
    };
    const abort = () => {
      state.editing = null;
      renderDiff();
    };
    save.addEventListener('click', () => commit().catch((e) => toast(e.message, true)));
    cancel.addEventListener('click', abort);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit().catch((e) => toast(e.message, true));
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        abort();
      }
    });

    row.append(save, cancel, hint);
    const wrap = document.createElement('div');
    wrap.className = 'editor';
    wrap.append(textarea, row);
    box.append(wrap);
    setTimeout(() => textarea.focus(), 0);
    return box;
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const anchor = document.createElement('span');
  anchor.className = 'anchor';
  anchor.textContent = anchorLabel(comment);
  const actions = document.createElement('div');
  actions.className = 'actions';

  const edit = document.createElement('button');
  edit.className = 'link';
  edit.textContent = 'edit';
  edit.addEventListener('click', () => {
    state.editing = comment.id;
    renderDiff();
  });

  const remove = document.createElement('button');
  remove.className = 'link danger';
  remove.textContent = 'delete';
  remove.addEventListener('click', async () => {
    try {
      await api(`/api/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' });
      await refreshComments();
    } catch (e) {
      toast(e.message, true);
    }
  });

  actions.append(edit, remove);
  meta.append(anchor, actions);

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = comment.text;

  box.append(meta, body);
  return box;
}

function editorCard(target) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const label = document.createElement('div');
  label.className = 'hint';
  label.textContent =
    target.start === null
      ? `${target.file} — комментарий к файлу`
      : target.start === target.end
        ? `${target.file}:L${target.start}`
        : `${target.file}:L${Math.min(target.start, target.end)}-L${Math.max(target.start, target.end)}`;

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Комментарий…';

  const row = document.createElement('div');
  row.className = 'row';
  const save = document.createElement('button');
  save.className = 'btn';
  save.textContent = 'Сохранить';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Отмена';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Ctrl+Enter — сохранить, Esc — отмена';

  const commit = async () => {
    const text = textarea.value.trim();
    if (!text) {
      toast('Пустой комментарий не сохраняю', true);
      return;
    }
    await api('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: target.file,
        startLine: target.start === null ? null : Math.min(target.start, target.end),
        endLine: target.end === null ? null : Math.max(target.start, target.end),
        text,
      }),
    });
    closeEditor();
    await refreshComments();
  };

  save.addEventListener('click', () => commit().catch((e) => toast(e.message, true)));
  cancel.addEventListener('click', () => {
    closeEditor();
    renderDiff();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit().catch((e) => toast(e.message, true));
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeEditor();
      renderDiff();
    }
  });

  row.append(save, cancel, hint);
  wrap.append(label, textarea, row);
  return wrap;
}

function openEditor(target) {
  state.editorAnchor = target;
  state.editing = null;
  state.selection =
    target.start === null ? null : { file: target.file, start: target.start, end: target.end };
  state.pendingFocus = true;
  renderDiff();
}

function closeEditor() {
  state.editorAnchor = null;
  state.selection = null;
}

function onLineClick(file, lineNumber, event) {
  // Shift+click extends the current selection into a range within the same file.
  if (event.shiftKey && state.selection && state.selection.file === file) {
    openEditor({ file, start: state.selection.start, end: lineNumber });
    return;
  }
  openEditor({ file, start: lineNumber, end: lineNumber });
}

// ------------------------------------------------------------------ actions

async function refreshComments() {
  const data = await api('/api/comments');
  state.comments = data.comments;
  renderTopbar();
  renderFiles();
  renderDiff();
}

async function refreshState(keepFile) {
  const params = new URLSearchParams({ mode: state.mode, base: state.base });
  const data = await api(`/api/state?${params.toString()}`);
  state.repoRoot = data.repoRoot;
  state.rangeLabel = data.rangeLabel;
  state.files = data.files;
  state.orphanFiles = data.orphanFiles || [];
  const commentData = await api('/api/comments');
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

async function selectFile(file, orphan) {
  state.activeFile = file;
  closeEditor();
  state.editing = null;
  renderFiles();
  if (orphan) {
    state.diff = { orphan: true, hunks: [] };
    renderDiff();
    return;
  }
  try {
    const params = new URLSearchParams({ file, mode: state.mode, base: state.base });
    state.diff = await api(`/api/diff?${params.toString()}`);
  } catch (e) {
    state.diff = { orphan: true, hunks: [] };
    toast(e.message, true);
  }
  renderDiff();
}

async function copyAll() {
  const text = await api('/api/export/text');
  const payload = typeof text === 'string' ? text : String(text);
  let ok = false;
  try {
    await navigator.clipboard.writeText(payload);
    ok = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = payload;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  // Export never mutates the store; re-read to prove it on screen.
  await refreshComments();
  toast(
    ok
      ? `Скопировано комментариев: ${state.comments.length}`
      : 'Не удалось скопировать — скопируй вручную из /api/export/text',
    !ok
  );
}

async function exportMd() {
  const result = await api('/api/export/file', { method: 'POST' });
  await refreshComments();
  toast(`Записан ${result.file} (${result.count} шт.) → ${result.path}`);
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
  if (event.key === 'Escape' && !el.overlay.hidden) closeModal(false);
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
  const result = await api('/api/comments/clear-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  await refreshComments();
  toast(`Удалено комментариев: ${result.removed}`);
}

// ------------------------------------------------------------------- wiring

el.modes.addEventListener('click', async (event) => {
  const button = event.target.closest('.mode');
  if (!button) return;
  state.mode = button.dataset.mode;
  renderTopbar();
  try {
    await refreshState(state.activeFile);
  } catch (e) {
    toast(e.message, true);
  }
});

el.baseInput.addEventListener('change', async () => {
  state.base = el.baseInput.value.trim() || 'origin/main';
  try {
    await refreshState(state.activeFile);
  } catch (e) {
    toast(e.message, true);
  }
});

el.reload.addEventListener('click', () => {
  refreshState(state.activeFile).catch((e) => toast(e.message, true));
});

el.copyAll.addEventListener('click', () => copyAll().catch((e) => toast(e.message, true)));
el.exportMd.addEventListener('click', () => exportMd().catch((e) => toast(e.message, true)));
el.clearAll.addEventListener('click', () => clearAll().catch((e) => toast(e.message, true)));

(async function boot() {
  try {
    const initial = await api('/api/state');
    state.mode = initial.mode;
    state.base = initial.base;
    await refreshState(null);
  } catch (e) {
    toast(e.message, true);
    el.diff.textContent = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = e.message;
    el.diff.append(div);
  }
})();
