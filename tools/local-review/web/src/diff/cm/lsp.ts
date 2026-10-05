import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, closeHoverTooltips, hoverTooltip, type DecorationSet, type Tooltip } from '@codemirror/view';
import { language } from '@codemirror/language';
import { highlightCode } from '@lezer/highlight';
import type { LspHover, LspLocation } from '../../api/types';
import { displayBinding, isTypingTarget } from '../../lib/keybindings';
import { portalOpen } from '../../lib/portal';
import { failureText, indicatorFor, type LspSession } from '../../lsp/session';
import { hoverBlocks, inlineParts } from '../../lsp/hoverText';
import { githubHighlightStyle } from './theme';
import { wordAt } from './occurrenceMatch';

// Code navigation in a diff: hover for the signature and docs, Ctrl/Cmd+click
// (and F12, and the context menu) for «go to definition». Everything asks the
// language server through the review's LspSession; this file is the editor
// side — which word is under the pointer, the tooltip, the menu.
//
// Only the document is navigable: it is the new side of the diff (added and
// unchanged lines), the text the server sees. Deleted lines are the merge
// view's widgets with no file on disk behind them, so they get neither hover
// nor a menu (the highlight of occurrences still works there).

/** The context menu on screen, if any: one for the whole page. */
let openMenu: { el: HTMLElement; close: () => void } | null = null;

/** A word of the document: its range and the zero-based LSP position of its start. */
type Word = { from: number; to: number; line: number; character: number };

function wordRange(state: EditorState, pos: number): Word | null {
  const line = state.doc.lineAt(pos);
  const w = wordAt(line.text, pos - line.from);
  if (!w) return null;
  return { from: line.from + w.from, to: line.from + w.to, line: line.number - 1, character: w.from };
}

/** The word under a mouse event, when the pointer really is over it and over a document line. */
function wordAtPointer(view: EditorView, event: MouseEvent): Word | null {
  const target = event.target as HTMLElement | null;
  if (!target?.closest || !view.contentDOM.contains(target)) return null;
  // Deleted lines and comment cards are widgets inside the content.
  if (!target.closest('.cm-line') || target.closest('.cm-deletedChunk')) return null;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const w = wordRange(view.state, pos);
  if (!w) return null;
  const a = view.coordsAtPos(w.from, 1);
  const b = view.coordsAtPos(w.to, -1);
  if (!a || !b) return null;
  const inside = event.clientX >= a.left - 1 && event.clientX <= b.right + 1 && event.clientY >= a.top && event.clientY <= a.bottom;
  return inside ? w : null;
}

/**
 * One file's link to the language server. Lives as long as the file's
 * component; FileDiff refreshes its fields on every render, the editor under
 * it may be rebuilt.
 */
export class LspHub {
  path = '';
  session: LspSession | null = null;
  /** The text on screen is not the working tree (staged, commits): send it along. */
  sendText = false;
  /** The definition shortcut, for the menu. */
  definitionKey = '';
  /** Open the place a definition is at; `fromLine` (1-based) is where the jump started. */
  onNavigate: (loc: LspLocation, fromLine: number) => void = () => undefined;
  toast: (text: string, error?: boolean) => void = () => undefined;

  /** Why this file cannot be asked, or null when it can. */
  unavailable(): string | null {
    const session = this.session;
    if (!session) return 'LSP недоступен';
    const indicator = indicatorFor(session.getSnapshot(), this.path);
    if (session.canAsk(this.path)) return null;
    if (!session.getSnapshot()) return 'Статус LSP ещё не загружен';
    return indicator ? indicator.title : 'Для этого типа файлов нет language server';
  }

  request(view: EditorView, w: Word) {
    return {
      path: this.path,
      line: w.line,
      character: w.character,
      ...(this.sendText ? { text: view.state.doc.toString() } : {}),
    };
  }

  async goToDefinition(view: EditorView, pos: number) {
    const w = wordRange(view.state, pos);
    if (!w) return;
    const reason = this.unavailable();
    if (reason) {
      this.toast(reason, true);
      return;
    }
    view.dom.classList.add('rv-lsp-pending');
    try {
      const res = await this.session!.definition(this.request(view, w));
      if (!res.ok) {
        this.toast(failureText(res), true);
        return;
      }
      const target = res.locations[0];
      if (!target) {
        this.toast(`Определение «${view.state.sliceDoc(w.from, w.to)}» не найдено`);
        return;
      }
      if (target.path === null) {
        this.toast(`Определение вне репозитория: ${target.external ?? 'неизвестно где'}`);
        return;
      }
      if (res.locations.length > 1) this.toast(`Определений: ${res.locations.length} — открыто первое`);
      this.onNavigate(target, view.state.doc.lineAt(w.from).number);
    } catch (e) {
      this.toast(`Не удалось перейти к определению: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      view.dom.classList.remove('rv-lsp-pending');
    }
  }
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The «follow the link» modifier: Cmd on a Mac (where Ctrl+click is the right click), Ctrl elsewhere. */
function linkModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return MAC ? e.metaKey : e.ctrlKey || e.metaKey;
}

/** The editor whose caret F12 acts on: the one clicked last. */
let active: { hub: LspHub; view: EditorView } | null = null;

/** F12 (or whatever it is bound to): definition of the word at the caret of the last clicked file. */
export function definitionAtCaret(): boolean {
  if (!active || !active.view.dom.isConnected) return false;
  const { hub, view } = active;
  const pos = view.state.selection.main.head;
  if (!wordRange(view.state, pos)) return false;
  void hub.goToDefinition(view, pos);
  return true;
}

// ------------------------------------------------------------ Ctrl+hover link

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'rv-lsp-link' });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** With Ctrl/Cmd held, the word under the pointer is underlined like a link. */
function linkPlugin(hub: LspHub) {
  return ViewPlugin.fromClass(
    class {
      current: { from: number; to: number } | null = null;
      last: MouseEvent | null = null;

      constructor(readonly view: EditorView) {
        view.contentDOM.addEventListener('mousemove', this.onMove);
        view.contentDOM.addEventListener('mouseleave', this.clear);
        window.addEventListener('keydown', this.onKey);
        window.addEventListener('keyup', this.onKey);
        window.addEventListener('blur', this.clear);
      }

      onMove = (e: MouseEvent) => {
        this.last = e;
        this.refresh(linkModifier(e));
      };

      onKey = (e: KeyboardEvent) => {
        if (e.key === 'Control' || e.key === 'Meta') this.refresh(e.type === 'keydown' && linkModifier(e));
      };

      clear = () => this.set(null);

      refresh(mod: boolean) {
        const w = mod && this.last && hub.session?.canAsk(hub.path) ? wordAtPointer(this.view, this.last) : null;
        this.set(w && { from: w.from, to: w.to });
      }

      set(range: { from: number; to: number } | null) {
        const same = range === this.current || (range && this.current && range.from === this.current.from && range.to === this.current.to);
        if (same) return;
        this.current = range;
        this.view.dom.classList.toggle('rv-lsp-mod', range !== null);
        this.view.dispatch({ effects: setLink.of(range) });
      }

      destroy() {
        this.view.contentDOM.removeEventListener('mousemove', this.onMove);
        this.view.contentDOM.removeEventListener('mouseleave', this.clear);
        window.removeEventListener('keydown', this.onKey);
        window.removeEventListener('keyup', this.onKey);
        window.removeEventListener('blur', this.clear);
      }
    },
  );
}

// ------------------------------------------------------------------- hover

const HOVER_MS = 350;

function hoverDom(view: EditorView, hub: LspHub, hover: LspHover, word: Word): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'rv-lsp-tip';
  const parser = view.state.facet(language)?.parser;
  for (const block of hoverBlocks(hover)) {
    if (block.type === 'code') {
      const pre = dom.appendChild(document.createElement('pre'));
      pre.className = 'rv-lsp-tip__code';
      if (parser) {
        highlightCode(
          block.text,
          parser.parse(block.text),
          githubHighlightStyle,
          (text, classes) => {
            if (!classes) pre.append(text);
            else {
              const span = pre.appendChild(document.createElement('span'));
              span.className = classes;
              span.textContent = text;
            }
          },
          () => pre.append('\n'),
        );
      } else pre.textContent = block.text;
    } else {
      for (const para of block.text.split(/\n{2,}/)) {
        const p = dom.appendChild(document.createElement('p'));
        p.className = 'rv-lsp-tip__doc';
        for (const part of inlineParts(para)) {
          if (part.code) p.appendChild(document.createElement('code')).textContent = part.text;
          else p.append(part.text);
        }
      }
    }
  }
  const acts = dom.appendChild(document.createElement('div'));
  acts.className = 'rv-lsp-tip__acts';
  const go = acts.appendChild(document.createElement('button'));
  go.type = 'button';
  go.textContent = 'Перейти к определению';
  go.addEventListener('mousedown', (e) => e.preventDefault());
  go.addEventListener('click', () => void hub.goToDefinition(view, word.from));
  const hint = acts.appendChild(document.createElement('span'));
  hint.className = 'rv-lsp-tip__hint';
  hint.textContent = MAC ? '⌘+клик' : 'Ctrl+клик';
  return dom;
}

function hoverSource(hub: LspHub) {
  // One request at a time per editor; answers are kept for the life of the
  // document (it is read-only), so moving back over a word costs nothing.
  let controller: AbortController | null = null;
  const cache = new WeakMap<EditorState['doc'], Map<number, LspHover | null>>();
  return async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    // Ctrl held means «link», and an open menu has the pointer's attention.
    if (view.dom.classList.contains('rv-lsp-mod') || openMenu) return null;
    const w = wordRange(view.state, pos);
    if (!w || !hub.session?.canAsk(hub.path)) return null;
    const doc = view.state.doc;
    let known = cache.get(doc);
    if (!known) cache.set(doc, (known = new Map()));
    let hover = known.get(w.from);
    if (hover === undefined) {
      controller?.abort();
      const mine = (controller = new AbortController());
      try {
        const res = await hub.session.hover(hub.request(view, w), mine.signal);
        // Failures are the indicator's to show; a tooltip saying «error» on
        // every word would be noise. Only answers are kept: a server that
        // was starting or had crashed may answer next time.
        hover = res.ok ? res.hover : null;
        if (res.ok) known.set(w.from, hover);
      } catch {
        return null;
      }
      if (mine.signal.aborted || view.state.doc !== doc) return null;
    }
    if (!hover) return null;
    const value = hover;
    return { pos: w.from, end: w.to, create: () => ({ dom: hoverDom(view, hub, value, w) }) };
  };
}

// ------------------------------------------------------------ context menu


export function closeLspMenu() {
  openMenu?.close();
}

function showMenu(view: EditorView, hub: LspHub, w: Word, x: number, y: number) {
  closeLspMenu();
  const name = view.state.sliceDoc(w.from, w.to);
  const el = document.createElement('div');
  el.className = 'rv-lsp-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', `Действия с «${name}»`);
  const reason = hub.unavailable();

  const item = (label: string, kbd: string, run: () => void, disabled: string | null = null) => {
    const b = el.appendChild(document.createElement('button'));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.className = 'rv-lsp-menu__item';
    b.appendChild(document.createElement('span')).textContent = label;
    if (kbd) b.appendChild(document.createElement('kbd')).textContent = kbd;
    if (disabled) {
      b.disabled = true;
      b.title = disabled;
    }
    b.addEventListener('click', () => {
      close();
      run();
    });
    return b;
  };

  item('Перейти к определению', displayBinding(hub.definitionKey), () => void hub.goToDefinition(view, w.from), reason);
  el.appendChild(document.createElement('hr'));
  item('Подсветить совпадения', '', () => view.dispatch({ selection: { anchor: w.from, head: w.to } }));
  item('Копировать имя', '', () => {
    void navigator.clipboard?.writeText(name).then(
      () => hub.toast(`Скопировано: ${name}`),
      () => hub.toast('Буфер обмена недоступен', true),
    );
  });
  if (reason) {
    const note = el.appendChild(document.createElement('div'));
    note.className = 'rv-lsp-menu__note';
    note.textContent = reason;
  }

  // Inside the app's root: Primer's colour variables are defined there, not on <body>.
  (document.querySelector('.rv-root') ?? document.body).appendChild(el);
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
  const items = () => [...el.querySelectorAll<HTMLButtonElement>('.rv-lsp-menu__item:not(:disabled)')];
  items()[0]?.focus();

  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next]?.focus();
  };
  // A scroll still on its way when the menu opened (the page settling) must
  // not take it down; one the reviewer makes does.
  const openedAt = performance.now();
  const onScroll = () => {
    if (performance.now() - openedAt > 150) close();
  };
  const close = () => {
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    el.remove();
    if (openMenu?.el === el) openMenu = null;
  };
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  openMenu = { el, close };
}

// --------------------------------------------------------------- extension

function handlers(hub: LspHub) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      active = { hub, view };
      if (e.button !== 0 || !linkModifier(e)) return false;
      const w = wordAtPointer(view, e);
      if (!w) return false;
      // Not a multi-cursor click, not a text selection: a link.
      e.preventDefault();
      view.dispatch({ selection: { anchor: w.from }, effects: closeHoverTooltips });
      void hub.goToDefinition(view, w.from);
      return true;
    },
    contextmenu(e, view) {
      if (e.shiftKey) return false; // Shift+right click: the browser's own menu, always
      const w = wordAtPointer(view, e);
      if (!w) return false;
      e.preventDefault();
      active = { hub, view };
      view.dispatch({ selection: { anchor: w.from }, effects: closeHoverTooltips });
      showMenu(view, hub, w, e.clientX, e.clientY);
      return true;
    },
  });
}

/** Hover, Ctrl+click and the context menu for one file's editor. */
export function lspNavigation(hub: LspHub): Extension {
  return [linkField, linkPlugin(hub), handlers(hub), hoverTooltip(hoverSource(hub), { hoverTime: HOVER_MS })];
}

/** Keys that must not fire while a menu, a dialog or a text field has them. */
export function navKeysBlocked(e: KeyboardEvent): boolean {
  return e.defaultPrevented || isTypingTarget(e.target) || portalOpen() || openMenu !== null;
}
