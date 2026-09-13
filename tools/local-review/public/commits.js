'use strict';

/**
 * Режим «коммиты»: выбор одного коммита или диапазона коммитов на рельсе
 * истории ветки.
 *
 * Модуль самодостаточен — он сам дорисовывает кнопку режима, рельс, плашку и
 * дровер, а данные подменяет через `hooks` из app.js. Убрать фичу = убрать
 * две строки из index.html.
 *
 * Правила выбора (утверждены в issue #3):
 *   - по умолчанию выбран последний коммит;
 *   - клик внутри диапазона обрезает его от нижней границы: 1–9 + клик 4 → 1–4;
 *   - клик по любой границе диапазона оставляет только этот коммит;
 *   - клик вне диапазона сбрасывает выбор на этот коммит;
 *   - клик по единственному выбранному возвращает выбор на последний коммит;
 *   - протяжка работает в обе стороны и даёт один и тот же диапазон;
 *   - пустого выбора не бывает.
 */

(function commitRangeMode() {
  const MODE = 'commits';

  const cr = {
    commits: [],
    truncated: false,
    fallback: false,
    base: null,
    dirty: { dirty: false, files: 0 },
    anchor: 0,
    head: 0,
    userBase: null, // базовая ревизия, если её поменяли руками в шапке
    locked: true, // дровер открывается в режиме чтения
    noticeDismissed: false, // только в памяти вкладки: перезагрузка вернёт плашку
    dragFrom: null,
    dragMoved: false,
  };

  const lo = () => Math.min(cr.anchor, cr.head);
  const hi = () => Math.max(cr.anchor, cr.head);
  const last = () => cr.commits.length - 1;
  const active = () => state.mode === MODE && cr.commits.length > 0;

  // ------------------------------------------------------------------ DOM

  const node = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const ui = {};

  function mount() {
    const modeBtn = node('button', 'mode', 'коммиты');
    modeBtn.type = 'button';
    modeBtn.dataset.mode = MODE;
    el.modes.append(modeBtn);
    ui.modeBtn = modeBtn;

    const outside = node('button', 'badge outside');
    outside.type = 'button';
    outside.id = 'comment-outside';
    outside.hidden = true;
    outside.title = 'Комментарии, написанные вне выбранного диапазона';
    el.total.parentNode.insertBefore(outside, el.total);
    ui.outside = outside;

    const wrap = node('section', 'rail-wrap');
    wrap.hidden = true;
    wrap.innerHTML = [
      '<div class="rail-head">',
      '  <div><span class="rail-title">История ветки</span> <span class="muted" data-x="sel"></span></div>',
      '  <div class="rail-actions">',
      '    <code class="rail-cmd" data-x="cmd"></code>',
      '    <button class="btn" type="button" data-x="open">Вся история</button>',
      '  </div>',
      '</div>',
      '<div class="rail" tabindex="0" role="group" aria-label="Коммиты ветки">',
      '  <div class="rail-track" data-x="track">',
      '    <div class="rail-line"></div>',
      '    <div class="rail-line-sel" data-x="linesel" hidden></div>',
      '  </div>',
      '</div>',
      '<div class="rail-sum">',
      '  <span class="sum-sha" data-x="sumsha"></span>',
      '  <span class="sum-subj" data-x="sumsubj"></span>',
      '  <button class="link" type="button" data-x="copysha" title="Скопировать хеш">&#10697; хеш</button>',
      '</div>',
      '<p class="rail-hint">',
      '  Клик — один коммит · протяжка мышью — диапазон в любую сторону · наведение — полный текст ·',
      '  <kbd>&larr;</kbd><kbd>&rarr;</kbd> — перейти, <kbd>Shift</kbd>+<kbd>&larr;</kbd><kbd>&rarr;</kbd> — тянуть диапазон',
      '</p>',
    ].join('\n');

    const notice = node('div', 'cr-notice');
    notice.hidden = true;
    notice.innerHTML =
      '<div class="cr-notice-body" data-x="noticetext"></div>' +
      '<button class="btn ghost" type="button" data-x="noticeclose" aria-label="Скрыть плашку">&#10005;</button>';

    const layout = document.querySelector('main.layout');
    layout.parentNode.insertBefore(wrap, layout);
    layout.parentNode.insertBefore(notice, layout);

    const overlay = node('div', 'cr-overlay');
    overlay.hidden = true;
    const drawer = node('aside', 'cr-drawer');
    drawer.hidden = true;
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = [
      '<div class="cr-drawer-head">',
      '  <h2 data-x="dtitle">История ветки</h2>',
      '  <div class="rail-actions">',
      '    <button class="btn ghost" type="button" data-x="lock"></button>',
      '    <button class="btn ghost" type="button" data-x="dclose" aria-label="Закрыть">&#10005;</button>',
      '  </div>',
      '</div>',
      '<ul class="cr-drawer-list" data-x="dlist"></ul>',
      '<div class="cr-drawer-foot" data-x="dfoot"></div>',
    ].join('\n');
    document.body.append(overlay, drawer);

    for (const root of [wrap, notice, drawer]) {
      for (const n of root.querySelectorAll('[data-x]')) ui[n.dataset.x] = n;
    }
    ui.wrap = wrap;
    ui.notice = notice;
    ui.overlay = overlay;
    ui.drawer = drawer;
    ui.rail = wrap.querySelector('.rail');

    wire();
  }

  // -------------------------------------------------------------- правила

  function setSelection(anchor, head) {
    cr.anchor = clamp(anchor);
    cr.head = clamp(head);
    render();
    reload();
  }

  function clamp(i) {
    return Math.max(0, Math.min(last(), i));
  }

  function clickCommit(i) {
    const inRange = i >= lo() && i <= hi();
    const single = lo() === hi();

    if (single && i === cr.anchor) {
      // Клик по единственному выбранному возвращает выбор на последний коммит.
      if (i === last()) return;
      setSelection(last(), last());
      return;
    }
    if (inRange && (i === lo() || i === hi())) {
      setSelection(i, i); // клик по границе — остаётся только этот коммит
      return;
    }
    if (inRange) {
      setSelection(lo(), i); // обрезка всегда считается от нижней границы
      return;
    }
    setSelection(i, i);
  }

  // -------------------------------------------------------------- отрисовка

  function commitEl(c, i) {
    const b = node('button', 'commit');
    b.type = 'button';
    b.dataset.i = String(i);
    if (c.merge) b.dataset.merge = '1';
    b.title = fullText(c);
    b.append(node('span', 'dot'));
    b.append(node('span', 'subj', c.subject || '(без сообщения)'));
    b.append(node('span', 'sha', `${c.short} · ${c.author} · ${when(c.date)}`));
    return b;
  }

  function fullText(c) {
    const head = `${c.subject}\n\n${c.short} · ${c.author} · ${when(c.date)}`;
    return c.body ? `${c.subject}\n\n${c.body}\n\n${c.short} · ${c.author} · ${when(c.date)}` : head;
  }

  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function command() {
    const l = cr.commits[lo()];
    const h = cr.commits[hi()];
    if (!l || !h) return '';
    if (lo() === hi()) {
      if (l.merge) return `git show --cc ${l.short}`;
      return l.root ? `git diff <empty-tree>..${l.short}` : `git show ${l.short}`;
    }
    return l.root
      ? `git diff <empty-tree>..${h.short}`
      : `git diff ${l.short}^..${h.short}`;
  }

  function render() {
    ui.wrap.hidden = !active();
    syncNotice();
    if (!active()) return;

    const track = ui.track;
    for (const old of track.querySelectorAll('.commit')) old.remove();
    cr.commits.forEach((c, i) => track.append(commitEl(c, i)));
    paint(lo(), hi());

    const n = hi() - lo() + 1;
    ui.sel.textContent =
      n === 1 ? '· выбран 1 коммит' : `· выбрано коммитов: ${n} из ${cr.commits.length}`;
    ui.cmd.textContent = command();

    const l = cr.commits[lo()];
    const h = cr.commits[hi()];
    ui.sumsha.textContent = n === 1 ? l.short : `${l.short}..${h.short}`;
    ui.sumsubj.textContent = n === 1 ? l.subject : `${l.subject} … ${h.subject}`;
    ui.sumsubj.title = n === 1 ? fullText(l) : `${fullText(l)}\n\n—\n\n${fullText(h)}`;

    renderOutside();
    if (!ui.drawer.hidden) renderDrawer();
  }

  /** Подсветка без перерисовки — используется и во время протяжки. */
  function paint(from, to) {
    const min = Math.min(from, to);
    const max = Math.max(from, to);
    const dots = ui.track.querySelectorAll('.commit');
    dots.forEach((b, i) => b.classList.toggle('on', i >= min && i <= max));
    const a = dots[min];
    const z = dots[max];
    if (!a || !z) {
      ui.linesel.hidden = true;
      return;
    }
    const base = ui.track.getBoundingClientRect();
    const ra = a.getBoundingClientRect();
    const rz = z.getBoundingClientRect();
    ui.linesel.hidden = false;
    ui.linesel.style.left = `${ra.left - base.left + ra.width / 2}px`;
    ui.linesel.style.width = `${rz.left - ra.left + rz.width / 2 - ra.width / 2}px`;
  }

  function renderOutside() {
    const outside = state.comments.filter((c) => c.commit && !insideSelection(c));
    ui.outside.hidden = outside.length === 0;
    if (outside.length === 0) return;
    ui.outside.textContent = `${outside.length} вне выбора`;
    ui.outside._targets = outside;
  }

  function indexOfSha(sha) {
    if (!sha) return -1;
    return cr.commits.findIndex((c) => c.sha === sha || c.short === sha || c.sha.startsWith(sha));
  }

  function insideSelection(comment) {
    const ctx = comment.commit;
    if (!ctx || !ctx.to) return true;
    const f = indexOfSha(ctx.from);
    const t = indexOfSha(ctx.to);
    if (f === -1 || t === -1) return true; // коммита уже нет — прятать нечего
    return f >= lo() && t <= hi();
  }

  // ---------------------------------------------------------------- дровер

  function renderDrawer() {
    ui.dtitle.textContent = `История ветки · ${cr.commits.length}`;
    ui.lock.textContent = cr.locked ? '🔒 выбор заблокирован' : '🔓 выбор разблокирован';
    ui.lock.setAttribute('aria-pressed', String(cr.locked));
    ui.lock.title = cr.locked
      ? 'Клик по строке ничего не меняет — текст можно выделять и копировать'
      : 'Клик по строке меняет выбор';

    ui.dlist.textContent = '';
    cr.commits.forEach((c, i) => {
      const li = node('li');
      const row = document.createElement(cr.locked ? 'div' : 'button');
      if (!cr.locked) row.type = 'button';
      row.className = `drawer-item${cr.locked ? ' locked' : ''}${
        i >= lo() && i <= hi() ? ' on' : ''
      }`;
      row.append(node('span', 'd-subj', c.subject || '(без сообщения)'));
      if (c.body) row.append(node('span', 'd-body', c.body));

      const meta = node('div', 'd-meta');
      meta.append(node('span', null, `${c.short} · ${c.author} · ${when(c.date)}`));
      const copy = node('button', 'link', '⧉');
      copy.type = 'button';
      copy.title = 'Скопировать хеш';
      copy.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(c.sha, `Хеш ${c.short} скопирован`);
      });
      meta.append(copy);
      row.append(meta);

      if (!cr.locked) {
        row.addEventListener('click', (e) => {
          if (e.shiftKey) setSelection(cr.anchor, i);
          else clickCommit(i);
        });
      }
      li.append(row);
      ui.dlist.append(li);
    });

    const notes = [];
    if (cr.fallback) notes.push('точка ветвления не найдена — показаны последние коммиты HEAD');
    else if (cr.base) notes.push(`от точки ветвления с ${cr.base}`);
    if (cr.truncated) notes.push('список обрезан — история длиннее лимита');
    ui.dfoot.textContent = notes.join(' · ') || 'вся история ветки';
  }

  function openDrawer() {
    cr.locked = true;
    ui.overlay.hidden = false;
    ui.drawer.hidden = false;
    renderDrawer();
    ui.dclose.focus();
  }

  function closeDrawer() {
    ui.overlay.hidden = true;
    ui.drawer.hidden = true;
  }

  // --------------------------------------------------------------- плашка

  function syncNotice() {
    const show = active() && cr.dirty.dirty && !cr.noticeDismissed;
    ui.notice.hidden = !show;
    if (!show) return;
    const n = cr.dirty.files;
    ui.noticetext.innerHTML =
      `<strong>Есть незакоммиченные изменения</strong> — файлов: ${n}. ` +
      'Дифф по коммитам их не показывает, поэтому картина может быть неполной. ' +
      'Переключитесь на «рабочую копию», чтобы увидеть их.';
  }

  // ------------------------------------------------------------- протяжка

  /**
   * Попадание по геометрии, а не через elementFromPoint: линия рельса лежит
   * поверх кружков, и указатель регулярно оказывается «над» ней.
   */
  function indexFromX(x) {
    const dots = ui.track.querySelectorAll('.commit');
    let best = 0;
    let bestDist = Infinity;
    dots.forEach((d, i) => {
      if (bestDist === -1) return;
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right) {
        best = i;
        bestDist = -1;
        return;
      }
      const dist = x < r.left ? r.left - x : x - r.right;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function wire() {
    const track = ui.track;

    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const btn = e.target.closest('.commit');
      if (!btn) return;
      // Ни preventDefault, ни focus() вручную: программный фокус рисует
      // focus-visible вокруг всей кнопки, а выделение текста гасит user-select.
      cr.dragFrom = Number(btn.dataset.i);
      cr.dragMoved = false;
      track.setPointerCapture(e.pointerId);
      paint(cr.dragFrom, cr.dragFrom);
    });

    track.addEventListener('pointermove', (e) => {
      if (cr.dragFrom === null) return;
      const i = indexFromX(e.clientX);
      if (i !== cr.dragFrom) cr.dragMoved = true;
      paint(cr.dragFrom, i);
    });

    const finish = (e) => {
      if (cr.dragFrom === null) return;
      const from = cr.dragFrom;
      const moved = cr.dragMoved;
      cr.dragFrom = null;
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
      if (moved) setSelection(from, indexFromX(e.clientX));
      else clickCommit(from);
    };
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', () => {
      cr.dragFrom = null;
      paint(lo(), hi());
    });

    ui.rail.addEventListener('keydown', (e) => {
      if (!active()) return;
      const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      if (e.shiftKey) setSelection(cr.anchor, clamp(cr.head + step));
      else setSelection(clamp(cr.head + step), clamp(cr.head + step));
    });

    ui.copysha.addEventListener('click', () => {
      const l = cr.commits[lo()];
      const h = cr.commits[hi()];
      if (!l) return;
      const text = lo() === hi() ? l.sha : `${l.sha}..${h.sha}`;
      copyText(text, lo() === hi() ? `Хеш ${l.short} скопирован` : 'Диапазон скопирован');
    });

    ui.open.addEventListener('click', openDrawer);
    ui.dclose.addEventListener('click', closeDrawer);
    ui.overlay.addEventListener('click', closeDrawer);
    ui.lock.addEventListener('click', () => {
      cr.locked = !cr.locked;
      renderDrawer();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !ui.drawer.hidden) {
        e.stopPropagation();
        closeDrawer();
      }
    });

    ui.noticeclose.addEventListener('click', () => {
      cr.noticeDismissed = true;
      syncNotice();
    });

    ui.outside.addEventListener('click', () => {
      const targets = ui.outside._targets || [];
      const idx = [];
      for (const c of targets) {
        const f = indexOfSha(c.commit.from);
        const t = indexOfSha(c.commit.to);
        if (f !== -1) idx.push(f);
        if (t !== -1) idx.push(t);
      }
      if (!idx.length) return;
      setSelection(Math.min(lo(), ...idx), Math.max(hi(), ...idx));
    });

    // Кнопка режима: app.js уже выставил state.mode в своём обработчике,
    // нам остаётся синхронизировать рельс.
    el.modes.addEventListener('click', (e) => {
      if (!e.target.closest('.mode')) return;
      render();
    });

    el.reload.addEventListener('click', () => {
      loadCommits().then(render).catch((err) => toast(err.message, true));
    });

    // Сменили базовую ревизию — точка ветвления другая, рельс надо перестроить.
    el.baseInput.addEventListener('change', () => {
      cr.userBase = el.baseInput.value.trim();
      loadCommits()
        .then(() => {
          render();
          if (active()) reload();
        })
        .catch((err) => toast(err.message, true));
    });

    window.addEventListener('resize', () => {
      if (active()) paint(lo(), hi());
    });
  }

  async function copyText(text, okMessage) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
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
    toast(ok ? okMessage : 'Не удалось скопировать', !ok);
  }

  function reload() {
    refreshState(state.activeFile).catch((e) => toast(e.message, true));
  }

  // ----------------------------------------------------------------- хуки

  function selectionParams() {
    const l = cr.commits[lo()];
    const h = cr.commits[hi()];
    return `from=${encodeURIComponent(l.sha)}&to=${encodeURIComponent(h.sha)}&count=${
      hi() - lo() + 1
    }`;
  }

  hooks.stateUrl = (params) =>
    active() ? `/api/commits/state?${selectionParams()}` : `/api/state?${params}`;

  hooks.diffUrl = (params) => {
    if (!active()) return `/api/diff?${params}`;
    const file = new URLSearchParams(params).get('file');
    return `/api/commits/diff?file=${encodeURIComponent(file)}&${selectionParams()}`;
  };

  hooks.commentVisible = (comment) => (active() ? insideSelection(comment) : true);

  hooks.commentBadge = (comment) => {
    const ctx = comment.commit;
    if (!ctx || !ctx.to) return null;
    return ctx.from && ctx.from !== ctx.to ? `${ctx.from}..${ctx.to}` : ctx.to;
  };

  hooks.commentPayload = (payload) => {
    // Комментарий с последнего коммита экспортируется как раньше — без контекста.
    if (!active()) return payload;
    if (lo() === hi() && lo() === last()) return payload;
    const l = cr.commits[lo()];
    const h = cr.commits[hi()];
    return Object.assign({}, payload, {
      commit: {
        from: l.short,
        to: h.short,
        label: lo() === hi() ? l.subject : `коммиты ${lo() + 1}–${hi() + 1}`,
      },
    });
  };

  // ----------------------------------------------------------------- старт

  async function loadCommits() {
    // Базу не передаём, пока её не поменял пользователь: на старте app.js ещё
    // не успел прочитать настоящее значение с сервера, и рельс построился бы
    // от чужой точки ветвления.
    const base = cr.userBase ? `?base=${encodeURIComponent(cr.userBase)}` : '';
    const data = await api(`/api/commits${base}`);
    cr.commits = data.commits || [];
    cr.truncated = Boolean(data.truncated);
    cr.fallback = Boolean(data.fallback);
    cr.base = data.base;
    cr.dirty = data.dirty || { dirty: false, files: 0 };
    // Выбор по умолчанию — последний коммит ветки.
    cr.anchor = last() < 0 ? 0 : last();
    cr.head = cr.anchor;
    if (ui.modeBtn) {
      ui.modeBtn.disabled = cr.commits.length === 0;
      ui.modeBtn.title = cr.commits.length === 0 ? 'В репозитории ещё нет коммитов' : '';
    }
  }

  mount();
  loadCommits()
    .then(render)
    .catch((e) => {
      if (ui.modeBtn) {
        ui.modeBtn.disabled = true;
        ui.modeBtn.title = e.message;
      }
    });
})();
