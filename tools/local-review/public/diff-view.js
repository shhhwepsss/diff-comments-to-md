'use strict';

// Diff rendering, comment cards, the inline editor, line-number dragging and
// export. Shared verbatim by both screens: nothing here knows whether the diff
// came from a local repository or from a GitHub pull request.

const MAX_RENDERED_LINES = 20000;

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
    newTd.title = 'клик — строка, протяжка по номерам или Shift+клик — диапазон';
    tr.dataset.newLine = String(line.newLine);
    newTd.addEventListener('mousedown', (event) => startDrag(filePath, line.newLine, event));
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

  const dragHint = document.createElement('span');
  dragHint.className = 'hint';
  dragHint.textContent = 'по номерам строк: клик — строка, протяжка или Shift+клик — диапазон';
  el.fileHeader.append(dragHint);

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
    textarea.name = 'comment-edit';
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
      await api(`/api/comments/${encodeURIComponent(comment.id)}?${qs()}`, {
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
      await api(`/api/comments/${encodeURIComponent(comment.id)}?${qs()}`, { method: 'DELETE' });
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
  textarea.name = 'comment-new';
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
    await api(`/api/comments?${qs()}`, {
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

// ------------------------------------------------------- selecting lines
//
// Как в гитхабе: клик по номеру — одна строка, протяжка по номерам вниз или
// вверх — диапазон, Shift+клик — расширить уже выбранное. Пока тянешь, строки
// подсвечиваются без перерисовки диффа (иначе на больших файлах лагает).

const drag = { active: false, file: null, anchor: null, current: null };

function paintRange(from, to) {
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  for (const tr of el.diff.querySelectorAll('tr.line')) {
    const raw = tr.dataset.newLine;
    const n = raw === undefined ? null : Number(raw);
    tr.classList.toggle('selected', n !== null && n >= min && n <= max);
  }
}

function startDrag(file, lineNumber, event) {
  if (event.button !== 0) return;
  // Иначе браузер начнёт выделять текст диффа, пока тянем по номерам.
  event.preventDefault();
  const anchor =
    event.shiftKey && state.selection && state.selection.file === file
      ? state.selection.start
      : lineNumber;
  drag.active = true;
  drag.file = file;
  drag.anchor = anchor;
  drag.current = lineNumber;
  document.body.classList.add('dragging-lines');
  paintRange(drag.anchor, drag.current);
}

function extendDrag(event) {
  if (!drag.active) return;
  const row = event.target.closest ? event.target.closest('tr.line[data-new-line]') : null;
  if (!row) return;
  const n = Number(row.dataset.newLine);
  if (n === drag.current) return;
  drag.current = n;
  paintRange(drag.anchor, drag.current);
}

function finishDrag() {
  if (!drag.active) return;
  const { file, anchor, current } = drag;
  drag.active = false;
  document.body.classList.remove('dragging-lines');
  openEditor({ file, start: Math.min(anchor, current), end: Math.max(anchor, current) });
}

function cancelDrag() {
  if (!drag.active) return;
  drag.active = false;
  document.body.classList.remove('dragging-lines');
  renderDiff();
}

async function refreshComments() {
  const data = await api(`/api/comments?${qs()}`);
  state.comments = data.comments;
  renderTopbar();
  renderFiles();
  renderDiff();
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
    state.diff = await api(`/api/diff?${qs({ file })}`);
  } catch (e) {
    state.diff = { orphan: true, hunks: [] };
    toast(e.message, true);
  }
  renderDiff();
}

async function copyAll() {
  const text = await api(`/api/export/text?${qs()}`);
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
  const result = await api(`/api/export/file?${qs()}`, { method: 'POST' });
  await refreshComments();
  toast(`Записан ${result.file} (${result.count} шт.) → ${result.path}`);
}
